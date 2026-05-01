# Companion Home Assistant Discovery

`node-red-contrib-lsh-logic` is the runtime orchestrator. Home Assistant
discovery is handled by the companion package:

[`node-red-contrib-homie-home-assistant-discovery`](https://flows.nodered.org/node/node-red-contrib-homie-home-assistant-discovery)

This split keeps both tools cleaner:

- `lsh-logic` owns LSH state, click orchestration, watchdog, recovery and alerts;
- `homie-ha-discovery` owns Homie v3/v4/v5 metadata parsing and Home Assistant
  MQTT discovery.

The result is more reusable than an LSH-only discovery implementation: the
discovery node can expose any Homie-compliant device, while `lsh-logic` remains
focused on the runtime behavior that is specific to the LSH protocol.

## Recommended Wiring

Use two MQTT inputs when both nodes manage subscriptions dynamically:

1. `mqtt in` -> `lsh-logic` for LSH runtime traffic.
2. `mqtt in` -> `homie-ha-discovery` -> `mqtt out` for Home Assistant discovery.

Then wire each node's subscription output back to its own MQTT input:

- `lsh-logic` output 4 -> the LSH MQTT input;
- `homie-ha-discovery` output 4 -> the discovery MQTT input.

Do not share one dynamically-managed MQTT input between the two nodes. Each node
owns a different topic set, and separate MQTT inputs keep that ownership obvious.

## Typical LSH v5 Discovery Settings

For LSH devices publishing Homie v5 under `homie/5/<device>/...`:

| Field                  | Suggested value      |
| ---------------------- | -------------------- |
| Home Assistant prefix  | `homeassistant`      |
| ID prefix              | `lsh`                |
| Homie v5               | `homie`              |
| Homie v3/v4            | `homie`              |
| Versions               | v5 only              |
| Emit subscriptions     | enabled              |
| State sensor           | enabled              |
| Attribute diagnostics  | enabled if desired   |
| Boolean mapping        | `auto` or `light`    |
| Manufacturer and model | your public branding |

Use the discovery node's override field for Home Assistant names, platforms,
icons and stable entity IDs. Do not put Home Assistant entity mapping back into
the LSH inline System Config.

## Compact LSH-Style Overrides

Many LSH-style devices expose numeric Homie nodes whose `state` property is the
actual Home Assistant entity. `namedNodeState` keeps that setup short.

The commented block below is `jsonc` for explanation. The Node-RED editor
requires strict JSON, so paste the clean version after it.

```jsonc
{
  // Shared Home Assistant device identity.
  "deviceDefaults": {
    // Device discovery object id, for example lsh_c1.
    "objectId": "lsh_{deviceId}",

    // Stable Home Assistant device identifier.
    "identifiers": ["LSH_{deviceId}"],

    // Public branding shown in Home Assistant.
    "manufacturer": "Your Name",
    "model": "LSH Device",
  },

  // Every listed numeric node's settable boolean state becomes a light.
  "namedNodeState": {
    // Hide unnamed node/state entities for these configured devices.
    "exclusive": true,

    // Default platform for listed nodes.
    "platform": "light",

    // Keeps historical entity ids stable.
    "objectId": "lsh_{deviceId}_{nodeId}",
    "defaultEntityId": "{platform}.{objectId}",
  },

  // Device-specific friendly names and exceptions.
  "devices": {
    "c1": {
      "nodeNames": {
        // c1 node 1 state -> light.lsh_c1_1 named "Kitchen ceiling".
        "1": "Kitchen ceiling",

        // c1 node 2 state -> light.lsh_c1_2 named "Hallway".
        "2": "Hallway",

        // c1 node 3 is not a light: override only this entity.
        "3": {
          "name": "Extractor fan",
          "platform": "fan",
          "icon": "mdi:fan",
        },
      },
    },
  },
}
```

Copyable strict JSON:

```json
{
  "deviceDefaults": {
    "objectId": "lsh_{deviceId}",
    "identifiers": ["LSH_{deviceId}"],
    "manufacturer": "Your Name",
    "model": "LSH Device"
  },
  "namedNodeState": {
    "exclusive": true,
    "platform": "light",
    "objectId": "lsh_{deviceId}_{nodeId}",
    "defaultEntityId": "{platform}.{objectId}"
  },
  "devices": {
    "c1": {
      "nodeNames": {
        "1": "Kitchen ceiling",
        "2": "Hallway",
        "3": {
          "name": "Extractor fan",
          "platform": "fan",
          "icon": "mdi:fan"
        }
      }
    }
  }
}
```

String entries in `nodeNames` use the shared `namedNodeState` defaults. Object
entries override one entity. Exact property overrides and ordered rules remain
available when a device needs full control.

Full override documentation lives in the companion core package:

[homie-home-assistant-discovery overrides](https://github.com/labodj/homie-home-assistant-discovery/blob/main/docs/OVERRIDES.md)

## Migration Notes

If you previously used LSH-specific Home Assistant discovery, preserve history by
keeping the old Home Assistant object IDs and default entity IDs in the companion
node overrides.

The important fields are:

- device `objectId`, which controls the retained device discovery topic;
- property `objectId`, which controls `unique_id`;
- property `defaultEntityId`, which controls the first Home Assistant entity id.

Once the companion discovery node publishes the same IDs, Home Assistant can keep
using the existing entity registry entries.
