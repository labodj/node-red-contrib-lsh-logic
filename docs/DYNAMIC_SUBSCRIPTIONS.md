# Dynamic Subscriptions

`node-red-contrib-lsh-logic` can manage its own MQTT input subscriptions through
the fourth output, `Configuration`.

## Recommended Flow

Wire the node like this:

1. `mqtt-in` -> `lsh-logic`
2. `lsh-logic` output 1 -> `mqtt-out`
3. `lsh-logic` output 4 -> the same `mqtt-in`

The `mqtt-in` node should have an empty topic. After the runtime config is
loaded, `lsh-logic` emits subscription-control messages that tell it exactly
which topics to listen to.

## Generated Topics

For every configured device, the node subscribes to:

- `<lshBasePath><device>/conf`
- `<lshBasePath><device>/state`
- `<lshBasePath><device>/events`
- `<lshBasePath><device>/bridge`
- `<homieBasePath><device>/$state`

LSH runtime topics are subscribed with QoS 2. Homie lifecycle topics are
subscribed with QoS 1.

## Reconfiguration

Every effective topic-set change emits:

```json
{ "action": "unsubscribe", "topic": true }
```

followed by one or more `subscribe` messages. Node-RED's built-in MQTT input
node understands this control format.

Reloads that keep the same effective topic set do not churn MQTT
subscriptions. This keeps config-only changes cheap and avoids unnecessary
broker traffic.

## Companion Discovery Node

Use a separate `mqtt-in` node for
`node-red-contrib-homie-home-assistant-discovery` when it also manages dynamic
subscriptions. Do not feed both subscription outputs into the same `mqtt-in`
node: both nodes can intentionally unsubscribe from all current topics before
subscribing to their own topic set.
