# Dynamic Subscriptions

Dynamic subscriptions let `lsh-logic` keep the MQTT input node aligned with
the inline System Config JSON.

Instead of manually editing the `mqtt in` topic every time you add or remove a
device, you leave the MQTT input topic empty and wire output 4, **Configuration**,
back into that same `mqtt in` node. Node-RED's MQTT input node understands these
control messages and updates its subscriptions at runtime.

## Recommended Wiring

Use one MQTT input dedicated to `lsh-logic`:

1. `mqtt in` -> `lsh-logic`
2. `lsh-logic` output 1 -> `mqtt out`
3. `lsh-logic` output 4 -> the same `mqtt in`

The `mqtt in` node should have an empty topic. A separate discovery node, if you
use one, should have its own MQTT input.

## What the Node Subscribes To

For every configured device, `lsh-logic` subscribes to:

- `<lshBasePath><device>/conf`
- `<lshBasePath><device>/state`
- `<lshBasePath><device>/events`
- `<lshBasePath><device>/bridge`
- `<homieBasePath><device>/$state`

Example with:

- `lshBasePath`: `LSH/`
- `homieBasePath`: `homie/5/`
- devices: `c1`, `j1`

The generated topic set is:

```text
LSH/c1/conf
LSH/c1/state
LSH/c1/events
LSH/c1/bridge
homie/5/c1/$state
LSH/j1/conf
LSH/j1/state
LSH/j1/events
LSH/j1/bridge
homie/5/j1/$state
```

LSH runtime topics are subscribed with QoS 2. Homie lifecycle topics are
subscribed with QoS 1.

The node editor shows this exact topic set before deploy. If you import a
generated `lsh-stack-config/v1` file from `lsh-core`, the preview uses the QoS
values from that stack export instead of the built-in defaults.

## What Output 4 Emits

When the effective topic set changes, the node sends one subscribe control
message per QoS level:

```json
{
  "action": "subscribe",
  "qos": 2,
  "topic": ["LSH/c1/conf", "LSH/c1/state", "LSH/c1/events", "LSH/c1/bridge"]
}
```

Homie lifecycle topics are sent in a separate QoS 1 message. The example shows
the shape only; a real message contains every generated topic for every
configured device.

Deploys that keep the same effective topic set do not emit new subscribe
messages. Changing only click rules or actor lists therefore does not churn
broker subscriptions.

## Why Not Use One MQTT Input for Everything?

Dynamic subscription outputs are intentionally owned by one upstream MQTT input.
Because of that, do not feed both `lsh-logic` and
`node-red-contrib-homie-home-assistant-discovery` subscription outputs into the
same `mqtt in` node. They would compete over what that input should listen to.

Use two MQTT inputs:

- one for `lsh-logic` runtime traffic;
- one for `homie-ha-discovery` metadata discovery traffic.

## Manual Alternative

Manual subscriptions are still valid. Disable topic export/subscription feedback
and configure the MQTT input yourself.

For small systems, broad filters are easy:

```text
LSH/#
homie/5/+/$state
```

Dynamic subscriptions are less error-prone for long-running installations
because the topic set follows the inline device list exactly and avoids
forgotten stale topics.
