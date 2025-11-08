'use strict';

const Homey = require('homey');

class TouchWandApp extends Homey.App {
  async onInit() {
    this.log('TouchWand app has been initialized');
    this._registerActionCards();
    this._registerConditionCards();
  }

  _registerActionCards() {
    this._registerAction('turn_endpoint_on', async args => {
      const cap = `onoff.ep${args.endpoint.id}`;
      if (!args.device.hasCapability(cap)) {
        throw new Error(`Endpoint ${args.endpoint.id} does not have an onoff capability`);
      }
      await args.device.queueCapabilityCommand(cap, true);
    });

    this._registerAction('turn_endpoint_off', async args => {
      const cap = `onoff.ep${args.endpoint.id}`;
      if (!args.device.hasCapability(cap)) {
        throw new Error(`Endpoint ${args.endpoint.id} does not have an onoff capability`);
      }
      await args.device.queueCapabilityCommand(cap, false);
    });

    this._registerAction('toggle_endpoint', async args => {
      const cap = `onoff.ep${args.endpoint.id}`;
      if (!args.device.hasCapability(cap)) {
        throw new Error(`Endpoint ${args.endpoint.id} does not have an onoff capability`);
      }
      const currentState = args.device.getCapabilityValue(cap);
      await args.device.queueCapabilityCommand(cap, !currentState);
    });

    this._registerAction(
      'set_endpoint_dim',
      async args => {
        const dimCap = `dim.ep${args.endpoint.id}`;
        const onoffCap = `onoff.ep${args.endpoint.id}`;

        if (!args.device.hasCapability(dimCap)) {
          throw new Error(`Endpoint ${args.endpoint.id} does not have a dim capability`);
        }

        await args.device.queueCapabilityCommand(dimCap, args.level);

        if (args.device.hasCapability(onoffCap)) {
          await args.device.queueCapabilityCommand(onoffCap, args.level > 0);
        }
      },
      true
    );
  }

  _registerAction(id, runListener, onlyDimmers = false) {
    const action = this.homey.flow.getActionCard(id);
    if (!action) return;

    action.registerRunListener(runListener);
    action.registerArgumentAutocompleteListener('endpoint', async (query, args) => {
      return args.device._getEndpointAutocompleteList(query, onlyDimmers);
    });
  }

  _registerConditionCards() {
    const isOnCondition = this.homey.flow.getConditionCard('endpoint_is_on');
    if (isOnCondition) {
      isOnCondition.registerRunListener(async args =>
        args.device._handleEndpointIsOn({ endpoint: args.endpoint })
      );
      isOnCondition.registerArgumentAutocompleteListener('endpoint', async (query, args) =>
        args.device._getEndpointAutocompleteList(query)
      );
    }

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
        args.device._getEndpointAutocompleteList(query, true)
      );
    }
  }
}

module.exports = TouchWandApp;
