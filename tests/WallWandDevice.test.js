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
});
