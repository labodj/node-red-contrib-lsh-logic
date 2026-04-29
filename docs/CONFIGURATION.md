# Configuration

`node-red-contrib-lsh-logic` has two configuration layers:

- the Node-RED editor settings, which define MQTT roots, runtime timing and
  context exports;
- `system-config.json`, which defines devices and distributed click actions.

## Node-RED Settings

| Field                       | Meaning                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `homieBasePath`             | Homie lifecycle base path, for example `homie/` or `homie/5/`.                              |
| `lshBasePath`               | LSH device topic base path, for example `LSH/`.                                             |
| `serviceTopic`              | Bridge-scoped service topic for broadcast `PING` and startup `BOOT` replay requests.        |
| `protocol`                  | LSH payload encoding: `json` or `msgpack`.                                                  |
| `systemConfigPath`          | Runtime config file path, resolved relative to the Node-RED user directory unless absolute. |
| `clickTimeout`              | Hard request/ACK/confirm timeout for distributed click actions.                             |
| `clickCleanupInterval`      | Periodic sweep for expired click transactions.                                              |
| `initialStateTimeout`       | Startup replay window used only when a bridge-local `BOOT` replay is actually needed.       |
| `watchdogInterval`          | Periodic health-check interval.                                                             |
| `interrogateThreshold`      | Silence threshold before the watchdog sends a probe.                                        |
| `pingTimeout`               | Time to wait for a ping reply before a device is considered stale.                          |
| `exposeStateContext` / key  | Optional live registry export to flow/global context.                                       |
| `exportTopics` / key        | Optional generated MQTT topic export to flow/global context.                                |
| `exposeConfigContext` / key | Optional effective runtime config export to flow/global context.                            |
| `otherActorsContext`        | Context store used to read external actor states.                                           |
| `otherDevicesPrefix`        | Prefix used for external actor state lookups.                                               |

MQTT path fields are validated as concrete paths. Base paths must end with `/`;
publish topics such as `serviceTopic` must not. MQTT wildcards are rejected in
all static path settings.

## `system-config.json`

The runtime config is deliberately focused on LSH orchestration. It does not
contain Home Assistant discovery mapping; use
`node-red-contrib-homie-home-assistant-discovery` for that layer.

```json
{
  "devices": [
    {
      "name": "c1",
      "longClickButtons": [
        {
          "id": 1,
          "actors": [{ "name": "j1", "allActuators": true, "actuators": [] }],
          "otherActors": ["zigbee_table_lamp"]
        }
      ],
      "superLongClickButtons": [
        {
          "id": 9,
          "actors": [{ "name": "c1", "allActuators": false, "actuators": [7, 8, 9] }]
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
segment using letters, digits, `_` or `-`. Names are also checked
case-insensitively, so `C1` and `c1` cannot coexist.

Button action groups are optional:

- `longClickButtons` configures long-click actions.
- `superLongClickButtons` configures super-long-click actions.

Each action needs an `id` and at least one target across `actors` and
`otherActors`.

## Actors

`actors` target LSH devices controlled by this node:

- `name` must match a configured device exactly.
- `allActuators: true` targets the whole device and must use `actuators: []`.
- `allActuators: false` targets only the listed actuator IDs and requires a
  non-empty `actuators` array.

`otherActors` are emitted on the second output as abstract commands for other
Node-RED flows. The node does not assume a protocol for those devices.

## Runtime Reloads

The config file is watched and reloaded automatically. A valid reload replaces
the active config atomically, clears pending click transactions and schedules a
post-reload recovery pass. If a reload fails after a valid config is already
active, the node keeps the last valid config and reports the failure as a
warning instead of tearing down the runtime.
