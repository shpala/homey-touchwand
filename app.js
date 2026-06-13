'use strict';

const Homey = require('homey');

const BLIND = 'blind';
const SWITCH = 'switch';

class TouchWandApp extends Homey.App {
  async onInit() {
    this.log('TouchWand app has been initialized');
    this._registerActionCards();
    this._registerConditionCards();
    this._registerTriggerCards();
  }

  _registerTriggerCards() {
    // [triggerId, typeFilter]; deprecated dim card filters to blind so its
    // autocomplete lists nothing (no endpoint has a dim capability anymore)
    const triggerIds = [
      ['endpoint_turned_on', SWITCH],
      ['endpoint_turned_off', SWITCH],
      ['endpoint_dim_changed', BLIND],
      ['endpoint_state_changed', SWITCH],
      ['blind_state_changed', BLIND],
    ];

    for (const [triggerId, typeFilter] of triggerIds) {
      const card = this.homey.flow.getDeviceTriggerCard(triggerId);
      if (!card) continue;
      card.registerArgumentAutocompleteListener('endpoint', async (query, args) =>
        args.device._getEndpointAutocompleteList(query, typeFilter)
      );
    }
  }

  _registerActionCards() {
    this._registerOnoffAction('turn_endpoint_on', (device, cap) =>
      device.queueCapabilityCommand(cap, true)
    );
    this._registerOnoffAction('turn_endpoint_off', (device, cap) =>
      device.queueCapabilityCommand(cap, false)
    );
    this._registerOnoffAction('toggle_endpoint', (device, cap) => device.queueToggleCommand(cap));

    // Deprecated: no endpoint carries a dim capability after the blind remodel,
    // so this errors clearly instead of silently doing nothing.
    this._registerAction(
      'set_endpoint_dim',
      async args => {
        const dimCap = `dim.ep${args.endpoint.id}`;
        if (!args.device.hasCapability(dimCap)) {
          throw new Error('This panel has no dimmer endpoints; use the blind cards instead');
        }
        await args.device.queueCapabilityCommand(dimCap, args.level);
      },
      BLIND
    );

    // Blind actions map open -> up, close -> down, stop -> idle and trigger the
    // single windowcoverings_state listener (which is the one enqueue point).
    this._registerBlindAction('open_blind', 'up');
    this._registerBlindAction('close_blind', 'down');
    this._registerBlindAction('stop_blind', 'idle');
  }

  _registerOnoffAction(id, run) {
    this._registerAction(
      id,
      async args => {
        const cap = `onoff.ep${args.endpoint.id}`;
        if (!args.device.hasCapability(cap)) {
          throw new Error(`Endpoint ${args.endpoint.id} does not have an onoff capability`);
        }
        await run(args.device, cap);
      },
      SWITCH
    );
  }

  _registerBlindAction(id, state) {
    this._registerAction(
      id,
      async args => {
        const cap = `windowcoverings_state.ep${args.endpoint.id}`;
        if (!args.device.hasCapability(cap)) {
          throw new Error(`Endpoint ${args.endpoint.id} is not a blind`);
        }
        await args.device.triggerCapabilityListener(cap, state);
      },
      BLIND
    );
  }

  _registerAction(id, runListener, typeFilter = null) {
    const action = this.homey.flow.getActionCard(id);
    if (!action) return;

    action.registerRunListener(runListener);
    action.registerArgumentAutocompleteListener('endpoint', async (query, args) => {
      return args.device._getEndpointAutocompleteList(query, typeFilter);
    });
  }

  _registerConditionCards() {
    const isOnCondition = this.homey.flow.getConditionCard('endpoint_is_on');
    if (isOnCondition) {
      isOnCondition.registerRunListener(async args =>
        args.device._handleEndpointIsOn({ endpoint: args.endpoint })
      );
      isOnCondition.registerArgumentAutocompleteListener('endpoint', async (query, args) =>
        args.device._getEndpointAutocompleteList(query, SWITCH)
      );
    }

    // Deprecated dimmer condition; kept registered so the flow editor and
    // getConditionCard don't break. Its autocomplete lists no endpoints.
    const dimCompareCondition = this.homey.flow.getConditionCard('endpoint_dim_compare');
    if (dimCompareCondition) {
      dimCompareCondition.registerRunListener(async args =>
        args.device._handleEndpointDimCompare({
          endpoint: args.endpoint,
          comparison: args.comparison,
          level: args.level,
        })
      );
      dimCompareCondition.registerArgumentAutocompleteListener('endpoint', async (query, args) =>
        args.device._getEndpointAutocompleteList(query, BLIND)
      );
    }

    const blindStateCondition = this.homey.flow.getConditionCard('blind_state_is');
    if (blindStateCondition) {
      blindStateCondition.registerRunListener(async args =>
        args.device._handleBlindStateIs({ endpoint: args.endpoint, state: args.state })
      );
      blindStateCondition.registerArgumentAutocompleteListener('endpoint', async (query, args) =>
        args.device._getEndpointAutocompleteList(query, BLIND)
      );
    }
  }
}

module.exports = TouchWandApp;
