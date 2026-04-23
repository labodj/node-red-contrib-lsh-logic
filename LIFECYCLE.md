# LSH Logic Lifecycle Contract

This document is the canonical lifecycle contract for `node-red-contrib-lsh-logic`.
It defines what counts as live reachability, which recovery actions are allowed,
and how startup, reload, watchdog, and live traffic interact.

## Core Principles

- Retained `conf` and `state` payloads are authoritative snapshots of topology and actuator state.
- Retained Homie `$state=ready` is not proof that the device is currently alive.
- Retained `events` and `bridge` payloads are ignored for current reachability.
- Live controller-backed LSH traffic, live Homie lifecycle transitions, and live bridge service replies are the only runtime reachability proofs.
- Live Homie `init` and `sleeping` are diagnostic-only runtime hints: they refresh diagnostics but never flip bridge/controller reachability.
- The lifecycle always prefers the lightest repair that can close the gap.
- Home Assistant discovery classifies Homie nodes from retained metadata: writable boolean `state` nodes become toggle entities, read-only booleans become binary sensors, and other nodes become sensors.

## Recovery Paths

Each configured device is always treated as being in exactly one of these recovery paths:

- `controller_reachable`
  The controller path is considered usable. Snapshot repair and controller-directed recovery commands are allowed.
- `bridge_only`
  The bridge is alive, but it explicitly reported `controller_connected=false`. Controller-directed recovery commands are suppressed. Only bridge-level probing is allowed.
- `offline`
  No live bridge reachability is currently known. The runtime may probe only the bridge path first.

This classification is shared by startup verification, watchdog repair, and bridge-service recovery handling.

## Startup

Startup is split into three phases:

1. MQTT subscription settle window.
2. Optional bridge-local `BOOT` replay if at least one configured device lacks an authoritative `details + state` snapshot.
3. Initial verification:
   - reachable but incomplete devices receive only the missing snapshot requests
   - still-unreachable devices receive direct controller `PING`
   - bridge-only devices are logged but do not receive controller-directed recovery

During warm-up, normal watchdog alerts are suppressed. Startup reachability is decided by the dedicated startup verification path.
The config file watcher is armed before the first load attempt, so fixing an invalid startup config can recover the node without a manual restart. That recovery path re-enters the normal startup bootstrap flow, including warm-up and alert suppression, instead of falling through the lighter runtime-reload path.
Periodic watchdog and cleanup timers start only after the runtime has applied a valid configuration at least once.

## Runtime Reload

A successful runtime config reload does **not** restart warm-up.

Instead:

- the active config is replaced atomically
- stale low-priority queued startup/watchdog traffic from the previous config generation is dropped
- a strong post-reload recovery pass is scheduled
- if startup recovery is still pending, the post-reload strong recovery is deferred until startup verification completes

If a hot reload fails but a valid config was already active, the runtime keeps the last valid config and reports the reload failure as a degraded warning instead of a hard-stop fault.
In that case it also keeps the previous MQTT subscription/export state intact instead of emitting a redundant unsubscribe/resubscribe churn.
A successful reload reconfigures MQTT subscriptions only when the effective topic set actually changes.
A successful reload regenerates Home Assistant discovery only when the effective discovery model changes.

## Watchdog

The watchdog follows these rules:

- never-seen configured devices may trigger unhealthy alerts and bridge probes
- devices in `bridge_only` state never receive controller-directed pings
- offline devices are bridge-probed first
- a stale device keeps its stale state latched until real live activity clears it
- bridge probes are rate-limited independently from controller ping timestamps
- bridge probe cooldown follows the actual service-topic broadcast, so it is global across the fleet rather than per-device
- controller `PING` timeout accounting starts when the adapter actually emits the ping, not when the watchdog merely decided to enqueue it
- startup warm-up stays active until `pingTimeout` after the last startup verification controller-side command that actually leaves the adapter

## Snapshot Recovery

Snapshot repair is rate-limited per device.

- If `details` are missing, request both `REQUEST_DETAILS` and `REQUEST_STATE`
- If only `state` is missing, request only `REQUEST_STATE`
- Bridge replies that report `runtime_synchronized=false` may force immediate repair
- Snapshot recovery cooldown starts only after the planned recovery burst has actually been emitted; a partial burst invalidated mid-drain does not suppress the replacement retry
- Once a complete authoritative snapshot exists again, the repair cooldown is cleared

## Output Ordering

The adapter guarantees that Node-RED `send()` calls do not overlap.

- high-priority live outputs are serialized through a single send queue
- low-priority bulk startup/watchdog LSH traffic drains in the background
- the stagger sleep happens outside the send queue, so later high-priority live traffic can overtake future low-priority frames
- reload invalidates stale low-priority queued traffic from older config generations

## Alerts

- unhealthy alerts latch through `alertSent`
- `alertSent` does not block future recovery checks
- recovery alerts are suppressed during warm-up
- a real live recovery signal clears the unhealthy latch

## Non-Goals

The lifecycle is designed to be idempotent and robust, not transactionally perfect.
It deliberately avoids complex cross-restart recovery for in-flight click transactions or rare startup/reload timing races that would cost more complexity than they are worth.
