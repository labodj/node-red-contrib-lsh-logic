# LSH Logic Lifecycle Contract

This document describes the lifecycle contract for
`node-red-contrib-lsh-logic`.

The README explains how to use the node. This file explains how the runtime
decides what is alive, what can be repaired, when alerts are allowed, and how
startup, Node-RED deploys, watchdog probes, and live traffic interact.

## Core Principles

The runtime deliberately separates **last known state** from **current
reachability**.

- Retained `conf` and `state` payloads are authoritative snapshots of topology
  and actuator state.
- Retained Homie `$state=ready` is not proof that the device is alive right now.
- Retained `events` and `bridge` payloads are ignored for current reachability.
- Live controller-backed LSH traffic, live Homie lifecycle transitions, and live
  bridge service replies are runtime reachability proofs.
- Live Homie `init` and `sleeping` are diagnostic hints. They refresh
  diagnostics but never mark the bridge/controller path reachable.
- Live Homie `disconnected` and `lost` are offline states. `disconnected` is a
  clean broker disconnect; `lost` is the LWT or unexpected disconnect path.
- An empty Homie `$state` payload is the v5 device-removal signal; the runtime
  removes local device state.
- Recovery uses the smallest repair that can close the observed gap.

Startup can therefore reuse retained snapshots while still waiting for live
evidence before marking a device healthy.

## Recovery Paths

Every configured device is classified into one recovery path:

| Path                   | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `controller_reachable` | The controller path is usable. Snapshot repair and controller pings are allowed.                           |
| `bridge_only`          | The bridge is alive, but reports `controller_connected=false`. Controller-directed recovery is suppressed. |
| `offline`              | No live bridge reachability is known. The runtime probes the bridge path first.                            |

Startup verification, watchdog repair, and bridge-service recovery all use the
same classification. That keeps behavior consistent across cold boot and normal
runtime.

## Startup

Startup has three phases:

1. MQTT subscription settle window.
2. Optional bridge-local `BOOT` replay, only if at least one configured device
   lacks an authoritative `conf + state` snapshot.
3. Initial verification:
   - reachable but incomplete devices receive only the missing snapshot requests;
   - still-unreachable devices receive direct controller `PING`;
   - bridge-only devices are logged but do not receive controller-directed
     recovery.

During warm-up, normal watchdog alerts are suppressed. Startup reachability is
decided by the dedicated verification path rather than watchdog alerts racing the
initial sync.

Periodic watchdog and cleanup timers start only after the runtime has applied a
valid configuration at least once.

## Runtime Config Update

A successful inline config update does **not** restart the whole Node-RED
runtime.

Instead, the runtime:

- replaces the active config atomically;
- clears pending click transactions;
- drops stale low-priority startup/watchdog traffic from the previous config
  generation;
- schedules a post-update recovery pass;
- defers that post-update recovery if startup verification is still pending;
- reconfigures MQTT subscriptions only when the effective topic set changes.

If a later config update fails while a valid config is already active, the
runtime keeps the last valid config and reports a warning instead of stopping.
It also keeps the previous MQTT subscription/export state intact instead of
emitting redundant unsubscribe/resubscribe churn.

## Watchdog

The watchdog is conservative:

- configured devices that have never reported state may trigger unhealthy alerts
  and bridge probes;
- devices in `bridge_only` state never receive controller-directed pings;
- offline devices are bridge-probed first;
- stale state stays latched until real live activity clears it;
- bridge probes are rate-limited independently from controller ping timestamps;
- bridge probe cooldown follows the actual service-topic broadcast, so it is
  fleet-wide rather than per device;
- controller `PING` timeout accounting starts when the adapter actually emits
  the ping, not when the watchdog merely queues it;
- startup warm-up stays active for `pingTimeout` after the last startup
  verification command is emitted to a controller.

## Snapshot Recovery

Snapshot repair is rate-limited per device.

- If `conf` details are missing, request both `REQUEST_DETAILS` and
  `REQUEST_STATE`.
- If only `state` is missing, request only `REQUEST_STATE`.
- Bridge replies that report `runtime_synchronized=false` may force immediate
  repair.
- Snapshot recovery cooldown starts only after the planned recovery burst has
  actually been emitted.
- A partial burst invalidated mid-drain does not suppress the replacement retry.
- Once a complete authoritative snapshot exists again, the repair cooldown is
  cleared.

## Distributed Clicks

Distributed long-click actions use a request/ACK/confirm lifecycle.

The runtime validates targets before confirming the action. A click fails early
when a target device is reachable but lacks an authoritative actuator snapshot.
Acting from incomplete state could apply the wrong action, so the node rejects
that user action and waits for the next valid event.

Runtime config updates clear pending click transactions. In-flight distributed
clicks are marked failed deliberately rather than preserved across a config
change.

## Output Ordering

The adapter guarantees that Node-RED `send()` calls do not overlap.

- High-priority live outputs are serialized through a single send queue.
- Low-priority bulk startup/watchdog LSH traffic drains in the background.
- The staggered delay happens outside the send queue, so later high-priority
  live traffic can overtake future low-priority frames.
- Config updates invalidate stale low-priority queued traffic from older config
  generations.

## Alerts

Alert behavior is designed to avoid notification storms.

- Unhealthy alerts latch through `alertSent`.
- `alertSent` does not block future recovery checks.
- Recovery alerts are suppressed during warm-up.
- A real live recovery signal clears the unhealthy latch.

Alert payloads also include structured fields such as `event_type` and
`event_source` so notification flows can distinguish lifecycle/reboot events
from true watchdog outages without parsing the formatted text.

## Boundaries

The lifecycle is designed to be idempotent and predictable. It does not try to
preserve every in-flight action across every restart or configuration change.

It deliberately avoids complex cross-restart recovery for in-flight click
transactions and rare startup/update timing races that would add more complexity
than they remove.
