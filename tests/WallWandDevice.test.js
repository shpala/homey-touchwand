'use strict';

jest.mock('homey-zwavedriver', () => ({
  ZwaveDevice: class MockZwaveDevice {
    constructor() {
      this._capabilities = new Set();
      this._capabilityValues = {};
      this._capabilityOptions = {};
      this._store = {};
      this._settings = {};
      this._triggerCards = new Map();
      this.driver = { manifest: { capabilities: [], capabilitiesOptions: {}, settings: [] } };
      this.homey = {
        flow: {
          getDeviceTriggerCard: id => {
            if (!this._triggerCards.has(id)) {
              this._triggerCards.set(id, {
                registerArgumentAutocompleteListener: jest.fn(),
                trigger: jest.fn().mockResolvedValue(undefined),
              });
            }
            return this._triggerCards.get(id);
          },
        },
        // Delegate to the globals so jest fake timers keep working
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: id => clearTimeout(id),
        setInterval: (fn, ms) => setInterval(fn, ms),
        clearInterval: id => clearInterval(id),
      };
    }

    async onInit() {}
    async onNodeInit() {}
    async onSettings() {}
    async onDeleted() {}
    log() {}
    error() {}
    printNode() {}
    getName() {
      return 'Test WallWand';
    }

    getStoreValue(key) {
      return this._store[key];
    }

    async setStoreValue(key, value) {
      this._store[key] = value;
    }

    getSettings() {
      return this._settings;
    }

    async setSettings(settings) {
      Object.assign(this._settings, settings);
    }

    getCapabilities() {
      return [...this._capabilities];
    }

    hasCapability(cap) {
      return this._capabilities.has(cap);
    }

    async addCapability(cap) {
      this._capabilities.add(cap);
    }

    async removeCapability(cap) {
      this._capabilities.delete(cap);
    }

    getCapabilityValue(cap) {
      return this._capabilityValues[cap] ?? null;
    }

    async setCapabilityValue(cap, value) {
      this._capabilityValues[cap] = value;
    }

    async setCapabilityOptions(cap, options) {
      this._capabilityOptions[cap] = options;
    }

    registerCapability() {}
    async triggerCapabilityListener() {}
  },
}));

const WallWandDevice = require('../drivers/wallwand/device');

const { DEVICE_TYPES } = WallWandDevice;

function makeCommandClassMock(extra = {}) {
  return {
    on: jest.fn(),
    removeListener: jest.fn(),
    ...extra,
  };
}

function makeBinaryEndpoint(reportValue) {
  return {
    deviceClassGeneric: 'GENERIC_TYPE_SWITCH_BINARY',
    CommandClass: {
      COMMAND_CLASS_BASIC: makeCommandClassMock(),
      COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock({
        SWITCH_BINARY_GET: jest.fn().mockResolvedValue({ 'Current Value': reportValue }),
      }),
    },
  };
}

function makeMultilevelEndpoint(reportValue) {
  return {
    deviceClassGeneric: 'GENERIC_TYPE_SWITCH_MULTILEVEL',
    CommandClass: {
      COMMAND_CLASS_BASIC: makeCommandClassMock(),
      COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock({
        SWITCH_MULTILEVEL_GET: jest.fn().mockResolvedValue({ 'Current Value': reportValue }),
      }),
    },
  };
}

function makeNode(endpoints = {}) {
  return {
    MultiChannelNodes: endpoints,
    CommandClass: {
      COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock(),
      COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock(),
    },
  };
}

// Shape verified on real hardware: numeric device classes plus a raw CC id buffer
function makeLiveCapabilityReport(endpointNum, genericClass, commandClassIds) {
  return {
    Properties1: { 'End Point': endpointNum, Dynamic: false },
    'Generic Device Class': genericClass,
    'Specific Device Class': 1,
    'Command Class (Raw)': Buffer.from(commandClassIds),
  };
}

function addMultiChannelCommandClass(node, reportsByEndpoint = {}) {
  node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
    MULTI_CHANNEL_CAPABILITY_GET: jest.fn(async args => {
      const endpointNum = Buffer.isBuffer(args?.Properties1)
        ? args.Properties1[0]
        : args?.Properties1?.['End Point'];
      const report = reportsByEndpoint[endpointNum];
      if (report instanceof Error) throw report;
      if (!report) throw new Error('timeout after 10000ms');
      return report;
    }),
  });
  return node;
}

describe('WallWandDevice', () => {
  let device;

  beforeEach(async () => {
    device = new WallWandDevice();
    await device.onInit();
  });

  afterEach(async () => {
    await device.onDeleted();
  });

  describe('shared flow card registration', () => {
    test('onInit does not register autocomplete listeners on shared trigger cards', () => {
      // Trigger cards are singletons shared by all devices; registering a
      // device-bound autocomplete listener here would let the last paired
      // panel hijack autocomplete for every other panel. That registration
      // belongs in app.js where args.device resolves per invocation.
      for (const card of device._triggerCards.values()) {
        expect(card.registerArgumentAutocompleteListener).not.toHaveBeenCalled();
      }
    });
  });

  describe('flow handlers before node init', () => {
    test('endpoint_is_on condition returns false instead of throwing', async () => {
      await expect(device._handleEndpointIsOn({ endpoint: { id: 1 } })).resolves.toBe(false);
    });

    test('endpoint_dim_compare condition returns false instead of throwing', async () => {
      await expect(
        device._handleEndpointDimCompare({
          endpoint: { id: 1 },
          comparison: 'greater_than',
          level: 0.5,
        })
      ).resolves.toBe(false);
    });

    test('autocomplete returns an empty list', async () => {
      await expect(device._getEndpointAutocompleteList('')).resolves.toEqual([]);
    });
  });

  describe('health check', () => {
    test('rediscovers endpoints when endpoint types are lost', async () => {
      device._endpointTypes = {};
      await device.addCapability('onoff.ep1');
      device.node = makeNode({ 1: makeBinaryEndpoint(255) });
      const discoverSpy = jest.spyOn(device, '_discoverAllEndpoints').mockResolvedValue();

      await device._checkDeviceHealth();

      expect(discoverSpy).toHaveBeenCalled();
    });

    test('rediscovers endpoints when a known endpoint lost its capabilities', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      device.node = makeNode({ 1: makeBinaryEndpoint(255) });
      const discoverSpy = jest.spyOn(device, '_discoverAllEndpoints').mockResolvedValue();

      await device._checkDeviceHealth();

      expect(discoverSpy).toHaveBeenCalled();
    });

    test('does nothing when endpoint state is consistent', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep1');
      device.node = makeNode({ 1: makeBinaryEndpoint(255) });
      const discoverSpy = jest.spyOn(device, '_discoverAllEndpoints').mockResolvedValue();

      await device._checkDeviceHealth();

      expect(discoverSpy).not.toHaveBeenCalled();
    });

    test('rediscovery persists endpoints verified along the way', async () => {
      // Type known but capabilities missing, so the rediscovery path runs and
      // the probe verifies EP1 through the already-known branch
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      addMultiChannelCommandClass(node, { 1: makeLiveCapabilityReport(1, 16, [0x25]) });
      device.node = node;

      await device._checkDeviceHealth();

      expect(device._endpointTypesVerified[1]).toBe(true);
      expect(device._store.endpointTypesVerified[1]).toBe(true);
    });
  });

  describe('sync failure handling', () => {
    function makeFailingEndpoint() {
      return {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_BINARY',
        CommandClass: {
          COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock({
            SWITCH_BINARY_GET: jest.fn().mockRejectedValue(new Error('unexpected zwave error')),
          }),
        },
      };
    }

    test('keeps capabilities on a single non-transient sync failure', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep1');

      await device._syncOneEndpointState(1, makeFailingEndpoint());

      expect(device.hasCapability('onoff.ep1')).toBe(true);
      expect(device._endpointTypes[1]).toBe(DEVICE_TYPES.SWITCH);
    });

    test('removes capabilities only after repeated consecutive failures', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep1');
      const endpoint = makeFailingEndpoint();

      for (let i = 0; i < WallWandDevice.MAX_SYNC_FAILURES; i++) {
        await device._syncOneEndpointState(1, endpoint);
      }

      expect(device.hasCapability('onoff.ep1')).toBe(false);
      expect(device._endpointTypes[1]).toBeNull();
    });

    test('a successful sync resets the failure count', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep1');

      const failing = makeFailingEndpoint();
      const working = makeBinaryEndpoint(255);

      await device._syncOneEndpointState(1, failing);
      await device._syncOneEndpointState(1, failing);
      await device._syncOneEndpointState(1, working);
      await device._syncOneEndpointState(1, failing);
      await device._syncOneEndpointState(1, failing);

      expect(device.hasCapability('onoff.ep1')).toBe(true);
      expect(device._endpointTypes[1]).toBe(DEVICE_TYPES.SWITCH);
    });

    test('dropping an endpoint clears its verified flag so rediscovery probes again', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      device._endpointTypesVerified = { 1: true };
      await device.addCapability('onoff.ep1');
      const endpoint = makeFailingEndpoint();

      for (let i = 0; i < WallWandDevice.MAX_SYNC_FAILURES; i++) {
        await device._syncOneEndpointState(1, endpoint);
      }

      expect(device._endpointTypes[1]).toBeNull();
      expect(device._endpointTypesVerified[1]).toBeUndefined();
      expect(device._store.endpointTypesVerified?.[1]).toBeUndefined();
    });

    test('transient errors never remove capabilities', async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep1');
      const endpoint = {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_BINARY',
        CommandClass: {
          COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock({
            SWITCH_BINARY_GET: jest.fn().mockRejectedValue(new Error('timeout after 10000ms')),
          }),
        },
      };

      for (let i = 0; i < WallWandDevice.MAX_SYNC_FAILURES + 1; i++) {
        await device._syncOneEndpointState(1, endpoint);
      }

      expect(device.hasCapability('onoff.ep1')).toBe(true);
    });
  });

  describe('initial sync trigger suppression', () => {
    test('state caught up during onNodeInit does not fire flow triggers', async () => {
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      device.node = node;

      await device.onNodeInit({ node });

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      const turnedOn = device.homey.flow.getDeviceTriggerCard('endpoint_turned_on');
      expect(turnedOn.trigger).not.toHaveBeenCalled();
    });

    test('state changes after onNodeInit fire flow triggers', async () => {
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      device.node = node;
      await device.onNodeInit({ node });

      await device._setOnOff('onoff.ep1', false, 1);

      const turnedOff = device.homey.flow.getDeviceTriggerCard('endpoint_turned_off');
      expect(turnedOff.trigger).toHaveBeenCalled();
    });
  });

  describe('endpoint labels', () => {
    test('flow token labels are sanitized the same way as capability titles', () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      device._settings.label_ep1 = `  <b>${'x'.repeat(60)}</b>  `;

      const label = device._getEndpointLabel(1);

      expect(label).not.toMatch(/[<>]/);
      expect(label.length).toBeLessThanOrEqual(50);
    });

    test('empty custom label falls back to the default', () => {
      device._endpointTypes = { 1: DEVICE_TYPES.SWITCH };
      device._settings.label_ep1 = '   ';

      expect(device._getEndpointLabel(1)).toBe('Switch 1');
    });
  });

  describe('queued toggle', () => {
    test('reads current state at execution time, not enqueue time', async () => {
      await device.addCapability('onoff.ep1');
      await device.setCapabilityValue('onoff.ep1', false);
      jest
        .spyOn(device, 'triggerCapabilityListener')
        .mockImplementation(async (cap, value) => device.setCapabilityValue(cap, value));

      // Two rapid toggles must land on opposite values, not both on true
      await Promise.all([
        device.queueToggleCommand('onoff.ep1'),
        device.queueToggleCommand('onoff.ep1'),
      ]);

      expect(device.triggerCapabilityListener).toHaveBeenNthCalledWith(1, 'onoff.ep1', true);
      expect(device.triggerCapabilityListener).toHaveBeenNthCalledWith(2, 'onoff.ep1', false);
      expect(device.getCapabilityValue('onoff.ep1')).toBe(false);
    });
  });

  describe('capability registration', () => {
    test('registers capabilities without firing a startup GET', async () => {
      // The initial state read is owned by _syncAllEndpointStates; letting
      // registerCapability also GET on start doubles the Z-Wave traffic.
      const regSpy = jest.spyOn(device, 'registerCapability');
      const node = makeNode({ 1: makeBinaryEndpoint(255), 2: makeMultilevelEndpoint(50) });
      device.node = node;

      await device.onNodeInit({ node });

      expect(regSpy).toHaveBeenCalled();
      for (const call of regSpy.mock.calls) {
        expect(call[2]).toMatchObject({ getOpts: { getOnStart: false } });
      }
    });
  });

  describe('managed timers', () => {
    test('health check interval goes through this.homey', () => {
      const intervalSpy = jest.spyOn(device.homey, 'setInterval');

      device._startHealthCheck();

      expect(intervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        WallWandDevice.HEALTH_CHECK_INTERVAL_MS
      );
    });

    test('root report debounce timer goes through this.homey', async () => {
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      device.node = node;
      await device.onNodeInit({ node });
      const timeoutSpy = jest.spyOn(device.homey, 'setTimeout');
      jest.spyOn(device, '_syncEndpointsByType').mockResolvedValue();

      const listener = node.CommandClass.COMMAND_CLASS_SWITCH_BINARY.on.mock.calls[0][1];
      await listener();

      expect(timeoutSpy).toHaveBeenCalledWith(
        expect.any(Function),
        WallWandDevice.SYNC_DEBOUNCE_MS
      );
    });
  });

  describe('endpoint BASIC_SET reports', () => {
    let node;

    function getBasicListener(endpointNum) {
      const cc = node.MultiChannelNodes[endpointNum].CommandClass.COMMAND_CLASS_BASIC;
      expect(cc.on).toHaveBeenCalledWith('report', expect.any(Function));
      return cc.on.mock.calls[0][1];
    }

    beforeEach(async () => {
      node = makeNode({
        1: makeMultilevelEndpoint(50),
        2: makeBinaryEndpoint(0),
      });
      device.node = node;
      await device.onNodeInit({ node });
    });

    test('BASIC_SET 255 on a switch endpoint turns it on and fires triggers', async () => {
      const listener = getBasicListener(2);

      await listener({ name: 'BASIC_SET' }, { Value: 255 });

      expect(device.getCapabilityValue('onoff.ep2')).toBe(true);
      const turnedOn = device.homey.flow.getDeviceTriggerCard('endpoint_turned_on');
      expect(turnedOn.trigger).toHaveBeenCalled();
    });

    test('BASIC_SET 0 on a switch endpoint turns it off', async () => {
      await device.setCapabilityValue('onoff.ep2', true);
      const listener = getBasicListener(2);

      await listener({ name: 'BASIC_SET' }, { Value: 0 });

      expect(device.getCapabilityValue('onoff.ep2')).toBe(false);
      const turnedOff = device.homey.flow.getDeviceTriggerCard('endpoint_turned_off');
      expect(turnedOff.trigger).toHaveBeenCalled();
    });

    test('BASIC_SET with a level on a dimmer endpoint sets onoff and dim', async () => {
      const listener = getBasicListener(1);

      await listener({ name: 'BASIC_SET' }, { Value: 75 });

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBeCloseTo(75 / 99);
    });

    test('BASIC_SET 255 on a dimmer endpoint turns it on and re-reads the level', async () => {
      node.MultiChannelNodes[1].CommandClass.COMMAND_CLASS_SWITCH_MULTILEVEL.SWITCH_MULTILEVEL_GET =
        jest.fn().mockResolvedValue({ 'Current Value': 80 });
      const listener = getBasicListener(1);

      await listener({ name: 'BASIC_SET' }, { Value: 255 });

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBeCloseTo(80 / 99);
    });

    test('non-SET basic reports and invalid values are ignored', async () => {
      await device.setCapabilityValue('onoff.ep2', true);
      const listener = getBasicListener(2);

      await listener({ name: 'BASIC_REPORT' }, { Value: 0 });
      await listener({ name: 'BASIC_SET' }, {});
      await listener({ name: 'BASIC_SET' }, null);

      expect(device.getCapabilityValue('onoff.ep2')).toBe(true);
    });
  });

  describe('root report debounce', () => {
    let node;

    beforeEach(async () => {
      node = makeNode({
        1: makeBinaryEndpoint(255),
        2: makeMultilevelEndpoint(50),
      });
      device.node = node;
      await device.onNodeInit({ node });
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function getRootListener(commandClassId) {
      const cc = node.CommandClass[commandClassId];
      expect(cc.on).toHaveBeenCalledWith('report', expect.any(Function));
      return cc.on.mock.calls[0][1];
    }

    test('does not sync before the debounce window elapses', async () => {
      const syncSpy = jest.spyOn(device, '_syncEndpointsByType').mockResolvedValue();
      const listener = getRootListener('COMMAND_CLASS_SWITCH_BINARY');

      await listener();
      await jest.advanceTimersByTimeAsync(WallWandDevice.SYNC_DEBOUNCE_MS - 1);

      expect(syncSpy).not.toHaveBeenCalled();
    });

    test('syncs only endpoints of the reported type after the debounce window', async () => {
      const syncSpy = jest.spyOn(device, '_syncEndpointsByType').mockResolvedValue();
      const listener = getRootListener('COMMAND_CLASS_SWITCH_BINARY');

      await listener();
      await jest.advanceTimersByTimeAsync(WallWandDevice.SYNC_DEBOUNCE_MS);

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith(DEVICE_TYPES.SWITCH);
    });

    test('a repeated root report within the window restarts the debounce', async () => {
      const syncSpy = jest.spyOn(device, '_syncEndpointsByType').mockResolvedValue();
      const listener = getRootListener('COMMAND_CLASS_SWITCH_MULTILEVEL');

      await listener();
      await jest.advanceTimersByTimeAsync(WallWandDevice.SYNC_DEBOUNCE_MS - 50);
      await listener();
      await jest.advanceTimersByTimeAsync(WallWandDevice.SYNC_DEBOUNCE_MS - 50);

      expect(syncSpy).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(50);

      expect(syncSpy).toHaveBeenCalledTimes(1);
      expect(syncSpy).toHaveBeenCalledWith(DEVICE_TYPES.DIMMER);
    });

    test('debounced sync polls the endpoint and updates capability values', async () => {
      node.MultiChannelNodes[1].CommandClass.COMMAND_CLASS_SWITCH_BINARY.SWITCH_BINARY_GET = jest
        .fn()
        .mockResolvedValue({ 'Current Value': 'off/disable' });
      const listener = getRootListener('COMMAND_CLASS_SWITCH_BINARY');

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);

      await listener();
      await jest.advanceTimersByTimeAsync(WallWandDevice.SYNC_DEBOUNCE_MS);

      expect(device.getCapabilityValue('onoff.ep1')).toBe(false);
      expect(device.getCapabilityValue('dim.ep2')).toBe(50 / 99);
    });
  });

  describe('endpoint type detection', () => {
    test('detects dimmer endpoints', () => {
      const ep = makeMultilevelEndpoint(50);
      expect(device._detectEndpointType(ep, ep.CommandClass)).toBe(DEVICE_TYPES.DIMMER);
    });

    test('detects switch endpoints', () => {
      const ep = makeBinaryEndpoint(255);
      expect(device._detectEndpointType(ep, ep.CommandClass)).toBe(DEVICE_TYPES.SWITCH);
    });

    test('returns null for unsupported endpoint types', () => {
      const ep = { deviceClassGeneric: 'GENERIC_TYPE_SENSOR_BINARY', CommandClass: {} };
      expect(device._detectEndpointType(ep, ep.CommandClass)).toBeNull();
    });

    test('returns null when device class and command class disagree', () => {
      const ep = {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_MULTILEVEL',
        CommandClass: { COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock() },
      };
      expect(device._detectEndpointType(ep, ep.CommandClass)).toBeNull();
    });
  });

  describe('report validation', () => {
    test('accepts reports with the required field', () => {
      expect(device._isValidReport({ 'Current Value': 0 }, 'Current Value')).toBe(true);
    });

    test('rejects reports missing the required field or with null value', () => {
      expect(device._isValidReport({}, 'Current Value')).toBe(false);
      expect(device._isValidReport({ 'Current Value': null }, 'Current Value')).toBe(false);
      expect(device._isValidReport(null, 'Current Value')).toBe(false);
    });
  });

  describe('live endpoint verification', () => {
    test('maps a live binary switch report to the switch type', async () => {
      const node = makeNode({});
      addMultiChannelCommandClass(node, { 1: makeLiveCapabilityReport(1, 16, [0x25, 0x85]) });
      device.node = node;

      await expect(device._verifyEndpointLive(1)).resolves.toBe(DEVICE_TYPES.SWITCH);
    });

    test('maps a live multilevel report to the dimmer type', async () => {
      const node = makeNode({});
      addMultiChannelCommandClass(node, { 1: makeLiveCapabilityReport(1, 17, [0x26, 0x85]) });
      device.node = node;

      await expect(device._verifyEndpointLive(1)).resolves.toBe(DEVICE_TYPES.DIMMER);
    });

    test('returns null for a wall controller endpoint', async () => {
      const node = makeNode({});
      addMultiChannelCommandClass(node, { 5: makeLiveCapabilityReport(5, 24, [0x5b]) });
      device.node = node;

      await expect(device._verifyEndpointLive(5)).resolves.toBeNull();
    });

    test('returns null when the live class and live CC list disagree', async () => {
      const node = makeNode({});
      addMultiChannelCommandClass(node, { 1: makeLiveCapabilityReport(1, 16, [0x26]) });
      device.node = node;

      await expect(device._verifyEndpointLive(1)).resolves.toBeNull();
    });

    test('returns undefined when the probe times out', async () => {
      const node = makeNode({});
      addMultiChannelCommandClass(node, {});
      device.node = node;

      await expect(device._verifyEndpointLive(1)).resolves.toBeUndefined();
    });

    test('returns undefined when the root node lacks the multi channel command class', async () => {
      device.node = makeNode({});

      await expect(device._verifyEndpointLive(1)).resolves.toBeUndefined();
    });

    test('onNodeInit resets live classes remembered from a previous session', async () => {
      device._liveGenericClasses = { 3: 17 };
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      device.node = node;

      await device.onNodeInit({ node });

      expect(device._liveGenericClasses).toEqual({});
    });

    test('retries with the raw byte form when the encoder rejects the object form', async () => {
      const node = makeNode({});
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest
          .fn()
          .mockRejectedValueOnce(new Error('invalid payload'))
          .mockResolvedValue(makeLiveCapabilityReport(1, 16, [0x25])),
      });
      device.node = node;

      await expect(device._verifyEndpointLive(1)).resolves.toBe(DEVICE_TYPES.SWITCH);

      const { calls } =
        node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL.MULTI_CHANNEL_CAPABILITY_GET.mock;
      expect(Buffer.isBuffer(calls[1][0].Properties1)).toBe(true);
    });
  });

  describe('live re-typing of mistyped endpoints', () => {
    // Entrance EP2: the cached interview says multilevel (factory layout), the
    // live panel is a binary switch; its cached CC list lacks SWITCH_BINARY and
    // the multilevel GET times out forever
    function makeStaleMultilevelEndpoint() {
      return {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_MULTILEVEL',
        CommandClass: {
          COMMAND_CLASS_BASIC: makeCommandClassMock(),
          COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock({
            SWITCH_MULTILEVEL_GET: jest.fn().mockRejectedValue(new Error('timeout after 10000ms')),
          }),
        },
      };
    }

    test('re-types a stored dimmer to switch when the live panel reports a binary switch', async () => {
      const node = makeNode({ 2: makeStaleMultilevelEndpoint() });
      addMultiChannelCommandClass(node, { 2: makeLiveCapabilityReport(2, 16, [0x25, 0x85]) });
      device.node = node;
      device._store.endpointTypes = { 2: DEVICE_TYPES.DIMMER };
      await device.addCapability('onoff.ep2');
      await device.addCapability('dim.ep2');
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device.onNodeInit({ node });

      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);
      expect(device.hasCapability('dim.ep2')).toBe(false);
      expect(device.hasCapability('onoff.ep2')).toBe(true);
      expect(device._store.endpointTypesVerified[2]).toBe(true);
      // The stale cache has no SWITCH_BINARY on this endpoint, so onoff must
      // be wired through BASIC (present on every endpoint)
      expect(regSpy).toHaveBeenCalledWith(
        'onoff.ep2',
        'BASIC',
        expect.objectContaining({ multiChannelNodeId: 2, getOpts: { getOnStart: false } })
      );
    });

    test('a later full rediscovery keeps the verified type instead of the stale cache', async () => {
      const node = makeNode({ 2: makeStaleMultilevelEndpoint() });
      addMultiChannelCommandClass(node, { 2: makeLiveCapabilityReport(2, 16, [0x25, 0x85]) });
      device.node = node;
      device._store.endpointTypes = { 2: DEVICE_TYPES.DIMMER };

      await device.onNodeInit({ node });

      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);

      const probe = node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL.MULTI_CHANNEL_CAPABILITY_GET;
      probe.mockClear();

      // A health-check rediscovery walks the stale interview cache again; the
      // verified type must win without another live probe
      await device._discoverAllEndpoints(node);

      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);
      expect(device.hasCapability('dim.ep2')).toBe(false);
      expect(device.hasCapability('onoff.ep2')).toBe(true);
      expect(probe).not.toHaveBeenCalled();
    });

    test('a non-transient registration failure forgets the verification so a later init re-probes', async () => {
      const node = makeNode({ 2: makeStaleMultilevelEndpoint() });
      addMultiChannelCommandClass(node, { 2: makeLiveCapabilityReport(2, 16, [0x25, 0x85]) });
      device.node = node;
      device._store.endpointTypes = { 2: DEVICE_TYPES.DIMMER };
      const regSpy = jest.spyOn(device, 'registerCapability').mockImplementation(() => {
        throw new Error('unknown_capability');
      });

      await device.onNodeInit({ node });

      // The probe succeeded but registration did not; persisting verified=true
      // next to endpointTypes=null would pin the endpoint to null forever
      expect(device._store.endpointTypesVerified?.[2]).toBeUndefined();

      // Once registration works again, the next init must probe and recover
      regSpy.mockRestore();
      await device.onNodeInit({ node });

      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);
      expect(device.hasCapability('onoff.ep2')).toBe(true);
      expect(device._store.endpointTypesVerified[2]).toBe(true);
    });

    test('cleaning up all endpoints resets the verified flags', async () => {
      device._endpointTypesVerified = { 2: true };

      await device._cleanupAllEndpoints();

      expect(device._endpointTypesVerified).toEqual({});
      expect(device._store.endpointTypesVerified).toEqual({});
    });

    test('keeps the cached type after a probe timeout and retries from the health check', async () => {
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest
          .fn()
          .mockRejectedValueOnce(new Error('timeout after 10000ms'))
          .mockResolvedValue(makeLiveCapabilityReport(1, 16, [0x25])),
      });
      device.node = node;

      await device.onNodeInit({ node });

      expect(device._endpointTypes[1]).toBe(DEVICE_TYPES.SWITCH);
      expect(device._endpointTypesVerified[1]).toBeUndefined();

      await device._checkDeviceHealth();

      expect(device._endpointTypesVerified[1]).toBe(true);
      expect(device._store.endpointTypesVerified[1]).toBe(true);
      expect(device._endpointTypes[1]).toBe(DEVICE_TYPES.SWITCH);
    });
  });

  describe('duplicate-report desync protection', () => {
    // Hardware: the panel retransmits every report in bursts (up to 7 copies seen),
    // and a stale duplicate of one endpoint's report can resolve the next GET
    test('retries when the probe is answered by another endpoint duplicate', async () => {
      const node = makeNode({});
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest
          .fn()
          .mockResolvedValueOnce(makeLiveCapabilityReport(1, 17, [0x26]))
          .mockResolvedValue(makeLiveCapabilityReport(2, 16, [0x25])),
      });
      device.node = node;

      await expect(device._verifyEndpointLive(2)).resolves.toBe(DEVICE_TYPES.SWITCH);
      expect(
        node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL.MULTI_CHANNEL_CAPABILITY_GET
      ).toHaveBeenCalledTimes(2);
    });

    test('gives up after repeated mismatches and keeps the cached type', async () => {
      const node = makeNode({});
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest
          .fn()
          .mockResolvedValue(makeLiveCapabilityReport(1, 17, [0x26])),
      });
      device.node = node;

      await expect(device._verifyEndpointLive(2)).resolves.toBeUndefined();
      expect(
        node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL.MULTI_CHANNEL_CAPABILITY_GET
      ).toHaveBeenCalledTimes(WallWandDevice.VERIFY_PROBE_ATTEMPTS);
      expect(device._liveGenericClasses[2]).toBeUndefined();
    });

    test('accepts a report that carries no endpoint field', async () => {
      const node = makeNode({});
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest.fn().mockResolvedValue({
          'Generic Device Class': 16,
          'Command Class (Raw)': Buffer.from([0x25]),
        }),
      });
      device.node = node;

      await expect(device._verifyEndpointLive(2)).resolves.toBe(DEVICE_TYPES.SWITCH);
    });

    test('reads the endpoint from the raw Properties1 byte when the parsed field is missing', async () => {
      const node = makeNode({});
      node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL = makeCommandClassMock({
        MULTI_CHANNEL_CAPABILITY_GET: jest
          .fn()
          .mockResolvedValueOnce({
            // EP1 with the dynamic bit set; bits 0-6 carry the endpoint
            'Properties1 (Raw)': Buffer.from([0x81]),
            'Generic Device Class': 17,
            'Command Class (Raw)': Buffer.from([0x26]),
          })
          .mockResolvedValue({
            'Properties1 (Raw)': Buffer.from([0x02]),
            'Generic Device Class': 16,
            'Command Class (Raw)': Buffer.from([0x25]),
          }),
      });
      device.node = node;

      await expect(device._verifyEndpointLive(2)).resolves.toBe(DEVICE_TYPES.SWITCH);
    });

    test('a verify generation bump re-probes endpoints verified by older logic', async () => {
      const node = makeNode({ 2: makeBinaryEndpoint(0) });
      addMultiChannelCommandClass(node, { 2: makeLiveCapabilityReport(2, 16, [0x25]) });
      device.node = node;
      // Poisoned store from the buggy generation: verified, but mistyped
      device._store.endpointTypes = { 2: DEVICE_TYPES.DIMMER };
      device._store.endpointTypesVerified = { 2: true };
      device._store.endpointVerifyGeneration = WallWandDevice.VERIFY_GENERATION - 1;

      await device.onNodeInit({ node });

      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);
      expect(device._store.endpointVerifyGeneration).toBe(WallWandDevice.VERIFY_GENERATION);
      expect(device._store.endpointTypesVerified[2]).toBe(true);
      expect(device.hasCapability('dim.ep2')).toBe(false);
      expect(device.hasCapability('onoff.ep2')).toBe(true);
    });

    test('a verify generation bump also reruns the blind state reset', async () => {
      const node = makeNode({ 1: makeMultilevelEndpoint(0) });
      addMultiChannelCommandClass(node, { 1: makeLiveCapabilityReport(1, 17, [0x26]) });
      device.node = node;
      device._store.endpointTypes = { 1: DEVICE_TYPES.DIMMER };
      device._store.blindStateResetDone = true;
      // Fabricated state leaked in under the old generation
      device._capabilityValues['onoff.ep1'] = false;
      device._capabilityValues['dim.ep1'] = 0;
      device._store.endpointVerifyGeneration = WallWandDevice.VERIFY_GENERATION - 1;

      await device.onNodeInit({ node });

      expect(device.getCapabilityValue('onoff.ep1')).toBeNull();
      expect(device.getCapabilityValue('dim.ep1')).toBeNull();
      expect(device._store.blindStateResetDone).toBe(true);
    });

    test('the current verify generation keeps stored verifications', async () => {
      const node = makeNode({ 2: makeBinaryEndpoint(0) });
      addMultiChannelCommandClass(node, { 2: makeLiveCapabilityReport(2, 16, [0x25]) });
      device.node = node;
      device._store.endpointTypes = { 2: DEVICE_TYPES.SWITCH };
      device._store.endpointTypesVerified = { 2: true };
      device._store.endpointVerifyGeneration = WallWandDevice.VERIFY_GENERATION;

      await device.onNodeInit({ node });

      const probe = node.CommandClass.COMMAND_CLASS_MULTI_CHANNEL.MULTI_CHANNEL_CAPABILITY_GET;
      expect(probe).not.toHaveBeenCalled();
      expect(device._endpointTypes[2]).toBe(DEVICE_TYPES.SWITCH);
    });
  });

  describe('blind report parsers', () => {
    // The library writes parsed reports straight into capabilities; for blinds the
    // panel's 0-reports carry no position, so the parsers must reject them
    test('ignore the meaningless 0 and 255 reports', () => {
      expect(device._blindOnoffReportParser({ 'Current Value': 0 })).toBeNull();
      expect(device._blindOnoffReportParser({ 'Current Value': 'off/disable' })).toBeNull();
      expect(device._blindDimReportParser({ 'Current Value': 0 })).toBeNull();
      expect(device._blindDimReportParser({ 'Current Value': 'off/disable' })).toBeNull();
      expect(device._blindDimReportParser({ 'Current Value': 255 })).toBeNull();
      expect(device._blindDimReportParser({ 'Current Value': 'on/enable' })).toBeNull();
      expect(device._blindDimReportParser({})).toBeNull();
    });

    test('pass real 1-99 levels through', () => {
      expect(device._blindOnoffReportParser({ 'Current Value': 50 })).toBe(true);
      expect(device._blindOnoffReportParser({ 'Current Value': 255 })).toBe(true);
      expect(device._blindOnoffReportParser({ 'Current Value': 'on/enable' })).toBe(true);
      expect(device._blindDimReportParser({ 'Current Value': 50 })).toBeCloseTo(50 / 99);
      expect(device._blindDimReportParser({ 'Current Value': 99 })).toBe(1);
    });

    test('dimmer registration overrides the library report parser', async () => {
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device._registerEndpointCapabilities(1, DEVICE_TYPES.DIMMER, {
        COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock(),
      });

      for (const cap of ['onoff.ep1', 'dim.ep1']) {
        const call = regSpy.mock.calls.find(c => c[0] === cap);
        expect(call).toBeDefined();
        expect(typeof call[2].reportParser).toBe('function');
        // Without the explicit override flag the library's version-specific
        // parsers (reportParserV4) still win and write the 0-reports
        expect(call[2].reportParserOverride).toBe(true);
      }
    });

    test('the BASIC fallback registration also overrides the report parser', async () => {
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device._registerEndpointCapabilities(1, DEVICE_TYPES.DIMMER, {
        COMMAND_CLASS_BASIC: makeCommandClassMock(),
      });

      const call = regSpy.mock.calls.find(c => c[0] === 'dim.ep1' && c[1] === 'BASIC');
      expect(call).toBeDefined();
      expect(typeof call[2].reportParser).toBe('function');
      expect(call[2].reportParserOverride).toBe(true);
    });

    test('switch registration keeps the library report parser', async () => {
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device._registerEndpointCapabilities(3, DEVICE_TYPES.SWITCH, {
        COMMAND_CLASS_SWITCH_BINARY: makeCommandClassMock(),
      });

      const call = regSpy.mock.calls.find(c => c[0] === 'onoff.ep3');
      expect(call).toBeDefined();
      expect(call[2].reportParser).toBeUndefined();
    });
  });

  describe('capability registration fallbacks', () => {
    test('registers dimmer capabilities against BASIC when the cache lacks SWITCH_MULTILEVEL', async () => {
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device._registerEndpointCapabilities(1, DEVICE_TYPES.DIMMER, {
        COMMAND_CLASS_BASIC: makeCommandClassMock(),
      });

      expect(regSpy).toHaveBeenCalledWith(
        'onoff.ep1',
        'BASIC',
        expect.objectContaining({ getOpts: { getOnStart: false } })
      );
      expect(regSpy).toHaveBeenCalledWith(
        'dim.ep1',
        'BASIC',
        expect.objectContaining({ getOpts: { getOnStart: false } })
      );
    });

    test('skips registration without crashing when the cache lacks the typed CC and BASIC', async () => {
      const regSpy = jest.spyOn(device, 'registerCapability');

      await device._registerEndpointCapabilities(1, DEVICE_TYPES.SWITCH, {});

      expect(regSpy).not.toHaveBeenCalled();
      expect(device.hasCapability('onoff.ep1')).toBe(true);
    });
  });

  describe('multilevel value normalization', () => {
    test('maps the core string names to their byte values', () => {
      expect(device._normalizeMultilevelValue('off/disable')).toBe(0);
      expect(device._normalizeMultilevelValue('on/enable')).toBe(255);
    });

    test('passes finite numbers through', () => {
      expect(device._normalizeMultilevelValue(0)).toBe(0);
      expect(device._normalizeMultilevelValue(50)).toBe(50);
      expect(device._normalizeMultilevelValue(255)).toBe(255);
    });

    test('returns undefined for anything else', () => {
      expect(device._normalizeMultilevelValue('something')).toBeUndefined();
      expect(device._normalizeMultilevelValue(NaN)).toBeUndefined();
      expect(device._normalizeMultilevelValue(null)).toBeUndefined();
      expect(device._normalizeMultilevelValue(undefined)).toBeUndefined();
      expect(device._normalizeMultilevelValue(true)).toBeUndefined();
    });
  });

  describe('blind state sync', () => {
    beforeEach(async () => {
      device._endpointTypes = { 1: DEVICE_TYPES.DIMMER };
      await device.addCapability('onoff.ep1');
      await device.addCapability('dim.ep1');
    });

    test('a 0 report counts as success but writes nothing', async () => {
      // These blinds report 0 regardless of position, so 0 only proves liveness
      await device.setCapabilityValue('onoff.ep1', true);
      await device.setCapabilityValue('dim.ep1', 0.7);
      device._syncFailureCounts[1] = 2;

      await device._syncOneEndpointState(1, makeMultilevelEndpoint('off/disable'));

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBe(0.7);
      expect(device._syncFailureCounts[1]).toBe(0);
    });

    test('a numeric 0 report also writes nothing', async () => {
      await device.setCapabilityValue('onoff.ep1', true);
      await device.setCapabilityValue('dim.ep1', 0.7);

      await device._syncOneEndpointState(1, makeMultilevelEndpoint(0));

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBe(0.7);
    });

    test('a 1-99 report writes onoff and dim', async () => {
      await device._syncOneEndpointState(1, makeMultilevelEndpoint(50));

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBeCloseTo(50 / 99);
    });

    test('a 255 report writes onoff only', async () => {
      await device.setCapabilityValue('dim.ep1', 0.3);

      await device._syncOneEndpointState(1, makeMultilevelEndpoint('on/enable'));

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBe(0.3);
    });
  });

  describe('switch state sync', () => {
    // Re-typed endpoints (Entrance EP2) keep the stale interview cache, which
    // lists BASIC but not SWITCH_BINARY
    function makeStaleCacheSwitchEndpoint(basicReport) {
      return {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_MULTILEVEL',
        CommandClass: {
          COMMAND_CLASS_BASIC: makeCommandClassMock({
            BASIC_GET: jest.fn().mockResolvedValue(basicReport),
          }),
          COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock(),
        },
      };
    }

    beforeEach(async () => {
      device._endpointTypes = { 2: DEVICE_TYPES.SWITCH };
      await device.addCapability('onoff.ep2');
    });

    test('falls back to BASIC_GET when the stale cache lacks SWITCH_BINARY', async () => {
      await device._syncOneEndpointState(2, makeStaleCacheSwitchEndpoint({ Value: 255 }));

      expect(device.getCapabilityValue('onoff.ep2')).toBe(true);
    });

    test('BASIC fallback applies off reports too', async () => {
      await device.setCapabilityValue('onoff.ep2', true);

      await device._syncOneEndpointState(2, makeStaleCacheSwitchEndpoint({ Value: 'off/disable' }));

      expect(device.getCapabilityValue('onoff.ep2')).toBe(false);
    });

    test('leaves state alone when neither SWITCH_BINARY nor BASIC can be read', async () => {
      await device.setCapabilityValue('onoff.ep2', true);
      const endpoint = {
        deviceClassGeneric: 'GENERIC_TYPE_SWITCH_MULTILEVEL',
        CommandClass: { COMMAND_CLASS_SWITCH_MULTILEVEL: makeCommandClassMock() },
      };

      await device._syncOneEndpointState(2, endpoint);

      expect(device.getCapabilityValue('onoff.ep2')).toBe(true);
    });
  });

  describe('one-time blind state reset', () => {
    test('nulls dimmer capabilities exactly once and fires no triggers', async () => {
      const node = makeNode({ 1: makeMultilevelEndpoint('off/disable') });
      device.node = node;
      // Simulate fabricated state left behind by older versions
      device._store.endpointTypes = { 1: DEVICE_TYPES.DIMMER };
      await device.addCapability('onoff.ep1');
      await device.addCapability('dim.ep1');
      await device.setCapabilityValue('onoff.ep1', false);
      await device.setCapabilityValue('dim.ep1', 0);

      await device.onNodeInit({ node });

      expect(device.getCapabilityValue('onoff.ep1')).toBeNull();
      expect(device.getCapabilityValue('dim.ep1')).toBeNull();
      expect(device._store.blindStateResetDone).toBe(true);
      for (const card of device._triggerCards.values()) {
        expect(card.trigger).not.toHaveBeenCalled();
      }

      // A later init must not clobber state again
      await device.setCapabilityValue('onoff.ep1', true);
      await device.setCapabilityValue('dim.ep1', 0.5);
      await device.onNodeInit({ node });

      expect(device.getCapabilityValue('onoff.ep1')).toBe(true);
      expect(device.getCapabilityValue('dim.ep1')).toBe(0.5);
    });
  });

  describe('blind labels', () => {
    test('dimmer endpoints default to a Blind label', () => {
      device._endpointTypes = { 1: DEVICE_TYPES.DIMMER };

      expect(device._getEndpointLabel(1)).toBe('Blind 1');
    });
  });
});
