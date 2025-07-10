/**
 * @file This file contains the core business logic for the LSH Logic system.
 * The LshLogicService class orchestrates the various managers (`DeviceRegistryManager`, etc.)
 * and is completely decoupled from the Node-RED runtime. It returns descriptive
 * results (`ServiceResult`) rather than performing I/O actions itself.
 */

import { DeviceRegistryManager } from "./DeviceRegistryManager";
import { ClickTransactionManager } from "./ClickTransactionManager";
import { Watchdog } from "./Watchdog";
import {
    ClickType,
    LongClickConfig,
    DeviceConfigEntry,
    DeviceDetailsPayload,
    DeviceActuatorsStatePayload,
    AnyMiscTopicPayload,
    NetworkClickPayload,
    LshProtocol,
    Actor,
    ServiceResult,
    Output,
    OutputMessages,
} from "./types";
import { formatAlertMessage } from "./utils";
import { NodeMessage } from "node-red";
import { ValidateFunction } from "ajv";

/**
 * @internal
 * @description Defines the structure for a single route in the topic routing table.
 */
type TopicRoute = {
    regex: RegExp;
    handler: (deviceName: string, payload: any, parts: string[]) => ServiceResult;
};

/**
 * @internal
 * @description Collects actions to be performed at the end of a watchdog cycle.
 */
type WatchdogActions = {
    devicesToPing: Set<string>;
    unhealthyDevicesForAlert: Array<{ name: string; reason: string }>;
    stateChanged: boolean;
};

/**
 * @internal
 * @description Custom error for handling click validation failures gracefully.
 */
class ClickValidationError extends Error {
    constructor(
        public readonly reason: string,
        public readonly failoverType: "general" | "click"
    ) {
        super(reason);
        this.name = "ClickValidationError";
    }
}

/**
 * The main service class for LSH Logic. It contains all business logic and state,
 * but does not interact directly with Node-RED.
 */
export class LshLogicService {
    private readonly deviceManager: DeviceRegistryManager;
    private readonly clickManager: ClickTransactionManager;
    private readonly watchdog: Watchdog;

    private readonly lshBasePath: string;
    private readonly serviceTopic: string;
    private readonly validators: {
        validateDeviceDetails: ValidateFunction;
        validateActuatorStates: ValidateFunction;
        validateAnyMiscTopic: ValidateFunction;
    }

    private longClickConfig: LongClickConfig | null = null;
    private deviceConfigMap: Map<string, DeviceConfigEntry> = new Map();
    private readonly routes: TopicRoute[];

    /**
     * Constructs a new LshLogicService.
     * @param config - Core configuration values for the service.
     * @param otherActorsContext - A context reader for external device states.
     * @param validators - Pre-compiled AJV validation functions.
     */
    constructor(
        config: {
            lshBasePath: string;
            serviceTopic: string;
            otherDevicesPrefix: string;
            clickTimeout: number;
            interrogateThreshold: number;
            pingTimeout: number;
        },
        otherActorsContext: { get(key: string): any },
        validators: {
            validateDeviceDetails: ValidateFunction;
            validateActuatorStates: ValidateFunction;
            validateAnyMiscTopic: ValidateFunction;
        }
    ) {
        this.lshBasePath = config.lshBasePath;
        this.serviceTopic = config.serviceTopic;
        this.validators = validators;

        this.deviceManager = new DeviceRegistryManager(
            config.otherDevicesPrefix,
            otherActorsContext
        );
        this.clickManager = new ClickTransactionManager(config.clickTimeout);
        this.watchdog = new Watchdog(
            config.interrogateThreshold,
            config.pingTimeout
        );
        this.routes = this._createTopicRoutes();
    }

    /**
     * Creates an empty ServiceResult object to be populated.
     * @internal
     */
    private createEmptyResult(): ServiceResult {
        return {
            messages: {},
            logs: [],
            warnings: [],
            errors: [],
            stateChanged: false,
        };
    }

    /**
     * Processes an incoming message by matching its topic against the routing table.
     * @param topic - The MQTT topic of the message.
     * @param payload - The payload of the message.
     * @returns A ServiceResult describing the actions to be taken.
     */
    public processMessage(topic: string, payload: any): ServiceResult {
        if (!this.longClickConfig) {
            const result = this.createEmptyResult();
            result.warnings.push("Configuration not loaded, ignoring message.");
            return result;
        }

        for (const route of this.routes) {
            const match = topic.match(route.regex);
            if (match) {
                const deviceName = match[1];
                const otherParts = match.slice(2);
                this.watchdog.onDeviceActivity(deviceName);
                return route.handler(deviceName, payload, otherParts);
            }
        }
        const result = this.createEmptyResult();
        result.logs.push(`Message on unhandled topic: ${topic}`);
        return result;
    }

    /**
     * Updates the service's internal configuration.
     * @param newConfig - The new, validated LongClickConfig.
     * @returns A log message indicating the result.
     */
    public updateLongClickConfig(newConfig: LongClickConfig): string {
        this.longClickConfig = newConfig;
        this.deviceConfigMap.clear();

        const newDeviceNames = new Set(this.longClickConfig.devices.map((d) => d.name));
        for (const device of this.longClickConfig.devices) {
            this.deviceConfigMap.set(device.name, device);
        }

        const prunedDevices = [];
        for (const deviceName in this.deviceManager.getRegistry()) {
            if (!newDeviceNames.has(deviceName)) {
                this.deviceManager.pruneDevice(deviceName);
                prunedDevices.push(deviceName);
            }
        }
        let logMessage = "Long-click configuration successfully loaded and validated.";
        if (prunedDevices.length > 0) {
            logMessage += ` Pruned stale devices from registry: ${prunedDevices.join(", ")}.`;
        }
        return logMessage;
    }

    /**
     * Resets the configuration to null, typically on error.
     */
    public clearLongClickConfig(): void {
        this.longClickConfig = null;
        this.deviceConfigMap.clear();
    }

    /**
     * Gets the list of all configured device names.
     * @returns An array of device names or null if config is not loaded.
     */
    public getConfiguredDeviceNames(): string[] | null {
        return this.longClickConfig ? this.longClickConfig.devices.map((d) => d.name) : null;
    }

    /**
     * Returns a copy of the device registry.
     */
    public getDeviceRegistry() {
        return this.deviceManager.getRegistry();
    }

    /**
     * Runs the periodic watchdog check.
     * @returns A ServiceResult containing any pings or alerts to be sent.
     */
    public runWatchdogCheck(): ServiceResult {
        const result = this.createEmptyResult();
        if (!this.longClickConfig || this.longClickConfig.devices.length === 0) {
            return result;
        }

        const now = Date.now();
        const actions: WatchdogActions = {
            devicesToPing: new Set<string>(),
            unhealthyDevicesForAlert: [],
            stateChanged: false,
        };

        for (const deviceConfig of this.longClickConfig.devices) {
            const deviceName = deviceConfig.name;
            const deviceState = this.deviceManager.getDevice(deviceName);
            const healthResult = this.watchdog.checkDeviceHealth(deviceState, now);
            const { stateChanged } = this.deviceManager.updateHealthFromResult(deviceName, healthResult);
            if (stateChanged) actions.stateChanged = true;

            switch (healthResult.status) {
                case "needs_ping":
                    actions.devicesToPing.add(deviceName);
                    break;
                case "stale":
                    actions.unhealthyDevicesForAlert.push({ name: deviceName, reason: "No response to ping." });
                    actions.devicesToPing.add(deviceName);
                    break;
                case "unhealthy":
                    actions.unhealthyDevicesForAlert.push({ name: deviceName, reason: healthResult.reason });
                    break;
            }
        }

        result.stateChanged = actions.stateChanged;
        if (actions.devicesToPing.size > 0) {
            const { messages, logs } = this._preparePings(actions);
            Object.assign(result.messages, messages);
            result.logs.push(...logs);
        }
        if (actions.unhealthyDevicesForAlert.length > 0) {
            const { messages } = this._prepareAlerts(actions);
            Object.assign(result.messages, messages);
        }
        return result;
    }

    /**
     * Cleans up expired click transactions.
     * @returns A log message if any transactions were cleaned.
     */
    public cleanupPendingClicks(): string | null {
        const cleanedCount = this.clickManager.cleanupExpired();
        return cleanedCount > 0 ? `Cleaned up ${cleanedCount} expired click transactions.` : null;
    }

    /**
     * @internal
     * @description Creates and returns the topic routing table.
     */
    private _createTopicRoutes(): TopicRoute[] {
        return [
            {
                regex: new RegExp(`^${this.lshBasePath}([^/]+)/(conf)$`),
                handler: (deviceName, payload) => {
                    const result = this.createEmptyResult();
                    if (!this.validators.validateDeviceDetails(payload)) {
                        const errorText = this.validators.validateDeviceDetails.errors?.map(e => e.message).join(', ') || 'unknown error';
                        result.warnings.push(`Invalid 'conf' payload from ${deviceName}: ${errorText}`);
                        return result;
                    }
                    const { changed } = this.deviceManager.registerDeviceDetails(deviceName, payload as DeviceDetailsPayload);
                    if (changed) {
                        result.logs.push(`Stored/Updated details for device '${deviceName}'.`);
                        result.stateChanged = true;
                    }
                    return result;
                },
            },
            {
                regex: new RegExp(`^${this.lshBasePath}([^/]+)/(state)$`),
                handler: (deviceName, payload) => {
                    const result = this.createEmptyResult();
                    if (!this.validators.validateActuatorStates(payload)) {
                        const errorText = this.validators.validateActuatorStates.errors?.map(e => e.message).join(', ') || 'unknown error';
                        result.warnings.push(`Invalid 'state' payload from ${deviceName}: ${errorText}`);
                        return result;
                    }
                    try {
                        const { isNew, changed } = this.deviceManager.registerActuatorStates(deviceName, (payload as DeviceActuatorsStatePayload).as);
                        if (isNew) result.logs.push(`Received state for a new device: ${deviceName}. Creating partial entry.`);
                        if (changed) {
                            result.logs.push(`Updated state for '${deviceName}': [${(payload as DeviceActuatorsStatePayload).as.join(", ")}]`);
                            result.stateChanged = true;
                        }
                    } catch (error) {
                        result.errors.push(error instanceof Error ? error.message : String(error));
                    }
                    return result;
                },
            },
            {
                regex: new RegExp(`^${this.lshBasePath}([^/]+)/(misc)$`),
                handler: (deviceName, payload) => {
                    if (!this.validators.validateAnyMiscTopic(payload)) {
                        const result = this.createEmptyResult();
                        const errorText = this.validators.validateAnyMiscTopic.errors?.map(e => e.message).join(', ') || 'unknown error';
                        result.warnings.push(`Invalid 'misc' payload from ${deviceName}: ${errorText}`);
                        return result;
                    }
                    // We use a type assertion now that validation has passed.
                    const miscPayload = payload as AnyMiscTopicPayload;
                    const result = this.createEmptyResult();

                    switch (miscPayload.p) {
                        case LshProtocol.NETWORK_CLICK:
                            return this.handleNetworkClick(deviceName, miscPayload);
                        case LshProtocol.DEVICE_BOOT:
                            result.logs.push(`Device '${deviceName}' reported a boot event.`);
                            if (this.deviceManager.recordBoot(deviceName).stateChanged) {
                                result.stateChanged = true;
                            }
                            break;
                        case LshProtocol.PING:
                            if (this.deviceManager.recordPingResponse(deviceName).stateChanged) {
                                result.logs.push(`Device '${deviceName}' is now responsive.`);
                                result.stateChanged = true;
                            } else {
                                result.logs.push(`Received ping response from '${deviceName}'.`);
                            }
                            break;
                    }
                    return result;
                },
            },
        ];
    }

    /**
      * Orchestrates the two-phase commit protocol for "Network Clicks".
      */
    private handleNetworkClick(deviceName: string, payload: NetworkClickPayload): ServiceResult {
        if (payload.c) { // isConfirmation
            return this._processClickConfirmation(deviceName, payload);
        } else {
            return this._processNewClickRequest(deviceName, payload);
        }
    }

    /**
     * @internal
     * @description Processes the first phase of a network click: a new request.
     */
    private _processNewClickRequest(deviceName: string, payload: NetworkClickPayload): ServiceResult {
        const result = this.createEmptyResult();
        const { bi: buttonId, ct: clickType } = payload;
        const transactionKey = `${deviceName}.${buttonId}.${clickType}`;
        const commandTopic = `${this.lshBasePath}${deviceName}/IN`;

        try {
            const { actors, otherActors } = this._validateClickRequest(deviceName, buttonId, clickType);
            this.clickManager.startTransaction(transactionKey, actors, otherActors);

            result.messages[Output.Lsh] = {
                topic: commandTopic,
                payload: { p: LshProtocol.NETWORK_CLICK_ACK, ct: clickType, bi: buttonId },
            };
            result.logs.push(`Validation OK for ${transactionKey}. Sending ACK.`);
        } catch (error) {
            if (error instanceof ClickValidationError) {
                if (error.failoverType === 'general') {
                    result.errors.push(`System failure on click ${transactionKey}: ${error.reason}. Sending General Failover (c_gf).`);
                    result.messages[Output.Lsh] = { topic: commandTopic, payload: { p: LshProtocol.GENERAL_FAILOVER } };
                } else {
                    result.warnings.push(`Click validation failed for ${transactionKey}: ${error.reason}. Sending Click Failover (c_f).`);
                    result.messages[Output.Lsh] = { topic: commandTopic, payload: { p: LshProtocol.FAILOVER, ct: clickType, bi: buttonId } };
                }
            } else {
                result.errors.push(`Unexpected error during click processing for ${transactionKey}: ${error}`);
            }
        }
        return result;
    }

    /**
     * @internal
     * @description Processes the second phase of a network click: a confirmation.
     */
    private _processClickConfirmation(deviceName: string, payload: NetworkClickPayload): ServiceResult {
        const result = this.createEmptyResult();
        const { bi: buttonId, ct: clickType } = payload;
        const transactionKey = `${deviceName}.${buttonId}.${clickType}`;

        const transaction = this.clickManager.consumeTransaction(transactionKey);
        if (!transaction) {
            result.warnings.push(`Received confirmation for an expired or unknown click: ${transactionKey}.`);
            return result;
        }

        result.logs.push(`Click confirmed for ${transactionKey}. Executing logic.`);
        const logicResult = this.executeClickLogic(transaction.actors, transaction.otherActors, clickType);

        Object.assign(result.messages, logicResult.messages);
        result.logs.push(...logicResult.logs);
        result.warnings.push(...logicResult.warnings);

        return result;
    }

    /**
     * @internal
     * @description Validates a new network click request against the current system state and configuration.
     * This method uses guard clauses and throws a `ClickValidationError` on failure.
     * @returns An object with the validated actors if successful.
     * @throws {ClickValidationError} If the validation fails for any reason.
     */
    private _validateClickRequest(deviceName: string, buttonId: string, clickType: ClickType): { actors: Actor[]; otherActors: string[] } {
        if (!this.longClickConfig) {
            throw new ClickValidationError("longClickConfig is not loaded.", "general");
        }

        const deviceConfig = this.deviceConfigMap.get(deviceName);
        const clickTypeKey =
            clickType === ClickType.Long ? "longClickButtons" : "superLongClickButtons";
        const buttonConfig = deviceConfig?.[clickTypeKey]?.find(
            (btn) => btn.id === buttonId
        );
        if (!buttonConfig) throw new ClickValidationError("No action configured for this button.", "click");

        const { actors = [], otherActors = [] } = buttonConfig;
        if (actors.length === 0 && otherActors.length === 0) throw new ClickValidationError("Action configured with no targets.", "click");

        const offlineActors = actors.filter((actor) => !this.deviceManager.getDevice(actor.name)?.connected);
        if (offlineActors.length > 0) {
            const names = offlineActors.map((a) => a.name).join(", ");
            throw new ClickValidationError(`Target actor(s) are offline: ${names}.`, "click");
        }

        return { actors, otherActors };
    }

    /**
     * Orchestrates the execution of a confirmed click action.
     * Sends LSH commands to output 1 and other actor commands to output 2.
     * @param actors - The primary target actors (LSH).
     * @param otherActors - The secondary target actors (external).
     * @param clickType - The type of click ('lc' or 'slc').
     */
    private executeClickLogic(actors: Actor[], otherActors: string[], clickType: ClickType): Pick<ServiceResult, 'messages' | 'logs' | 'warnings'> {
        const result: Pick<ServiceResult, 'messages' | 'logs' | 'warnings'> = { messages: {}, logs: [], warnings: [] };
        let stateToSet: boolean;

        if (clickType === ClickType.SuperLong) {
            stateToSet = false;
            result.logs.push("Executing SLC logic: setting state to OFF.");
        } else {
            const toggleResult = this.deviceManager.getSmartToggleState(actors, otherActors);
            if (toggleResult.warning) result.warnings.push(toggleResult.warning);
            result.logs.push(`Smart Toggle: ${toggleResult.active}/${toggleResult.total} active. Decision: ${toggleResult.stateToSet ? "ON" : "OFF"}`);
            stateToSet = toggleResult.stateToSet;
        }

        const lshCommands = this.buildStateCommands(actors, stateToSet);
        if (lshCommands.length > 0) {
            result.messages[Output.Lsh] = lshCommands;
        }

        if (otherActors.length > 0) {
            result.messages[Output.OtherActors] = {
                otherActors,
                stateToSet,
                payload: `Set state=${stateToSet} for external actors.`,
            };
        }
        return result;
    }

    /**
     * Prepares MQTT messages to set the state of actuators.
     */
    private buildStateCommands(actors: Actor[], stateToSet: boolean): NodeMessage[] {
        const commands: NodeMessage[] = [];
        for (const actor of actors) {
            const device = this.deviceManager.getDevice(actor.name);
            if (!device) continue;

            const commandTopic = `${this.lshBasePath}${actor.name}/IN`;
            const isSingleSpecificActuator = !actor.allActuators && actor.actuators.length === 1;

            if (isSingleSpecificActuator) {
                commands.push({
                    topic: commandTopic,
                    payload: { p: LshProtocol.APPLY_SINGLE_ACTUATOR_STATE, ai: actor.actuators[0], as: stateToSet },
                });
            } else {
                const newState = [...device.actuatorStates];
                if (actor.allActuators) {
                    newState.fill(stateToSet);
                } else {
                    for (const actuatorId of actor.actuators) {
                        const index = device.actuatorIndexes[actuatorId];
                        if (index !== undefined) newState[index] = stateToSet;
                    }
                }
                commands.push({
                    topic: commandTopic,
                    payload: { p: LshProtocol.APPLY_ALL_ACTUATORS_STATE, as: newState },
                });
            }
        }
        return commands;
    }

    /**
     * @internal
     * @description Prepares ping commands for a list of devices. The adapter will handle sending.
     */
    private _preparePings(actions: WatchdogActions): { messages: OutputMessages, logs: string[] } {
        const messages: OutputMessages = {};
        const logs: string[] = [];
        const devicesToPing = Array.from(actions.devicesToPing);
        const totalConfiguredDevices = this.longClickConfig!.devices.length;

        if (devicesToPing.length === totalConfiguredDevices) {
            logs.push(`All ${totalConfiguredDevices} devices are silent. Preparing a single broadcast ping.`);
            messages[Output.Lsh] = { topic: this.serviceTopic, payload: { p: LshProtocol.PING } };
        } else {
            logs.push(`Preparing staggered pings for ${devicesToPing.length} device(s)...`);
            const pingCommands: NodeMessage[] = devicesToPing.map(deviceName => ({
                topic: `${this.lshBasePath}${deviceName}/IN`,
                payload: { p: LshProtocol.PING }
            }));
            messages[Output.Lsh] = pingCommands;
        }
        return { messages, logs };
    }

    /**
     * @internal
     * @description Formats and prepares an alert message for unhealthy devices.
     */
    private _prepareAlerts(actions: WatchdogActions): { messages: OutputMessages } {
        return {
            messages: {
                [Output.Alerts]: { payload: formatAlertMessage(actions.unhealthyDevicesForAlert) },
            }
        };
    }
}