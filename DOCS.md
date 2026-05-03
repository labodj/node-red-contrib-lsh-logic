# Documentation

This package is the Node-RED wrapper around the LSH coordinator. The README gives
you the shortest path; this page is the stable map for the rest of the
documentation.

## Start Here

Read these in order if you are setting up a new flow:

1. [README](README.md) for the purpose of the node, the basic wiring, and a
   small config example.
2. [Configuration](docs/CONFIGURATION.md) for every editor field and the System
   Config JSON shape.
3. [Dynamic subscriptions](docs/DYNAMIC_SUBSCRIPTIONS.md) for the recommended
   MQTT wiring pattern.

That path is enough for most installations.

## Common Tasks

| Task                                              | Read this first                                                 |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Add or rename an LSH device                       | [Configuration](docs/CONFIGURATION.md)                          |
| Wire the MQTT input without broad wildcard topics | [Dynamic subscriptions](docs/DYNAMIC_SUBSCRIPTIONS.md)          |
| Route a long click to an external flow            | [Configuration](docs/CONFIGURATION.md#other-actors)             |
| Use optional Home Assistant discovery             | [Optional discovery](docs/COMPANION_DISCOVERY.md)               |
| Understand startup, watchdog, and recovery        | [Lifecycle contract](LIFECYCLE.md)                              |
| Check the MQTT/protocol source of truth           | [Vendored protocol](vendor/lsh-protocol/shared/lsh_protocol.md) |

## How the Pieces Fit

`lsh-logic` is intentionally narrow. It owns LSH runtime behavior inside
Node-RED: device registry, distributed clicks, watchdog probes, recovery, alerts,
and command emission.

If you want Home Assistant discovery, use the separate optional Homie discovery
node. Non-LSH systems stay in your own Node-RED flows and receive generic
intents from output 2. Keeping those responsibilities separate makes each flow
easier to inspect and keeps the LSH System Config focused on things the
coordinator can enforce.

## Package Relationship

The orchestration logic lives in
[`labo-smart-home-coordinator`](https://github.com/labodj/labo-smart-home-coordinator).
This package wraps that runtime for Node-RED: editor fields, context access,
dynamic subscription messages, and the five physical outputs.

If you do not use Node-RED, use the coordinator package directly. If you do use
Node-RED, this package adds editor fields and outputs around that runtime.

## Wider LSH Stack

The project-level docs are the main place for the full installation picture:

- [Reference stack](https://github.com/labodj/labo-smart-home/blob/main/REFERENCE_STACK.md)
- [Getting started](https://github.com/labodj/labo-smart-home/blob/main/GETTING_STARTED.md)
- [Glossary](https://github.com/labodj/labo-smart-home/blob/main/GLOSSARY.md)
- [Troubleshooting](https://github.com/labodj/labo-smart-home/blob/main/TROUBLESHOOTING.md)

Use those pages for architecture, naming, and operational context. Use this
package documentation for the Node-RED node itself.
