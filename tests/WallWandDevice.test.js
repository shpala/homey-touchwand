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
      const turnedOn = device._triggerCards.get('endpoint_turned_on');
      expect(turnedOn.trigger).not.toHaveBeenCalled();
    });

    test('state changes after onNodeInit fire flow triggers', async () => {
      const node = makeNode({ 1: makeBinaryEndpoint(255) });
      device.node = node;
      await device.onNodeInit({ node });

      await device._setOnOff('onoff.ep1', false, 1);

      const turnedOff = device._triggerCards.get('endpoint_turned_off');
      expect(turnedOff.trigger).toHaveBeenCalled();
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
