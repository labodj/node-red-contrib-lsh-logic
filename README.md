# Node-RED Contrib LSH Logic

[![npm](https://img.shields.io/npm/v/node-red-contrib-lsh-logic.svg)](https://www.npmjs.com/package/node-red-contrib-lsh-logic)
[![Node-RED Library](https://img.shields.io/badge/Node--RED-Library-8f0000.svg)](https://flows.nodered.org/node/node-red-contrib-lsh-logic)
[![npm downloads](https://img.shields.io/npm/dm/node-red-contrib-lsh-logic.svg)](https://www.npmjs.com/package/node-red-contrib-lsh-logic)
[![CI](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Flabodj%2Fnode-red-contrib-lsh-logic%2Factions%2Fworkflows%2Fci.yaml%2Fruns%3Fper_page%3D1&query=%24.workflow_runs%5B0%5D.conclusion&label=CI)](https://github.com/labodj/node-red-contrib-lsh-logic/actions/workflows/ci.yaml)
[![Latest Release](https://img.shields.io/github/release/labodj/node-red-contrib-lsh-logic.svg)](https://github.com/labodj/node-red-contrib-lsh-logic/releases/latest)
[![License](https://img.shields.io/github/license/labodj/node-red-contrib-lsh-logic.svg)](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/LICENSE)

[![works with MQTT Homie](https://homieiot.github.io/img/works-with-homie.svg "works with MQTT Homie")](https://homieiot.github.io/)

`node-red-contrib-lsh-logic` is the Node-RED runtime brain for an LSH-compatible
smart home.

It listens to the public LSH MQTT/protocol contract, keeps an authoritative live
device registry, coordinates distributed long-click actions, emits commands,
tracks bridge/controller health and raises useful alerts when something goes
stale or comes back.

The original installation uses Controllino controllers and ESP32 bridges, but
the important boundary is the **LSH protocol contract**, not the exact hardware.
If another controller/bridge stack speaks the same MQTT topics and payloads,
this node is designed to run the same orchestration layer.

![Node Appearance](https://raw.githubusercontent.com/labodj/node-red-contrib-lsh-logic/main/images/node-appearance.png)

## When This Node Is the Right Tool

Use this node when you have devices that speak the LSH protocol and you want
Node-RED to own the orchestration layer:

- keep track of configured devices and actuator state;
- react to button events and long-click actions;
- send commands to one or more LSH devices;
- coordinate external actors such as Zigbee, Tasmota or custom flows;
- monitor device health and emit alert messages;
- recover cleanly after Node-RED, bridge or controller restarts.

Do not use it as a generic MQTT automation node for unrelated devices. If a
device does not speak the LSH contract, control it from the **Other Actor
Commands** output or from a separate Node-RED flow.

If you are new to the public LSH stack, these landing docs are the best first
read:

- [LSH reference stack](https://github.com/labodj/labo-smart-home/blob/main/REFERENCE_STACK.md)
- [LSH glossary](https://github.com/labodj/labo-smart-home/blob/main/GLOSSARY.md)
- [Getting started](https://github.com/labodj/labo-smart-home/blob/main/GETTING_STARTED.md)
- [Troubleshooting](https://github.com/labodj/labo-smart-home/blob/main/TROUBLESHOOTING.md)

## The Flow in One Picture

The normal flow is intentionally small:

1. `mqtt in` feeds LSH and Homie lifecycle messages into `lsh-logic`.
2. Output 1 goes to `mqtt out` for LSH commands.
3. Output 2 goes to your external actor flow.
4. Output 3 goes to notifications or a debug node.
5. Output 4 loops back to the same `mqtt in` node for dynamic subscriptions.
6. Output 5 goes to debug while developing.

![Dynamic MQTT Flow](https://raw.githubusercontent.com/labodj/node-red-contrib-lsh-logic/main/images/dynamic_mqtt_listener.png)

The fourth output is the trick that keeps the MQTT input maintainable: when you
deploy an inline config with a different device list, the node recalculates the
exact topic set and updates the `mqtt in` node automatically.

## Installation

Install from the Node-RED **Palette Manager**, or from your Node-RED user
directory:

```bash
npm install node-red-contrib-lsh-logic
```

Then import the example flow if you want a quick starting point:

- [examples/lsh-logic-example.json](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/examples/lsh-logic-example.json)

## The Two Things You Usually Touch

Most users only edit two things:

1. the Node-RED node settings;
2. the inline **System Config** JSON inside the node editor.

The node settings tell the runtime where MQTT topics live and how aggressive
timing should be. The inline JSON tells the runtime which devices exist and what
long-click actions should do. Keeping the config in the node makes exported
flows self-contained and removes the file-watcher/hot-reload surface that older
versions had.

### Minimal System Config

This is a small but complete example. The commented version uses `jsonc` only to
explain the shape; the Node-RED field must contain strict JSON.

```jsonc
{
  // Every LSH device known by the orchestration layer.
  "devices": [
    {
      // Must match the device id used in MQTT topics.
      "name": "c1",

      // Optional: actions triggered by long-click events from this device.
      "longClickButtons": [
        {
          // Button id reported by the controller.
          "id": 1,

          // LSH devices affected by this action.
          "actors": [
            {
              // Target another configured LSH device.
              "name": "j1",

              // true means every actuator on j1 is part of the action.
              "allActuators": true,

              // Must be empty when allActuators is true.
              "actuators": [],
            },
          ],

          // Non-LSH targets emitted on output 2 for your own flows.
          "otherActors": ["zigbee_table_lamp"],
        },
      ],
    },

    // Devices can be listed without button actions.
    {
      "name": "j1",
    },
  ],
}
```

Copyable strict JSON:

```json
{
  "devices": [
    {
      "name": "c1",
      "longClickButtons": [
        {
          "id": 1,
          "actors": [
            {
              "name": "j1",
              "allActuators": true,
              "actuators": []
            }
          ],
          "otherActors": ["zigbee_table_lamp"]
        }
      ]
    },
    {
      "name": "j1"
    }
  ]
}
```

More examples:

- [examples/inline-config.minimal.json](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/examples/inline-config.minimal.json)
- [examples/inline-config.multi-device.json](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/examples/inline-config.multi-device.json)

## What Each Output Means

| Output | Name                 | Use it for                                                   |
| ------ | -------------------- | ------------------------------------------------------------ |
| 1      | LSH Commands         | MQTT commands to LSH devices, usually wired to `mqtt out`.   |
| 2      | Other Actor Commands | Commands for non-LSH actors handled by your own flows.       |
| 3      | Alerts               | Human-readable health/recovery alerts and structured fields. |
| 4      | Configuration        | Dynamic subscription-control messages for `mqtt in`.         |
| 5      | Debug                | Original input passthrough while developing or diagnosing.   |

The **Other Actor Commands** output is deliberately protocol-neutral. If a
long-click should also switch a Zigbee light, a Tasmota plug or another custom
device, this node emits the intent and your surrounding Node-RED flow translates
it to the right protocol.

## Home Assistant Discovery

This node no longer generates Home Assistant discovery payloads. That job belongs
to the companion generic Homie bridge:

[`node-red-contrib-homie-home-assistant-discovery`](https://flows.nodered.org/node/node-red-contrib-homie-home-assistant-discovery)

Keep the two flows separate:

1. `lsh-logic` owns runtime orchestration, watchdog, click handling and recovery.
2. `homie-ha-discovery` owns Homie v3/v4/v5 metadata parsing and Home Assistant
   MQTT discovery.

Do not feed both nodes' dynamic subscription outputs into the same `mqtt in`
node. They each own a different topic set, so they need separate MQTT inputs
when both manage subscriptions dynamically.

Read the companion guide:
[Companion Home Assistant discovery](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/docs/COMPANION_DISCOVERY.md).

## How Startup and Recovery Feel in Practice

On startup the node tries hard to be fast without lying about device health:

- retained `conf` and `state` snapshots are reused as the last known topology and
  actuator state;
- retained Homie `$state=ready` is not treated as proof that the device is alive
  right now;
- if all snapshots are complete, the startup `BOOT` replay is skipped;
- if something is missing, the node asks the bridge for a single replay and then
  repairs only the missing pieces;
- watchdog alerts stay quiet during warm-up so startup does not spam you;
- later live traffic automatically recovers devices that were offline during
  startup.

The full contract is documented in
[LIFECYCLE.md](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/LIFECYCLE.md).

## Dynamic Subscriptions

Dynamic subscriptions are the recommended setup.

Leave the `mqtt in` topic empty, wire output 4 back into that same `mqtt in`
node, and let `lsh-logic` publish subscription-control messages. For each
configured device it subscribes to:

- `<lshBasePath><device>/conf`
- `<lshBasePath><device>/state`
- `<lshBasePath><device>/events`
- `<lshBasePath><device>/bridge`
- `<homieBasePath><device>/$state`

Read the focused guide:
[Dynamic subscriptions](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/docs/DYNAMIC_SUBSCRIPTIONS.md).

## MsgPack Support

JSON is the default and easiest payload format. MsgPack is available when your
firmware supports it and you want smaller wire payloads.

To use MsgPack:

1. Set **LSH Protocol** to `MsgPack` in the node settings.
2. Configure the upstream `mqtt in` node to output **a Buffer**.
3. Make sure your LSH firmware decodes MsgPack on its command topic.

In MsgPack mode, non-Buffer inbound LSH payloads are rejected instead of being
silently interpreted as text.

## Documentation

- [Configuration](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/docs/CONFIGURATION.md)
- [Dynamic subscriptions](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/docs/DYNAMIC_SUBSCRIPTIONS.md)
- [Companion Home Assistant discovery](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/docs/COMPANION_DISCOVERY.md)
- [Lifecycle contract](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/LIFECYCLE.md)

Protocol source of truth:

- [vendored LSH protocol](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/vendor/lsh-protocol/shared/lsh_protocol.md)
- [vendored protocol maintenance notes](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/vendor/lsh-protocol/README.md)

## Maintainer Notes

Runtime compatibility for the published package is `Node.js >= 18`. Maintainer
tooling is validated on current Node.js releases and the CI quality gate runs
formatting, linting, package validation, tests and production dependency audit.

Local quality gate:

```bash
npm ci
npm run check
```

Version 2 stores the LSH system config inline in the Node-RED node. There is no
`systemConfigPath` and no runtime file watcher anymore; deploy the flow to apply
config changes.

## License

Apache 2.0. See
[LICENSE](https://github.com/labodj/node-red-contrib-lsh-logic/blob/main/LICENSE).
