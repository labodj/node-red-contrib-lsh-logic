import { NodeMessage } from "node-red";
import { ServiceResult, Output } from "./types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../package.json");

/**
 * State definitions for the Homie Discovery Manager.
 */
interface DeviceDiscoveryState {
    mac?: string;
    fw_version?: string;
    nodes?: string[];
    last_config_hash?: string;
}

/**
 * Manages the conversion of Homie devices to Home Assistant AutoDiscovery payloads.
 * Incorporates state management, idempotency checks, and payload generation.
 */
export class HomieDiscoveryManager {
    private readonly discoveryState: Map<string, DeviceDiscoveryState> = new Map();

    private static readonly SENSORS_DEF = [
        { name: "MAC Address", topic: "$mac", icon: "mdi:ethernet", cat: "diagnostic" },
        { name: "Local IP", topic: "$localip", icon: "mdi:ip-network", cat: "diagnostic" },
        { name: "Homie Version", topic: "$homie", icon: "mdi:tag", cat: "diagnostic" },
        { name: "Firmware Version", topic: "$fw/version", icon: "mdi:cellphone-arrow-down", cat: "diagnostic" },
        { name: "Firmware Name", topic: "$fw/name", icon: "mdi:label", cat: "diagnostic" },
        { name: "Firmware Checksum", topic: "$fw/checksum", icon: "mdi:shield-check-outline", cat: "diagnostic" },
        { name: "Uptime", topic: "$stats/uptime", icon: "mdi:timer-sand", class: "duration", unit: "s", cat: "diagnostic", state_class: "measurement" },
        { name: "WiFi Uptime", topic: "$stats/uptimewifi", icon: "mdi:wifi-clock", class: "duration", unit: "s", cat: "diagnostic", state_class: "measurement" },
        { name: "MQTT Uptime", topic: "$stats/uptimemqtt", icon: "mdi:network-outline-clock", class: "duration", unit: "s", cat: "diagnostic", state_class: "measurement" },
        { name: "Signal Strength", topic: "$stats/signal", icon: "mdi:wifi", unit: "%", cat: "diagnostic", state_class: "measurement" },
        { name: "Free Heap", topic: "$stats/freeheap", icon: "mdi:memory", class: "data_size", unit: "B", cat: "diagnostic", state_class: "measurement" },
        { name: "Stats Interval", topic: "$stats/interval", icon: "mdi:timer-sync-outline", unit: "s", cat: "diagnostic", state_class: "measurement" },
        { name: "Implementation", topic: "$implementation", icon: "mdi:code-braces", cat: "diagnostic" },
        { name: "Implementation Version", topic: "$implementation/version", icon: "mdi:tag-outline", cat: "diagnostic" },
        { name: "Implementation Config", topic: "$implementation/config", icon: "mdi:code-json", cat: "diagnostic" },
        { name: "OTA Status", topic: "$implementation/ota/status", icon: "mdi:update", cat: "diagnostic" }
    ];

    private static readonly BINARY_SENSORS_DEF = [
        { name: "OTA Enabled", topic: "$implementation/ota/enabled", icon: "mdi:cellphone-arrow-down-cog", cat: "diagnostic" }
    ];

    constructor(
        private readonly homieBasePath: string,
        private readonly discoveryPrefix: string = "homeassistant"
    ) { }

    /**
     * Processes incoming Homie attribute messages to build up device state
     * and generate discovery payloads when ready.
     */
    public processDiscoveryMessage(
        deviceId: string,
        topicSuffix: string,
        payload: string
    ): ServiceResult {
        const result: ServiceResult = {
            messages: {},
            logs: [],
            warnings: [],
            errors: [],
            stateChanged: false,
        };

        const deviceData = this.getOrCreateDeviceData(deviceId);
        const updated = this.updateDeviceData(deviceData, topicSuffix, payload);

        if (updated && this.isDeviceReady(deviceData)) {
            const newConfigHash = this.computeConfigHash(deviceData);

            if (newConfigHash !== deviceData.last_config_hash) {
                const discoveryMessages = this.generateDiscoveryPayloads(deviceId, deviceData);
                result.messages[Output.Lsh] = discoveryMessages;
                result.logs.push(`Generated HA discovery config for ${deviceId} (${discoveryMessages.length} entities)`);
                deviceData.last_config_hash = newConfigHash;
            } else {
                result.logs.push(`Discovery config for ${deviceId} is up-to-date.`);
            }
        }

        return result;
    }

    /**
     * Retrieves existing state for a device or creates a new one.
     * @param deviceId - The device identifier.
     * @returns The discovery state object for the device.
     */
    private getOrCreateDeviceData(deviceId: string): DeviceDiscoveryState {
        let deviceData = this.discoveryState.get(deviceId);
        if (!deviceData) {
            deviceData = {};
            this.discoveryState.set(deviceId, deviceData);
        }
        return deviceData;
    }

    /**
     * Updates the device state based on the incoming topic suffix and payload.
     * @param data - The mutable device state object.
     * @param topicSuffix - The specific Homie attribute being updated (e.g., '/$mac').
     * @param payload - The new value for the attribute.
     * @returns True if the state was updated, false otherwise.
     */
    private updateDeviceData(data: DeviceDiscoveryState, topicSuffix: string, payload: string): boolean {
        switch (topicSuffix) {
            case "/$mac":
                if (data.mac !== payload) {
                    data.mac = payload;
                    return true;
                }
                break;
            case "/$fw/version":
                if (data.fw_version !== payload) {
                    data.fw_version = payload;
                    return true;
                }
                break;
            case "/$nodes":
                const newNodes = payload.split(",");
                if (!this.areNodesEqual(data.nodes, newNodes)) {
                    data.nodes = newNodes;
                    return true;
                }
                break;
        }
        return false;
    }

    /**
     * Compares two arrays of node strings for equality.
     * @param oldNodes - The existing array of nodes.
     * @param newNodes - The new array of nodes.
     * @returns True if both arrays contain the same strings in the same order.
     */
    private areNodesEqual(oldNodes: string[] | undefined, newNodes: string[]): boolean {
        if (!oldNodes) return false;
        if (oldNodes.length !== newNodes.length) return false;
        return oldNodes.every((val, index) => val === newNodes[index]);
    }

    /**
     * Checks if all required properties (mac, fw_version, nodes) are present.
     * @param data - The device state to check.
     * @returns True if the device is ready for discovery generation.
     */
    private isDeviceReady(data: DeviceDiscoveryState): boolean {
        return !!(data.mac && data.fw_version && data.nodes);
    }

    /**
     * Computes a simple hash string to detect changes in the device configuration.
     * @param data - The device state.
     * @returns A string representation of the configuration state.
     */
    private computeConfigHash(data: DeviceDiscoveryState): string {
        return `${data.mac}|${data.fw_version}|${data.nodes?.join(',')}`;
    }

    /**
     * Main orchestrator for generating all discovery messages for a device.
     * @param deviceId - The device identifier.
     * @param data - The complete device state.
     * @returns An array of NodeMessage objects suitable for MQTT publishing.
     */
    private generateDiscoveryPayloads(deviceId: string, data: DeviceDiscoveryState): NodeMessage[] {
        const baseDevice = {
            name: `LSH ${deviceId.toUpperCase()}`,
            manufacturer: "Jacopo Labardi",
            identifiers: [`LSH_${deviceId}`],
            model: "Labo Smart Home",
            connections: [["mac", data.mac]],
            sw_version: data.fw_version
        };

        const baseTopic = `${this.homieBasePath}${deviceId}`;
        const deviceParams = { deviceId, baseTopic, baseDevice };

        return [
            ...this.generateLights(data.nodes || [], deviceParams),
            ...this.generateSensors(deviceParams),
            ...this.generateBinarySensors(deviceParams)
        ];
    }

    /**
     * Generates discovery payloads for 'Light' entities based on the device's nodes.
     * @param nodes - List of node names (e.g., 'light1', 'light2').
     * @param ctx - Context object containing deviceId, baseTopic, and baseDevice definition.
     * @returns Array of discovery messages.
     */
    private generateLights(nodes: string[], { deviceId, baseTopic, baseDevice }: any): NodeMessage[] {
        return nodes.map(node => {
            if (!node) return null;
            const uniqueId = `lsh_${deviceId.toLowerCase()}_${node.toLowerCase()}`;
            return {
                topic: `${this.discoveryPrefix}/light/${uniqueId}/config`,
                payload: {
                    name: `${deviceId.toUpperCase()} ${node.toUpperCase()}`,
                    unique_id: uniqueId,
                    default_entity_id: `light.${uniqueId}`,
                    origin: {
                        name: "node-red-contrib-lsh-logic",
                        sw_version: packageJson.version,
                        url: "https://github.com/labodj/node-red-contrib-lsh-logic"
                    },
                    "~": baseTopic,
                    device: baseDevice,
                    state_topic: `~/${node}/state`,
                    command_topic: `~/${node}/state/set`,
                    payload_on: "true",
                    payload_off: "false",
                    availability_topic: "~/$state",
                    payload_available: "ready",
                    payload_not_available: "lost",
                    qos: 2
                },
                qos: 1, retain: true
            };
        }).filter(Boolean) as NodeMessage[];
    }

    /**
     * Generates discovery payloads for standard diagnostic 'Sensor' entities.
     * @param ctx - Context object containing deviceId, baseTopic, and baseDevice definition.
     * @returns Array of discovery messages.
     */
    private generateSensors({ deviceId, baseTopic, baseDevice }: any): NodeMessage[] {
        return HomieDiscoveryManager.SENSORS_DEF.map(s => this.buildPayload(deviceId, baseTopic, baseDevice, "sensor", s));
    }

    /**
     * Generates discovery payloads for 'Binary Sensor' entities.
     * @param ctx - Context object containing deviceId, baseTopic, and baseDevice definition.
     * @returns Array of discovery messages.
     */
    private generateBinarySensors({ deviceId, baseTopic, baseDevice }: any): NodeMessage[] {
        return HomieDiscoveryManager.BINARY_SENSORS_DEF.map(bs => this.buildPayload(deviceId, baseTopic, baseDevice, "binary_sensor", bs, {
            payload_on: "true", payload_off: "false"
        }));
    }

    /**
     * Helper to construct a single Home Assistant discovery message.
     * @param deviceId - The device identifier.
     * @param baseTopic - The base Homie topic for the device.
     * @param baseDevice - The universal device configuration block.
     * @param type - The component type (e.g., 'sensor', 'light').
     * @param def - The definition object for the specific entity.
     * @param extras - Additional payload properties to merge.
     * @returns A complete NodeMessage.
     */
    private buildPayload(deviceId: string, baseTopic: string, baseDevice: any, type: string, def: any, extras: any = {}): NodeMessage {
        const nameLc = def.name.toLowerCase().replace(/ /g, '_');
        const uniqueId = `lsh_${deviceId.toLowerCase()}_${nameLc}`;

        const payload: any = {
            name: `${deviceId.toUpperCase()} ${def.name}`,
            unique_id: uniqueId,
            default_entity_id: `${type}.${uniqueId}`,
            origin: {
                name: "node-red-contrib-lsh-logic",
                sw_version: packageJson.version,
                url: "https://github.com/labodj/node-red-contrib-lsh-logic"
            },
            "~": baseTopic,
            device: baseDevice,
            state_topic: `~/${def.topic}`,
            availability_topic: "~/$state",
            payload_available: "ready",
            payload_not_available: "lost",
            icon: def.icon,
            entity_category: def.cat,
            qos: 2,
            ...extras
        };

        if (def.class) payload.device_class = def.class;
        if (def.unit) payload.unit_of_measurement = def.unit;
        if (def.state_class) payload.state_class = def.state_class;

        return {
            topic: `${this.discoveryPrefix}/${type}/${uniqueId}/config`,
            payload: payload,
            qos: 1, retain: true
        };
    }
}
