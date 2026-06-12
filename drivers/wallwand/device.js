'use strict';

const { ZwaveDevice } = require('homey-zwavedriver');
const CommandQueue = require('./lib/CommandQueue');

module.exports = class WallWandDevice extends ZwaveDevice {
  static DEVICE_TYPES = {
    DIMMER: 'dimmer',
    SWITCH: 'switch',
  };

  // Z-Wave SWITCH_MULTILEVEL uses 0-99 range (0 = off, 1-99 = dim levels, 255 = restore last)
  static Z_WAVE_MAX_DIM_VALUE = 99;
  static SYNC_DEBOUNCE_MS = 200;
  static HEALTH_CHECK_INTERVAL_MS = 300000; // 5 minutes
  static COMMAND_DELAY_MS = 250; // Delay between commands to prevent overwhelming device
  static COMMAND_TIMEOUT_MS = 10000; // Timeout for each command (10s)
  static CAPABILITY_SETTLE_DELAY_MS = 50; // Settle time between addCapability and registerCapability
  static MAX_SYNC_FAILURES = 3; // Drop an endpoint after this many failed syncs in a row
  static VERIFY_GENERATION = 4; // Bump to force re-verification of every endpoint after a logic fix
  static VERIFY_PROBE_ATTEMPTS = 3; // Capability probes retried when a duplicate report desyncs the reply
  static VERIFY_RETRY_DELAY_MS = 400; // Lets the panel's duplicate-report bursts drain before retrying

  async onInit() {
    await super.onInit();
    this.log(`[WallWand Device onInit] ${this.getName()} created`);

    this._syncTimeouts = {};
    this._isDiscovering = false;
    // Loaded from the store in onNodeInit, but flow handlers may run before that
    this._endpointTypes = {};
    this._endpointTypesVerified = {};
    this._liveGenericClasses = {};
    this._syncFailureCounts = {};
    this._initialSyncDone = false;

    // Initialize command queue
    this._commandQueue = new CommandQueue(
      {
        log: this.log.bind(this),
        error: this.error.bind(this),
      },
      WallWandDevice.COMMAND_DELAY_MS,
      WallWandDevice.COMMAND_TIMEOUT_MS
    );
  }

  async onNodeInit({ node } = {}) {
    node = node || this.node;
    if (!node) {
      this.error('[onNodeInit] node missing');
      return;
    }

    // this.enableDebug();
    this.printNode();

    this._endpointTypes = (await this.getStoreValue('endpointTypes')) || {};
    this._endpointTypesVerified = (await this.getStoreValue('endpointTypesVerified')) || {};
    this._liveGenericClasses = {};
    this._initialSyncDone = false;

    const verifyGeneration = await this.getStoreValue('endpointVerifyGeneration');
    if (verifyGeneration !== WallWandDevice.VERIFY_GENERATION) {
      // The verification logic changed; earlier results may have been poisoned by
      // the panel's duplicate-report bursts, so probe everything again once.
      // Fabricated blind state may have leaked in under the old logic too, so
      // the one-time null reset reruns as well.
      this._endpointTypesVerified = {};
      await this.setStoreValue('endpointTypesVerified', {});
      await this.setStoreValue('blindStateResetDone', false);
      await this.setStoreValue('endpointVerifyGeneration', WallWandDevice.VERIFY_GENERATION);
    }

    try {
      this._registerRootDeviceListeners(node);
      this._registerEndpointBasicListeners(node);

      await this._discoverAllEndpoints(node);
      // Runs while the trigger gate is still closed so the reset can't fire flows
      await this._resetBlindStateOnce();
      await this._syncAllEndpointStates(node);
      this._initialSyncDone = true;
      await this._cleanupOrphanedEndpoints();

      await this._applyLabelsFromSettings(this.getSettings());
      await this.setStoreValue('endpointTypes', this._endpointTypes);
      await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
      this._startHealthCheck();

      this.log('onNodeInit finished successfully.');
    } catch (error) {
      this.error('[onNodeInit] Initialization failed:', error.message || error);
      throw error;
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys = [] }) {
    const hasLabelChanges = changedKeys.some(k => k.startsWith('label_ep'));

    if (hasLabelChanges) {
      try {
        await this._applyLabelsFromSettings(newSettings);
      } catch (error) {
        this.error('[onSettings] Failed to apply label changes:', error.message || error);
        throw error;
      }
    }

    return super.onSettings({ oldSettings, newSettings, changedKeys });
  }

  async onDeleted() {
    if (this._commandQueue) {
      this._commandQueue.clear();
      this._commandQueue = null;
    }
    if (this._healthCheckInterval) {
      this.homey.clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }

    Object.values(this._syncTimeouts).forEach(timeout => this.homey.clearTimeout(timeout));
    this._syncTimeouts = {};

    // super.onDeleted() removes all command class listeners on the root node,
    // including the root report listeners registered in onNodeInit
    await super.onDeleted();
  }

  async queueCapabilityCommand(capabilityId, value) {
    if (!this._commandQueue) return undefined;
    return this._commandQueue.add(
      () => this.triggerCapabilityListener(capabilityId, value),
      `Capability ${capabilityId} = ${value}`
    );
  }

  // Reads the current value inside the executor so back-to-back toggles
  // don't both act on the same stale state
  async queueToggleCommand(capabilityId) {
    if (!this._commandQueue) return undefined;
    return this._commandQueue.add(
      () =>
        this.triggerCapabilityListener(
          capabilityId,
          !(this.getCapabilityValue(capabilityId) ?? false)
        ),
      `Toggle ${capabilityId}`
    );
  }

  _startHealthCheck() {
    if (this._healthCheckInterval) {
      this.homey.clearInterval(this._healthCheckInterval);
    }

    this._healthCheckInterval = this.homey.setInterval(() => {
      this._checkDeviceHealth().catch(err => {
        this.error('[HEALTH] Health check failed:', err.message || err);
      });
    }, WallWandDevice.HEALTH_CHECK_INTERVAL_MS);
  }

  async _checkDeviceHealth() {
    const typedEndpoints = Object.entries(this._endpointTypes || {}).filter(([, type]) => type);
    const capabilityCount = this.getCapabilities().filter(
      c => c.startsWith('onoff.ep') || c.startsWith('dim.ep')
    ).length;

    const typesLost = typedEndpoints.length === 0 && capabilityCount > 0;
    const capabilitiesMissing = typedEndpoints.some(([id, type]) => {
      const cap = type === WallWandDevice.DEVICE_TYPES.DIMMER ? `dim.ep${id}` : `onoff.ep${id}`;
      return !this.hasCapability(cap);
    });

    if (typesLost || capabilitiesMissing) {
      this.log(
        `[HEALTH] Endpoint state inconsistent (typesLost=${typesLost}, capabilitiesMissing=${capabilitiesMissing}), attempting rediscovery`
      );
      try {
        await this._discoverAllEndpoints(this.node);
        await this.setStoreValue('endpointTypes', this._endpointTypes);
        await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
      } catch (error) {
        this.error('[HEALTH] Rediscovery failed:', error.message || error);
      }
      // Rediscovery already probed every unverified endpoint
      return;
    }

    await this._retryUnverifiedEndpoints();
  }

  // Endpoints typed off the cached interview get one live probe attempt per cycle
  async _retryUnverifiedEndpoints() {
    const unverified = Object.keys(this._endpointTypes || {}).filter(
      id => this._endpointTypes[id] && !this._endpointTypesVerified?.[id]
    );
    if (unverified.length === 0) return;

    try {
      const endpoints = this.node?.MultiChannelNodes || {};
      for (const id of unverified) {
        const endpointNum = parseInt(id, 10);
        await this._discoverOneEndpoint(endpointNum, endpoints[id]);
      }
      await this.setStoreValue('endpointTypes', this._endpointTypes);
      await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
    } catch (error) {
      this.error('[HEALTH] Endpoint re-verification failed:', error.message || error);
    }
  }

  async _getEndpointAutocompleteList(query, dimmersOnly = false) {
    const items = [];
    for (const id in this._endpointTypes) {
      if (this._endpointTypes[id]) {
        const endpointNum = parseInt(id, 10);
        const isDimmer = this._endpointTypes[id] === WallWandDevice.DEVICE_TYPES.DIMMER;

        if (dimmersOnly && !isDimmer) {
          continue;
        }

        items.push({
          name: this._getEndpointLabel(endpointNum),
          id: endpointNum,
        });
      }
    }
    return items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  }

  // Root device reports (no endpoint ID) get debounced to wait for endpoint-specific reports
  _createRootReportListener(deviceType) {
    return async () => {
      if (this._syncTimeouts[deviceType]) {
        this.homey.clearTimeout(this._syncTimeouts[deviceType]);
      }

      this._syncTimeouts[deviceType] = this.homey.setTimeout(async () => {
        this.log(
          `[REPORT] Root ${deviceType} detected, no endpoint report received, syncing all ${deviceType}s`
        );
        try {
          await this._syncEndpointsByType(deviceType);
        } catch (error) {
          this.error(`[REPORT] Failed to sync ${deviceType} endpoints after root report`, error);
        }
      }, WallWandDevice.SYNC_DEBOUNCE_MS);
    };
  }

  // Physical presses arrive as multi-channel encapsulated BASIC_SET frames whose
  // source endpoint identifies what changed, so they can be applied directly
  // without the poll-everything debounce
  _registerEndpointBasicListeners(node) {
    const endpoints = node?.MultiChannelNodes || {};
    let count = 0;

    for (const id of Object.keys(endpoints)) {
      const endpointNum = parseInt(id, 10);
      const cc = endpoints[id]?.CommandClass?.COMMAND_CLASS_BASIC;
      if (!cc || Number.isNaN(endpointNum) || endpointNum < 1) continue;

      cc.on('report', (command, report) =>
        this._onEndpointBasicSet(endpointNum, command, report).catch(err => {
          this.error(`[BASIC] EP${endpointNum} report handling failed:`, err.message || err);
        })
      );
      count++;
    }

    this.log(`[LISTENERS] BASIC_SET listeners registered on ${count} endpoint(s)`);
  }

  async _onEndpointBasicSet(endpointNum, command, report) {
    if (command?.name !== 'BASIC_SET') return;
    if (!report || typeof report !== 'object' || report.Value == null) return;

    const deviceType = this._endpointTypes[endpointNum];
    if (!deviceType) return;

    const value = report.Value;
    this.log(`[BASIC] EP${endpointNum} BASIC_SET value=${value}`);

    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;

    if (deviceType === WallWandDevice.DEVICE_TYPES.SWITCH) {
      await this._setOnOff(onoffCap, value > 0, endpointNum);
      return;
    }

    // Dimmer turned on to its previous level; the level has to be read back
    if (value === 255) {
      await this._setOnOff(onoffCap, true, endpointNum);
      const endpoint = this.node?.MultiChannelNodes?.[endpointNum];
      if (endpoint) {
        await this._syncOneEndpointState(endpointNum, endpoint);
      }
      return;
    }

    await this._setOnOff(onoffCap, value > 0, endpointNum);
    await this._setDim(dimCap, value / WallWandDevice.Z_WAVE_MAX_DIM_VALUE, endpointNum);
  }

  _registerRootDeviceListeners(node) {
    if (node?.CommandClass?.COMMAND_CLASS_SWITCH_MULTILEVEL) {
      node.CommandClass.COMMAND_CLASS_SWITCH_MULTILEVEL.on(
        'report',
        this._createRootReportListener(WallWandDevice.DEVICE_TYPES.DIMMER)
      );
    }

    if (node?.CommandClass?.COMMAND_CLASS_SWITCH_BINARY) {
      node.CommandClass.COMMAND_CLASS_SWITCH_BINARY.on(
        'report',
        this._createRootReportListener(WallWandDevice.DEVICE_TYPES.SWITCH)
      );
    }

    this.log('[LISTENERS] Root device listeners registered with debouncing');
  }

  async _discoverAllEndpoints(node) {
    if (this._isDiscovering) {
      this.log('[DISCOVERY] Already in progress, skipping');
      return;
    }

    this._isDiscovering = true;
    try {
      const endpoints = node.MultiChannelNodes || {};
      const endpointIds = Object.keys(endpoints);

      if (endpointIds.length === 0) {
        this.log('[DISCOVERY] No endpoints found, cleaning up all capabilities');
        await this._cleanupAllEndpoints();
        return;
      }

      this.log(`[DISCOVERY] Starting discovery for ${endpointIds.length} endpoint(s)`);

      for (const id of endpointIds) {
        const endpointNum = parseInt(id, 10);

        if (Number.isNaN(endpointNum) || endpointNum < 1) {
          this.error(`[DISCOVERY] Invalid endpoint ID: ${id}`);
          continue;
        }

        await this._discoverOneEndpoint(endpointNum, endpoints[id]);
      }
    } finally {
      this._isDiscovering = false;
    }
  }

  async _discoverOneEndpoint(endpointNum, endpoint) {
    if (!endpoint) {
      return;
    }

    const commandClass = endpoint.CommandClass || {};
    let deviceType;

    if (
      this._endpointTypesVerified?.[endpointNum] &&
      this._endpointTypes[endpointNum] !== undefined
    ) {
      // The live panel already confirmed this type; the cached interview still
      // claims the factory layout, so consulting it again would undo the fix
      deviceType = this._endpointTypes[endpointNum];
    } else {
      deviceType = this._detectEndpointType(endpoint, commandClass);

      // The panel advertises its factory layout during inclusion, so the cached
      // interview can mistype endpoints; ask the live panel once and trust that
      const liveType = await this._verifyEndpointLive(endpointNum);
      if (liveType !== undefined) {
        if (liveType !== deviceType) {
          this.log(
            `[VERIFY] EP${endpointNum} live class ${this._liveGenericClasses[endpointNum]} -> ${liveType} (cache said ${deviceType})`
          );
        }
        deviceType = liveType;
        // Persisted together with endpointTypes once registration settles, so a
        // crash or failed registration can't leave a verified flag in the store
        // pointing at a type that never got working capabilities
        this._endpointTypesVerified[endpointNum] = true;
      }
    }

    if (!deviceType) {
      this.log(
        `[ENDPOINT ${endpointNum}] Type "${endpoint.deviceClassGeneric}" not supported, removing capabilities`
      );
      this._endpointTypes[endpointNum] = null;
      await this._removeEndpointCapabilities(endpointNum);
      return;
    }

    if (this._endpointTypes[endpointNum]) {
      if (this._endpointTypes[endpointNum] !== deviceType) {
        this.log(
          `[ENDPOINT ${endpointNum}] Type changed from ${this._endpointTypes[endpointNum]} to ${deviceType}, re-registering`
        );
        await this._removeEndpointCapabilities(endpointNum);
        this._endpointTypes[endpointNum] = null;
        // Fall through to new registration below
      } else {
        this.log(
          `[ENDPOINT ${endpointNum}] Already known as ${deviceType}, ensuring capabilities are registered`
        );
        try {
          await this._registerEndpointCapabilities(endpointNum, deviceType, commandClass);
        } catch (error) {
          const errorMsg = error.message || error.toString();
          if (!this._isTransientError(errorMsg)) {
            this.log(`[ENDPOINT ${endpointNum}] Capability registration note: ${errorMsg}`);
          }
        }
        return;
      }
    }

    this.log(`[ENDPOINT ${endpointNum}] Discovered as ${deviceType}`);

    try {
      await this._registerEndpointCapabilities(endpointNum, deviceType, commandClass);
      this._endpointTypes[endpointNum] = deviceType;
      await this.setStoreValue('endpointTypes', this._endpointTypes);
      await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
      this.log(`[CAPABILITY] EP${endpointNum} capabilities registered as ${deviceType}`);
    } catch (error) {
      // Silently handle expected timeout errors during discovery
      const errorMsg = error.message || error.toString();
      if (this._isTransientError(errorMsg)) {
        // Still mark the endpoint type so it's not lost
        this._endpointTypes[endpointNum] = deviceType;
        await this.setStoreValue('endpointTypes', this._endpointTypes);
        await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
        this.log(
          `[ENDPOINT ${endpointNum}] Registered as ${deviceType} (initial state will sync later)`
        );
      } else {
        // Forget the verification so a later rediscovery re-probes the panel
        // instead of pinning the endpoint to a type without working capabilities
        delete this._endpointTypesVerified[endpointNum];
        await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
        this.error(`[ENDPOINT ${endpointNum}] Registration failed: ${errorMsg}`);
      }
    }
  }

  // Blind reports carry no position on this hardware (0 whether open or closed),
  // so only a genuine 1-99 level may reach the capabilities; everything else is
  // ignored by returning null (homey-zwavedriver skips the write)
  _blindOnoffReportParser(report) {
    const value = this._normalizeMultilevelValue(this._extractReportValue(report));
    if (typeof value !== 'number' || value === 0) return null;
    return true;
  }

  _blindDimReportParser(report) {
    const value = this._normalizeMultilevelValue(this._extractReportValue(report));
    if (typeof value !== 'number' || value === 0 || value === 255) return null;
    return Math.min(value / WallWandDevice.Z_WAVE_MAX_DIM_VALUE, 1);
  }

  _detectEndpointType(endpoint, commandClass) {
    const isDimmer =
      endpoint.deviceClassGeneric === 'GENERIC_TYPE_SWITCH_MULTILEVEL' &&
      commandClass.COMMAND_CLASS_SWITCH_MULTILEVEL;

    const isSwitch =
      endpoint.deviceClassGeneric === 'GENERIC_TYPE_SWITCH_BINARY' &&
      commandClass.COMMAND_CLASS_SWITCH_BINARY;

    if (isDimmer) return WallWandDevice.DEVICE_TYPES.DIMMER;
    if (isSwitch) return WallWandDevice.DEVICE_TYPES.SWITCH;
    return null;
  }

  // Asks the live panel what an endpoint really is via MULTI_CHANNEL_CAPABILITY_GET.
  // Returns a DEVICE_TYPES value, null for unsupported classes, or undefined when
  // the panel could not be reached (keep the cached type in that case).
  async _verifyEndpointLive(endpointNum) {
    const cc = this.node?.CommandClass?.COMMAND_CLASS_MULTI_CHANNEL;
    if (!cc || typeof cc.MULTI_CHANNEL_CAPABILITY_GET !== 'function') {
      return undefined;
    }

    let report;
    for (let attempt = 1; attempt <= WallWandDevice.VERIFY_PROBE_ATTEMPTS; attempt++) {
      report = await this._probeEndpointCapability(cc, endpointNum);
      if (report === undefined) {
        return undefined;
      }

      // The panel retransmits every report in bursts, and a stale duplicate of a
      // previous endpoint's report can resolve this GET; trust only a matching reply
      const reportedEp = this._extractReportEndpoint(report);
      if (reportedEp === undefined || reportedEp === endpointNum) {
        break;
      }

      this.log(
        `[VERIFY] EP${endpointNum} probe answered by a duplicate EP${reportedEp} report, retrying`
      );
      report = null;
      await this._delay(WallWandDevice.VERIFY_RETRY_DELAY_MS);
    }

    if (!report || typeof report !== 'object') {
      this.log(`[VERIFY] EP${endpointNum} got no matching capability report, keeping cached type`);
      return undefined;
    }

    const genericClass = report['Generic Device Class'];
    if (typeof genericClass !== 'number') {
      return undefined;
    }

    this._liveGenericClasses[endpointNum] = genericClass;

    const ccList = report['Command Class (Raw)'];
    const supportsCc = id =>
      Boolean(ccList && typeof ccList.includes === 'function' && ccList.includes(id));

    // 16 = binary switch, 17 = multilevel switch; anything else (e.g. 24,
    // wall controller) is not controllable by this driver
    if (genericClass === 16 && supportsCc(0x25)) {
      return WallWandDevice.DEVICE_TYPES.SWITCH;
    }
    if (genericClass === 17 && supportsCc(0x26)) {
      return WallWandDevice.DEVICE_TYPES.DIMMER;
    }
    return null;
  }

  // One MULTI_CHANNEL_CAPABILITY_GET attempt; tries the parsed-bitfield arg first,
  // then the raw single-byte form. Returns the report, or undefined when unreachable.
  async _probeEndpointCapability(cc, endpointNum) {
    try {
      return await cc.MULTI_CHANNEL_CAPABILITY_GET({
        Properties1: { 'End Point': endpointNum },
      });
    } catch (error) {
      const errorMsg = error.message || error.toString();
      if (this._isTransientError(errorMsg)) {
        this.log(`[VERIFY] EP${endpointNum} capability probe timed out, keeping cached type`);
        return undefined;
      }
      // The payload encoder may not accept the nested bitfield form; the GET
      // frame is a single byte with the endpoint in bits 0-6, so send it raw
      try {
        return await cc.MULTI_CHANNEL_CAPABILITY_GET({
          Properties1: Buffer.from([endpointNum]),
        });
      } catch (retryError) {
        this.log(
          `[VERIFY] EP${endpointNum} capability probe failed: ${retryError.message || retryError.toString()}`
        );
        return undefined;
      }
    }
  }

  // The endpoint a capability report describes: bits 0-6 of Properties1
  _extractReportEndpoint(report) {
    const parsed = report?.Properties1?.['End Point'];
    if (typeof parsed === 'number') {
      return parsed;
    }
    const raw = report?.['Properties1 (Raw)'];
    if (raw && typeof raw[0] === 'number') {
      return raw[0] & 0x7f;
    }
    return undefined;
  }

  _registerCapabilitySafe(capabilityId, commandClassName, endpointNum, extraOpts = {}) {
    try {
      this.registerCapability(capabilityId, commandClassName, {
        multiChannelNodeId: endpointNum,
        // Initial state is read by _syncAllEndpointStates; a GET here would duplicate it
        getOpts: { getOnStart: false },
        ...extraOpts,
      });
    } catch (error) {
      const errorMsg = error.message || error.toString();
      if (this._isTransientError(errorMsg)) {
        this.log(`[CAPABILITY] ${capabilityId} handler registered (device communication pending)`);
      } else {
        throw new Error(`Failed to register ${capabilityId}: ${errorMsg}`);
      }
    }
  }

  // A re-typed endpoint may lack its expected CC in the stale interview cache;
  // registering against a missing CC silently no-ops in homey-zwavedriver, so
  // fall back to BASIC (present on every endpoint) when that happens
  async _registerEndpointCapabilities(endpointNum, deviceType, cachedCommandClass) {
    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;
    const cachedCc =
      cachedCommandClass || this.node?.MultiChannelNodes?.[endpointNum]?.CommandClass || {};

    if (deviceType === WallWandDevice.DEVICE_TYPES.DIMMER) {
      await this._ensureCapability(onoffCap);
      await this._ensureCapability(dimCap);
      await this._delay(WallWandDevice.CAPABILITY_SETTLE_DELAY_MS);
      // The library's report parsers would otherwise write the panel's meaningless
      // 0-reports straight into the capabilities, bypassing _syncDimmerState.
      // reportParserOverride is required, or the version-specific system parsers
      // (reportParserV4) still win (ZwaveDevice.js resolves V{n} parsers first)
      const blindOnoffOpts = {
        reportParser: report => this._blindOnoffReportParser(report),
        reportParserOverride: true,
      };
      const blindDimOpts = {
        reportParser: report => this._blindDimReportParser(report),
        reportParserOverride: true,
      };
      if (cachedCc.COMMAND_CLASS_SWITCH_MULTILEVEL) {
        this._registerCapabilitySafe(onoffCap, 'SWITCH_MULTILEVEL', endpointNum, blindOnoffOpts);
        this._registerCapabilitySafe(dimCap, 'SWITCH_MULTILEVEL', endpointNum, blindDimOpts);
      } else if (cachedCc.COMMAND_CLASS_BASIC) {
        this.log(`[CAPABILITY] EP${endpointNum} cached node lacks SWITCH_MULTILEVEL, using BASIC`);
        this._registerCapabilitySafe(onoffCap, 'BASIC', endpointNum, blindOnoffOpts);
        this._registerCapabilitySafe(dimCap, 'BASIC', endpointNum, blindDimOpts);
      } else {
        this.error(
          `[CAPABILITY] EP${endpointNum} cached node has neither SWITCH_MULTILEVEL nor BASIC, skipping registration`
        );
      }
    } else if (deviceType === WallWandDevice.DEVICE_TYPES.SWITCH) {
      await this._ensureCapability(onoffCap);
      await this._delay(WallWandDevice.CAPABILITY_SETTLE_DELAY_MS);
      if (cachedCc.COMMAND_CLASS_SWITCH_BINARY) {
        this._registerCapabilitySafe(onoffCap, 'SWITCH_BINARY', endpointNum);
      } else if (cachedCc.COMMAND_CLASS_BASIC) {
        this.log(`[CAPABILITY] EP${endpointNum} cached node lacks SWITCH_BINARY, using BASIC`);
        this._registerCapabilitySafe(onoffCap, 'BASIC', endpointNum);
      } else {
        this.error(
          `[CAPABILITY] EP${endpointNum} cached node has neither SWITCH_BINARY nor BASIC, skipping registration`
        );
      }
    }
  }

  _isValidReport(report, requiredField) {
    return Boolean(
      report &&
      typeof report === 'object' &&
      requiredField in report &&
      report[requiredField] != null
    );
  }

  _isTransientError(errorMsg) {
    return ['timeout', 'did not respond', 'NO_ACK', 'capability get command failed'].some(s =>
      errorMsg.includes(s)
    );
  }

  // Reports use 'Current Value' or 'Value' depending on command class version
  _extractReportValue(report) {
    if (this._isValidReport(report, 'Current Value')) return report['Current Value'];
    if (this._isValidReport(report, 'Value')) return report['Value'];
    return undefined;
  }

  // Homey core decodes multilevel 0/255 to XML value names; 1-99 stay numeric
  _normalizeMultilevelValue(value) {
    if (value === 'off/disable') return 0;
    if (value === 'on/enable') return 255;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
  }

  async _syncAllEndpointStates(node) {
    const endpoints = node.MultiChannelNodes || {};
    const discoveredIds = Object.keys(this._endpointTypes);

    this.log(`[SYNC] Syncing state for ${discoveredIds.length} endpoint(s)`);

    for (const id of discoveredIds) {
      const endpointNum = parseInt(id, 10);
      await this._syncOneEndpointState(endpointNum, endpoints[id]);
    }
  }

  async _syncEndpointsByType(deviceType) {
    const node = this.node;
    if (!node) {
      this.error('[SYNC] Node not available');
      return;
    }

    const endpoints = node.MultiChannelNodes || {};
    const endpointsToSync = Object.keys(this._endpointTypes)
      .filter(id => this._endpointTypes[id] === deviceType)
      .map(id => parseInt(id, 10));

    if (endpointsToSync.length === 0) {
      this.log(`[SYNC] No ${deviceType} endpoints to sync`);
      return;
    }

    this.log(
      `[SYNC] Syncing ${endpointsToSync.length} ${deviceType} endpoint(s): [${endpointsToSync.join(', ')}]`
    );

    for (const endpointNum of endpointsToSync) {
      await this._syncOneEndpointState(endpointNum, endpoints[endpointNum]);
    }
  }

  async _syncOneEndpointState(endpointNum, endpoint) {
    const deviceType = this._endpointTypes[endpointNum];

    if (!endpoint) {
      this.log(`[ENDPOINT ${endpointNum}] No longer available, removing capabilities`);
      await this._removeEndpointCapabilities(endpointNum);
      return;
    }

    if (deviceType === null || deviceType === undefined) {
      return;
    }

    const commandClass = endpoint.CommandClass || {};
    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;

    try {
      let syncSuccess = false;
      if (deviceType === WallWandDevice.DEVICE_TYPES.DIMMER) {
        syncSuccess = await this._syncDimmerState(endpointNum, commandClass, onoffCap, dimCap);
      } else if (deviceType === WallWandDevice.DEVICE_TYPES.SWITCH) {
        syncSuccess = await this._syncSwitchState(endpointNum, commandClass, onoffCap);
      }

      if (!syncSuccess) {
        this.log(
          `[SYNC] EP${endpointNum} returned invalid or missing report, will retry on next update`
        );
      }
      this._syncFailureCounts[endpointNum] = 0;
    } catch (error) {
      const errorMsg = error.message || error.toString();

      // Distinguish between transient errors (common, usually recovers) and other errors
      if (this._isTransientError(errorMsg)) {
        this.log(
          `[SYNC] EP${endpointNum} timeout - device may be busy or out of range, will retry on next update`
        );
        return;
      }

      // Don't drop the endpoint on a single odd error, wait for a few in a row
      const failures = (this._syncFailureCounts[endpointNum] || 0) + 1;
      this._syncFailureCounts[endpointNum] = failures;

      if (failures < WallWandDevice.MAX_SYNC_FAILURES) {
        this.log(
          `[SYNC] EP${endpointNum} sync failed (${failures}/${WallWandDevice.MAX_SYNC_FAILURES}): ${errorMsg}`
        );
        return;
      }

      this.log(
        `[SYNC] EP${endpointNum} failed ${failures} consecutive syncs, marking as unsupported and removing capabilities`
      );
      this._syncFailureCounts[endpointNum] = 0;
      this._endpointTypes[endpointNum] = null;
      // Forget the live verification too, so a later rediscovery probes the
      // panel again instead of pinning the endpoint to null forever
      delete this._endpointTypesVerified[endpointNum];
      await this._removeEndpointCapabilities(endpointNum);
      await this.setStoreValue('endpointTypes', this._endpointTypes);
      await this.setStoreValue('endpointTypesVerified', this._endpointTypesVerified);
    }
  }

  async _delay(ms) {
    return new Promise(resolve => this.homey.setTimeout(resolve, ms));
  }

  async _syncDimmerState(endpointNum, commandClass, onoffCap, dimCap) {
    await this._ensureCapability(onoffCap);
    await this._ensureCapability(dimCap);

    const cc = commandClass.COMMAND_CLASS_SWITCH_MULTILEVEL;
    if (!cc || typeof cc.SWITCH_MULTILEVEL_GET !== 'function') {
      this.error(`[SYNC] EP${endpointNum} SWITCH_MULTILEVEL not available`);
      return false;
    }

    const report = await cc.SWITCH_MULTILEVEL_GET();
    const dimValue = this._normalizeMultilevelValue(this._extractReportValue(report));

    if (dimValue === undefined) {
      return false;
    }

    // These blinds report 0 regardless of position, so 0 only proves the
    // endpoint is alive; writing it into the capabilities would fabricate state
    if (dimValue === 0) {
      this.log(
        `[SYNC] EP${endpointNum} multilevel reports 0 - position unknown on this hardware, leaving state unchanged`
      );
      return true;
    }

    if (dimValue === 255) {
      this.log(`[SYNC] EP${endpointNum} multilevel reports 255, marking on (level unknown)`);
      await this._setOnOff(onoffCap, true, endpointNum);
      return true;
    }

    this.log(`[SYNC] EP${endpointNum} dimmer: ${dimValue}/${WallWandDevice.Z_WAVE_MAX_DIM_VALUE}`);
    await this._setOnOff(onoffCap, true, endpointNum);
    await this._setDim(dimCap, dimValue / WallWandDevice.Z_WAVE_MAX_DIM_VALUE, endpointNum);
    return true;
  }

  async _syncSwitchState(endpointNum, commandClass, onoffCap) {
    await this._removeIfPresent(`dim.ep${endpointNum}`);
    await this._ensureCapability(onoffCap);

    const binaryCc = commandClass.COMMAND_CLASS_SWITCH_BINARY;
    const basicCc = commandClass.COMMAND_CLASS_BASIC;
    let readState;
    if (binaryCc && typeof binaryCc.SWITCH_BINARY_GET === 'function') {
      readState = () => binaryCc.SWITCH_BINARY_GET();
    } else if (basicCc && typeof basicCc.BASIC_GET === 'function') {
      // A re-typed endpoint keeps the stale interview cache without
      // SWITCH_BINARY; BASIC maps to the same on/off state
      this.log(`[SYNC] EP${endpointNum} reading state through BASIC (cache lacks SWITCH_BINARY)`);
      readState = () => basicCc.BASIC_GET();
    } else {
      this.error(`[SYNC] EP${endpointNum} SWITCH_BINARY not available`);
      return false;
    }

    const report = await readState();
    const reportValue = this._extractReportValue(report);

    if (reportValue !== undefined) {
      const isOn =
        reportValue === 'on/enable' ||
        reportValue === 1 ||
        reportValue === 255 ||
        reportValue === true ||
        reportValue === 'true';
      this.log(`[SYNC] EP${endpointNum} switch: ${isOn}`);
      await this._setOnOff(onoffCap, isOn, endpointNum);
      return true;
    }

    return false;
  }

  // Older versions wrote the blinds' always-0 multilevel report into onoff/dim
  // as off/0%, which was fabricated. Clear those once so the state reads unknown.
  async _resetBlindStateOnce() {
    if (await this.getStoreValue('blindStateResetDone')) return;

    for (const id of Object.keys(this._endpointTypes)) {
      if (this._endpointTypes[id] !== WallWandDevice.DEVICE_TYPES.DIMMER) continue;
      const endpointNum = parseInt(id, 10);
      for (const cap of [`onoff.ep${endpointNum}`, `dim.ep${endpointNum}`]) {
        if (!this.hasCapability(cap)) continue;
        try {
          await this.setCapabilityValue(cap, null);
        } catch (error) {
          this.log(`[MIGRATION] Note resetting ${cap}: ${error.message || error.toString()}`);
        }
      }
      this.log(`[MIGRATION] EP${endpointNum} blind state reset to unknown`);
    }

    await this.setStoreValue('blindStateResetDone', true);
  }

  async _cleanupOrphanedEndpoints() {
    this.log('[CLEANUP] Checking for orphaned endpoint capabilities');
    const manifestCapabilities = this.driver.manifest.capabilities || [];

    let maxManifestEndpoint = 0;
    for (const capId of manifestCapabilities) {
      const match = capId.match(/\.ep(\d+)$/);
      if (match && match[1]) {
        const endpointNum = parseInt(match[1], 10);
        if (endpointNum > maxManifestEndpoint) {
          maxManifestEndpoint = endpointNum;
        }
      }
    }

    if (maxManifestEndpoint === 0) {
      this.log('[CLEANUP] No endpoint capabilities in manifest');
      return;
    }

    for (let i = 1; i <= maxManifestEndpoint; i++) {
      if (
        !Object.prototype.hasOwnProperty.call(this._endpointTypes, i) ||
        this._endpointTypes[i] === null
      ) {
        if (this.hasCapability(`onoff.ep${i}`) || this.hasCapability(`dim.ep${i}`)) {
          this.log(`[CLEANUP] EP${i} is orphaned or unsupported, removing capabilities`);
          await this._removeEndpointCapabilities(i);
        }
      }
    }
  }

  async _applyLabelsFromSettings(settings = {}) {
    const supportedEndpoints = Object.keys(this._endpointTypes).filter(
      id => this._endpointTypes[id]
    );

    for (const id of supportedEndpoints) {
      const endpointNum = parseInt(id, 10);
      await this._applyLabelToEndpoint(endpointNum, settings);
    }
  }

  _sanitizeLabel(raw) {
    return (raw || '')
      .trim()
      .substring(0, 50) // Limit length
      .replace(/[<>]/g, ''); // Remove potential HTML
  }

  async _applyLabelToEndpoint(endpointNum, settings) {
    const customLabel = this._sanitizeLabel(settings[`label_ep${endpointNum}`]);

    const onoffCap = `onoff.ep${endpointNum}`;
    const dimCap = `dim.ep${endpointNum}`;
    const isDimmer = this._endpointTypes[endpointNum] === WallWandDevice.DEVICE_TYPES.DIMMER;
    const capId = isDimmer ? dimCap : onoffCap;

    const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, capId);
    const finalLabel = customLabel || defaultLabel;

    try {
      if (this.hasCapability(onoffCap)) {
        await this._setTitle(onoffCap, finalLabel);
      }
      if (isDimmer && this.hasCapability(dimCap)) {
        await this._setTitle(dimCap, finalLabel);
      }
    } catch (error) {
      this.error(`[LABEL] Failed to set label for EP${endpointNum}:`, error.message || error);
    }
  }

  _getDefaultLabel(endpointNum, isDimmer, capabilityId) {
    const manifestDefault = this.driver?.manifest?.capabilitiesOptions?.[capabilityId]?.title?.en;

    if (manifestDefault) {
      return manifestDefault;
    }

    const typeLabel = isDimmer ? 'Blind' : 'Switch';
    return `${typeLabel} ${endpointNum}`;
  }

  async _cleanupAllEndpoints() {
    this._endpointTypes = {};
    this._endpointTypesVerified = {};
    await this.setStoreValue('endpointTypes', {});
    await this.setStoreValue('endpointTypesVerified', {});

    const manifestCapabilities = this.driver.manifest.capabilities || [];
    const endpointCapabilities = manifestCapabilities.filter(id => id.match(/\.ep\d+$/));
    const cleanupPromises = endpointCapabilities.map(capId => this._removeIfPresent(capId));
    await Promise.all(cleanupPromises);
    await this.setSettings(this._blankLabels());
  }

  async _removeEndpointCapabilities(endpointNum) {
    await this._removeIfPresent(`dim.ep${endpointNum}`);
    await this._removeIfPresent(`onoff.ep${endpointNum}`);
  }

  _blankLabels() {
    const labels = {};
    const manifestSettings = this.driver.manifest.settings || [];
    for (const setting of manifestSettings) {
      if (setting.id.startsWith('label_ep')) {
        labels[setting.id] = '';
      }
    }
    return labels;
  }

  async _ensureCapability(cap) {
    if (!this.hasCapability(cap)) {
      try {
        await this.addCapability(cap);
        this.log(`[CAPABILITY] Added ${cap}`);
      } catch (err) {
        const errorMsg = err.message || err.toString();
        // Only log if it's not a "capability already exists" type error
        if (!errorMsg.includes('already exists') && !errorMsg.includes('duplicate')) {
          this.log(`[CAPABILITY] Note adding ${cap}: ${errorMsg}`);
        }
      }
    }
  }

  async _removeIfPresent(cap) {
    if (this.hasCapability(cap)) {
      await this.removeCapability(cap).catch(err => {
        const errorMsg = err.message || err.toString();
        this.log(`[CAPABILITY] Note removing ${cap}: ${errorMsg}`);
      });
    }
  }

  async _setTitle(cap, title) {
    return this.setCapabilityOptions(cap, { title }).catch(err => {
      const errorMsg = err.message || err.toString();
      this.log(`[CAPABILITY] Note setting title for ${cap}: ${errorMsg}`);
    });
  }

  _getEndpointLabel(endpointNum) {
    const settings = this.getSettings();
    const customLabel = this._sanitizeLabel(settings[`label_ep${endpointNum}`]);
    const isDimmer = this._endpointTypes[endpointNum] === WallWandDevice.DEVICE_TYPES.DIMMER;
    const capId = isDimmer ? `dim.ep${endpointNum}` : `onoff.ep${endpointNum}`;
    const defaultLabel = this._getDefaultLabel(endpointNum, isDimmer, capId);
    return customLabel || defaultLabel;
  }

  async _triggerEndpoint(triggerId, endpointNum, tokens = {}) {
    try {
      const trigger = this.homey.flow.getDeviceTriggerCard(triggerId);
      if (!trigger) return;

      await trigger.trigger(
        this,
        {
          endpoint_id: endpointNum,
          endpoint_label: this._getEndpointLabel(endpointNum),
          ...tokens,
        },
        {
          endpoint: {
            id: endpointNum,
            name: this._getEndpointLabel(endpointNum),
          },
        }
      );

      this.log(`[FLOW] Triggered '${triggerId}' for EP${endpointNum}`);
    } catch (error) {
      this.error(
        `[FLOW] Failed to trigger '${triggerId}' for EP${endpointNum}:`,
        error.message || error
      );
    }
  }

  async _triggerEndpointTurnedOn(endpointNum) {
    await this._triggerEndpoint('endpoint_turned_on', endpointNum);
  }

  async _triggerEndpointTurnedOff(endpointNum) {
    await this._triggerEndpoint('endpoint_turned_off', endpointNum);
  }

  async _triggerEndpointDimChanged(endpointNum, dimValue) {
    await this._triggerEndpoint('endpoint_dim_changed', endpointNum, { dim_value: dimValue });
  }

  async _triggerEndpointStateChanged(endpointNum, state) {
    await this._triggerEndpoint('endpoint_state_changed', endpointNum, { state });
  }

  async _setOnOff(cap, value, endpointNum) {
    if (!cap || typeof cap !== 'string') {
      this.error('[ONOFF] Invalid capability ID');
      return;
    }

    if (!this.hasCapability(cap)) {
      // Silently ignore if capability doesn't exist yet (race condition during discovery)
      return;
    }

    const oldValue = this.getCapabilityValue(cap);
    const newValue = !!value;

    try {
      await this.setCapabilityValue(cap, newValue);
    } catch (err) {
      const errorMsg = err.message || err.toString();
      // Only log non-race-condition errors
      if (!errorMsg.includes('Invalid Capability')) {
        this.error(`[ONOFF] Failed to set ${cap} to ${newValue}: ${errorMsg}`);
      }
      return;
    }

    if (oldValue === newValue) return;

    // Don't fire flows for state we're just catching up on after a restart
    if (!this._initialSyncDone) return;

    if (newValue) {
      await this._triggerEndpointTurnedOn(endpointNum);
    } else {
      await this._triggerEndpointTurnedOff(endpointNum);
    }

    await this._triggerEndpointStateChanged(endpointNum, newValue);
  }

  async _setDim(cap, value01, endpointNum) {
    if (!cap || typeof cap !== 'string') {
      this.error('[DIM] Invalid capability ID');
      return;
    }

    const normalizedValue = Math.max(0, Math.min(1, Number(value01) || 0));

    if (!this.hasCapability(cap)) {
      // Silently ignore if capability doesn't exist yet (race condition during discovery)
      return;
    }

    const oldValue = this.getCapabilityValue(cap);

    try {
      await this.setCapabilityValue(cap, normalizedValue);
    } catch (err) {
      const errorMsg = err.message || err.toString();
      // Only log non-race-condition errors
      if (!errorMsg.includes('Invalid Capability')) {
        this.error(`[DIM] Failed to set ${cap} to ${normalizedValue}: ${errorMsg}`);
      }
      return;
    }

    if (oldValue === normalizedValue) return;
    if (!this._initialSyncDone) return;

    await this._triggerEndpointDimChanged(endpointNum, normalizedValue);
  }

  async _handleEndpointIsOn(args) {
    if (!args.endpoint?.id) {
      this.error('[FLOW] Invalid endpoint in condition');
      return false;
    }

    const endpointNum = args.endpoint.id;
    if (!this._endpointTypes[endpointNum]) {
      this.error(`[FLOW] Endpoint ${endpointNum} not found or unsupported`);
      return false;
    }

    const cap = `onoff.ep${endpointNum}`;
    if (!this.hasCapability(cap)) return false;
    return !!this.getCapabilityValue(cap);
  }

  async _handleEndpointDimCompare(args) {
    if (!args.endpoint?.id) {
      this.error('[FLOW] Invalid endpoint in condition');
      return false;
    }

    const endpointNum = args.endpoint.id;
    if (!this._endpointTypes[endpointNum]) {
      this.error(`[FLOW] Endpoint ${endpointNum} not found or unsupported`);
      return false;
    }

    const cap = `dim.ep${endpointNum}`;
    if (!this.hasCapability(cap)) return false;

    const current = this.getCapabilityValue(cap) || 0;
    const target = Number(args.level) || 0;

    switch (args.comparison) {
      case 'greater_than':
        return current > target;
      case 'less_than':
        return current < target;
      case 'equal_to':
        return Math.abs(current - target) < 0.01;
      default:
        return false;
    }
  }
};
