# Companion Home Assistant Discovery

Home Assistant MQTT discovery is handled by the companion
`node-red-contrib-homie-home-assistant-discovery` package.

This keeps `node-red-contrib-lsh-logic` focused on LSH orchestration:

- runtime state registry;
- distributed click validation and command emission;
- bridge/controller reachability;
- watchdog and startup recovery.

The companion discovery node handles the generic Homie side:

- Homie v3.0.1, v4.0.0 and v5.x metadata;
- retained Home Assistant MQTT discovery payloads;
- granular entity mapping and overrides;
- diagnostic Homie attributes.

## Recommended Wiring

Keep two flows:

1. `mqtt-in` -> `lsh-logic` for LSH runtime traffic.
2. `mqtt-in` -> `homie-ha-discovery` -> `mqtt-out` for Home Assistant discovery.

If both nodes emit dynamic subscription control messages, each one needs its own
MQTT input node.

## Typical LSH v5 Discovery Settings

For LSH devices publishing Homie v5 under `homie/5/<device>/...`:

| Field                 | Suggested value      |
| --------------------- | -------------------- |
| HA prefix             | `homeassistant`      |
| ID prefix             | `lsh`                |
| Homie v5              | `homie`              |
| Homie v3/v4           | `homie`              |
| Versions              | v5 only              |
| emit subscriptions    | enabled              |
| state sensor          | enabled              |
| attribute diagnostics | enabled if desired   |
| Boolean mapping       | `auto` or `light`    |
| Manufacturer / Model  | your public branding |

Use the discovery node's override field for Home Assistant naming and entity
identity. Do not put Home Assistant entity mapping back into `system-config.json`.

## Compact LSH-Style Overrides

LSH devices often expose numeric Homie nodes whose `state` property is the
meaningful Home Assistant entity. `namedNodeState` keeps that mapping compact:

```json
{
  "deviceDefaults": {
    "objectId": "lsh_{deviceId}",
    "identifiers": ["LSH_{deviceId}"],
    "manufacturer": "Jacopo Labardi",
    "model": "Labo Smart Home"
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
        "1": "Kitchen Ceiling",
        "2": "Hallway",
        "3": {
          "name": "Extractor Fan",
          "platform": "fan",
          "icon": "mdi:fan"
        }
      }
    }
  }
}
```

String entries in `nodeNames` use the shared `namedNodeState` defaults. Object
entries override a single entity. Exact property overrides and ordered rules
remain available when a device needs full control.

Full override documentation lives in
[`homie-home-assistant-discovery`](https://github.com/labodj/homie-home-assistant-discovery/blob/main/docs/OVERRIDES.md).
