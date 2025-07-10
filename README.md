# Node-RED Contrib LSH Logic

[![NPM version](https://badge.fury.io/js/node-red-contrib-lsh-logic.svg)](https://badge.fury.io/js/node-red-contrib-lsh-logic)
[![Build Status](https://github.com/labodj/node-red-contrib-lsh-logic/actions/workflows/ci.yaml/badge.svg)](https://github.com/labodj/node-red-contrib-lsh-logic/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

A single, powerful Node-RED node to manage advanced automation logic for an LSH (Labo Smart Home) style system. Built with TypeScript for maximum reliability.

This node replaces a complex flow of function nodes with a single, robust, and stateful component that manages device state, implements advanced click logic, and monitors device health.

![Node Appearance](images/node-appearance.png)

---

## Key Features

- **Dynamic Configuration**: Loads and validates a `longClickConfig.json` file from your Node-RED user directory and reloads it automatically on changes.
- **Centralized State Management**: Maintains an in-memory registry of all device states, health, and configurations, which can be exported to the context for easy debugging and dashboarding.
- **Advanced Click Logic**: Implements "long-click" (smart toggle) and "super-long-click" (turn all off) actions across multiple devices.
- **Reliable Network Protocol**: Uses a two-phase commit protocol for network-based button clicks to ensure commands are not lost, even on unreliable networks.
- **Intelligent Watchdog**: Actively monitors device health with a multi-stage ping mechanism to prevent false positives and generates human-readable alerts for unresponsive devices.
- **Dynamic Topic Generation**: Can export the required MQTT topic lists to a context variable, enabling auto-configuration of `MQTT-in` nodes.

## Installation

You can install the node directly from the Node-RED **Palette Manager**.

Alternatively, run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install node-red-contrib-lsh-logic
```

## How It Works

This node is designed to be the central brain of your LSH-style home automation system. It listens for all relevant MQTT messages from your devices, processes them according to your configuration, and sends back commands.

### Inputs

The node subscribes to two main types of MQTT topics. The base paths for these topics are configured in the node's settings.

1. **LSH Protocol Topics**:
    - `<lshBasePath>/<device-name>/conf`: For receiving a device's static configuration (actuator IDs, button IDs).
    - `<lshBasePath>/<device-name>/state`: For receiving the current state of a device's actuators.
    - `<lshBasePath>/<device-name>/misc`: For miscellaneous events like network clicks, boot notifications, and ping responses.

2. **Homie Convention Topics**:
    - `<homieBasePath>/<device-name>/$state`: For monitoring the online/offline status of devices.

### Outputs

The node has four distinct outputs for clear and organized flows:

1. **LSH Commands**: Publishes messages to control your LSH devices. This includes actuator state commands (`c_aas`, `c_asas`), network click acknowledgements (`d_nca`), failover signals (`c_f`, `c_gf`), and watchdog pings.
2. **Other Actor Commands**: Publishes generic commands for non-LSH devices (e.g., Tasmota, Zigbee2MQTT). The output message contains the desired state (`true`/`false`) and a list of actor names, allowing you to route them accordingly.
3. **Alerts**: Outputs formatted, human-readable alert messages (e.g., for Telegram or other notification services) when a device becomes unresponsive.
4. **Debug**: Forwards the original, unprocessed input message for logging and debugging purposes.

## Configuration

### Node Settings

The node's behavior is customized through the editor panel, which includes:

- **MQTT Path Settings**: Define the base paths for your Homie and LSH topics.
- **Configuration File**: Path to your `longClickConfig.json` file, relative to the Node-RED user directory.
- **Context Interaction**: Configure how the node's internal state, configuration, and MQTT topic lists are exposed to the flow/global context. This is extremely useful for creating dashboards or dynamically configuring other nodes.
- **Timing Settings**: Fine-tune all system timeouts and intervals, such as the watchdog frequency and network click confirmation window, to adapt to your network conditions.

### `longClickConfig.json`

This is the core configuration file that defines your devices and their button actions. It should be placed in your Node-RED user directory (e.g., in a `configs/` subfolder). The file is automatically reloaded and re-validated if you make any changes.

```json
{
  "devices": [
    {
      // The unique MQTT name of the device sending the clicks.
      "name": "living-room-switch",
      "longClickButtons": [
        {
          // The button ID reported by the device (e.g., "B1", "B2").
          "id": "B1",
          // A list of LSH devices to control.
          "actors": [
            {
              // The target device's name.
              "name": "living-room-ceiling-light",
              // If true, control all actuators on this target.
              "allActuators": true,
              "actuators": []
            }
          ],
          // A list of non-LSH devices (e.g., Tasmota, Zigbee) to control via Output 2.
          "otherActors": [
            "tasmota_living_room_lamp"
          ]
        }
      ],
      "superLongClickButtons": [
        {
          "id": "B1",
          // A super-long-click on this button will turn off all these devices.
          "actors": [
            { "name": "living-room-ceiling-light", "allActuators": true, "actuators": [] },
            { "name": "kitchen-light", "allActuators": true, "actuators": [] }
          ],
          "otherActors": [
            "tasmota_living_room_lamp",
            "zigbee_kitchen_strip"
          ]
        }
      ]
    },
    {
      // This device is only an actor (it gets controlled), it doesn't send clicks.
      // It must be listed here for the system to be aware of it for health checks.
      "name": "living-room-ceiling-light",
      "longClickButtons": [],
      "superLongClickButtons": []
    },
    {
      "name": "kitchen-light",
      "longClickButtons": [],
      "superLongClickButtons": []
    }
  ]
}
```

- **`devices`**: An array of all devices in your system.
- **`name`**: The unique MQTT name of the device.
- **`longClickButtons` / `superLongClickButtons`**: Arrays defining actions for different click types.
  - `id`: The button identifier (e.g., "B1", "B2") sent by the device.
  - `actors`: An array of LSH devices to control.
    - `name`: The target device's name.
    - `allActuators`: If `true`, control all actuators on the device.
    - `actuators`: If `allActuators` is `false`, provide a list of specific actuator IDs to control.
    - `otherActors`: An array of strings representing non-LSH devices to control via Output 2.

## Contributing

Contributions are welcome! If you'd like to contribute, please feel free to open an issue to discuss a new feature or bug, or submit a pull request.

### Development Setup

To set up the development environment:

1. Clone the repository.
2. Run `npm install` to install all dependencies.
3. Run `npm run dev:build` to build the project.
4. Run `npm run test:watch` to run tests in watch mode as you make changes.

## License

This project is licensed under the [Apache 2.0 License](./LICENSE).
