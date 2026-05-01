# Configuration

`node-red-contrib-lsh-logic` has two configuration layers:

- the Node-RED editor settings, which describe MQTT paths, timing and context
  exports;
- the inline **System Config** JSON, which describes your LSH devices and the
  long-click actions that this node should orchestrate.

The mental model is simple: the editor config tells the node **where to listen
and how to behave**; the inline JSON tells it **which devices exist and what user
actions mean**.

## Node-RED Editor Settings

| Field                       | Meaning                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `homieBasePath`             | Homie lifecycle base path, for example `homie/5/`.                                   |
| `lshBasePath`               | LSH device topic base path, for example `LSH/`.                                      |
| `serviceTopic`              | Bridge-scoped service topic for broadcast `PING` and startup `BOOT` replay requests. |
| `protocol`                  | LSH payload encoding: `json` or `msgpack`.                                           |
| `systemConfigJson`          | Inline JSON device/action configuration stored in the Node-RED flow.                 |
| `clickTimeout`              | Hard request/ACK/confirm timeout for distributed click actions.                      |
| `clickCleanupInterval`      | Periodic sweep for expired click transactions.                                       |
| `initialStateTimeout`       | Startup replay window used only when bridge-local `BOOT` replay is actually needed.  |
| `watchdogInterval`          | Periodic health-check interval.                                                      |
| `interrogateThreshold`      | Silence threshold before the watchdog sends a probe.                                 |
| `pingTimeout`               | Time to wait for a ping reply before a device is considered stale.                   |
| `exposeStateContext` / key  | Optional live registry export to flow/global context.                                |
| `exportTopics` / key        | Optional generated MQTT topic export to flow/global context.                         |
| `exposeConfigContext` / key | Optional effective runtime config export to flow/global context.                     |
| `otherActorsContext`        | Context store used to read external actor states.                                    |
| `otherDevicesPrefix`        | Prefix used for external actor state lookups.                                        |

MQTT base paths must end with `/`, contain no empty segments and contain no MQTT
wildcards. Publish topics such as `serviceTopic` must be concrete topics and
must not end with `/`.

## Recommended Defaults

For a typical LSH v5 setup:

| Setting                 | Typical value                       |
| ----------------------- | ----------------------------------- |
| Homie Base Path         | `homie/5/`                          |
| LSH Base Path           | `LSH/`                              |
| Service Topic           | `LSH/Node-RED/SRV`                  |
| LSH Protocol            | `JSON` unless firmware uses MsgPack |
| System Config           | inline JSON in the node editor      |
| Export MQTT Topics      | `flow`, key `lsh_topics`            |
| Export Internal State   | `none` until you need debug         |
| Export Effective Config | `none` until you need debug         |

The default timing values are intentionally conservative. Tune them only when
you understand your bridge latency, controller timeout and broker behavior.

## System Config JSON

This JSON is intentionally about LSH orchestration only. It should not contain
Home Assistant discovery mapping. Use
`node-red-contrib-homie-home-assistant-discovery` for Home Assistant entity
names, icons, platforms and discovery IDs.

Edit it directly in the node dialog. That makes exported flows self-contained:
the runtime config travels with the flow instead of depending on a separate file
inside the Node-RED user directory.

## Minimal Example

JSON does not allow comments. The first block is `jsonc` to explain the file;
the second block is valid JSON that you can copy.

```jsonc
{
  // Every LSH device known to the orchestration layer.
  "devices": [
    {
      // Device id. Must match MQTT topics exactly, for example LSH/c1/state.
      "name": "c1",

      // Optional actions fired by long-click events from this device.
      "longClickButtons": [
        {
          // Button id reported by the controller event.
          "id": 1,

          // LSH devices controlled by this long-click.
          "actors": [
            {
              // Target device. It must exist in devices[].
              "name": "j1",

              // true means the whole target device is affected.
              "allActuators": true,

              // Must be empty when allActuators is true.
              "actuators": [],
            },
          ],

          // Optional non-LSH targets emitted on output 2.
          "otherActors": ["zigbee_table_lamp"],
        },
      ],
    },

    // A device can be listed only to make it known and monitored.
    {
      "name": "j1",
    },
  ],
}
```

Copyable JSON:

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

## Device Entries

`devices[].name` must match the exact MQTT device id and must be a single topic
segment using letters, digits, `_` or `-`. Names are checked case-insensitively,
so `C1` and `c1` cannot coexist.

A device entry can be just:

```json
{ "name": "j1" }
```

That is enough for the node to monitor the device, subscribe to its topics and
target it from another device's click action.

## Long Clicks and Super Long Clicks

Two action lists are available:

- `longClickButtons`
- `superLongClickButtons`

They have the same shape. The difference is the controller event that triggers
them.

Each action needs:

- `id`: the numeric button id reported by the device;
- at least one target between `actors` and `otherActors`.

Example with a partial LSH target and one external actor:

```json
{
  "id": 2,
  "actors": [
    {
      "name": "kitchen-board",
      "allActuators": false,
      "actuators": [1, 2, 3]
    }
  ],
  "otherActors": ["zigbee_table_lamp"]
}
```

## LSH Actors

`actors` target devices controlled by this node.

Rules:

- `name` must match a configured `devices[].name` exactly.
- `allActuators: true` targets the whole device and must use `actuators: []`.
- `allActuators: false` targets only listed actuator IDs and requires a
  non-empty `actuators` array.

Before a distributed click is confirmed, the node checks that each targeted LSH
device has an authoritative actuator snapshot. If a target is reachable but
state is missing, the click fails fast instead of choosing a toggle direction
from incomplete information.

## Other Actors

`otherActors` are names for non-LSH targets. The node does not know whether they
are Zigbee lights, Tasmota plugs, Home Assistant services or something else.

Instead, it emits a generic command on output 2. Your surrounding Node-RED flow
reads that message and translates it to the right protocol.

This keeps the LSH runtime focused on LSH correctness while still letting one
button action control the whole home.

## Applying Changes

Configuration changes become active when you deploy the Node-RED flow. The flow
JSON is the single source of truth, and deployment is the point where Node-RED
makes runtime changes effective.

When a new inline config is valid:

- the coordinator starts from the new config;
- pending click transactions are cleared;
- MQTT subscriptions are updated only if the effective topic set changed.

When the inline JSON is invalid, the node fails fast during deploy and shows a
clear configuration error. Fix the JSON in the editor and deploy again.

## Context Exports

Context exports are optional. Enable them when you want dashboards, debug flows
or observability.

- Internal state export gives you the live device registry.
- Topic export gives you the MQTT subscription set generated from config.
- Effective config export gives you the parsed runtime config after validation.

For normal production flows, it is fine to leave internal state and effective
config exports disabled and keep only topic export enabled if you use dynamic
subscriptions.
