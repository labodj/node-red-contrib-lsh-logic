/**
 * @file Node-RED helper that stores external actor state for `lsh-logic`.
 *
 * The coordinator reads external actors from Node-RED context using
 * `${otherDevicesPrefix}.${actorName}.state`. This helper owns the repetitive
 * edge work around MQTT payloads: extracting an actor name, normalizing odd
 * vendor states to boolean values, and writing the context path consistently.
 */

import type { Node, NodeAPI, NodeMessage } from "node-red";

import {
  clearPendingTimers,
  formatState,
  getNodeContext,
  isObjectRecord,
  normalizeBoolean,
  normalizeBooleanState,
  normalizeContextName,
  normalizeNonNegativeNumber,
  normalizeOptionalString,
  normalizeRequiredString,
  parseBooleanTextSet,
  readMessageProperty,
  warnAndSetStatus,
} from "./node-red-runtime";
import type {
  ContextName,
  ContextStore,
  DoneFunction,
  SendFunction,
  StatusShape,
} from "./node-red-runtime";

type PrefixSource = "config" | "manual";
type ActorNameSource = "msg" | "config";

type LshExternalStateNodeDef = {
  id: string;
  type: string;
  name: string;
  z: string;
  storeContext: ContextName;
  prefixSource: PrefixSource;
  prefix: string;
  configContext: ContextName;
  configKey: string;
  actorNameSource: ActorNameSource;
  actorName: string;
  actorNameProperty: string;
  stateProperty: string;
  trueValues: string;
  falseValues: string;
  caseSensitive: boolean | string;
  invert: boolean | string;
  acceptRetained: boolean | string;
  storeOnlyChanges: boolean | string;
  storeMetadata: boolean | string;
  configWaitTimeoutMs?: number | string;
};

type NormalizedLshExternalStateNodeDef = Omit<
  LshExternalStateNodeDef,
  | "caseSensitive"
  | "invert"
  | "acceptRetained"
  | "storeOnlyChanges"
  | "storeMetadata"
  | "configWaitTimeoutMs"
> & {
  caseSensitive: boolean;
  invert: boolean;
  acceptRetained: boolean;
  storeOnlyChanges: boolean;
  storeMetadata: boolean;
  configWaitTimeoutMs: number;
  trueValueSet: ReadonlySet<string>;
  falseValueSet: ReadonlySet<string>;
};

type ConfigExportLike = {
  otherDevicesPrefix: string;
};

type ExternalStateUpdate = {
  actorName: string;
  state: boolean;
  rawState: unknown;
  retained: boolean;
  sourceTopic?: string;
};

type PendingStore = ExternalStateUpdate & {
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
};

type StoreResult = NodeMessage | null | "missing-config";

const CONFIG_RETRY_INTERVAL_MS = 250;
const DEFAULT_TRUE_VALUES = ["1", "true", "on", "yes", "open", "active"];
const DEFAULT_FALSE_VALUES = ["0", "false", "off", "no", "closed", "inactive"];

/**
 * Normalizes the prefix-source selector from the Node-RED editor.
 */
const normalizePrefixSource = (value: unknown): PrefixSource => {
  if (value === "manual" || value === "config") {
    return value;
  }
  throw new Error("Prefix Source must be config or manual.");
};

/**
 * Normalizes the actor-name source selector from the Node-RED editor.
 */
const normalizeActorNameSource = (value: unknown): ActorNameSource => {
  if (value === "msg" || value === "config") {
    return value;
  }
  throw new Error("Actor Name Source must be msg or config.");
};

/**
 * Parses the configurable true/false value list used by odd integrations.
 */
const parseValueSet = (
  value: unknown,
  defaultValues: string[],
  caseSensitive: boolean,
): ReadonlySet<string> => {
  return parseBooleanTextSet(value, defaultValues, caseSensitive);
};

/**
 * Converts the raw Node-RED editor config into a runtime-safe immutable shape.
 */
const normalizeConfig = (config: LshExternalStateNodeDef): NormalizedLshExternalStateNodeDef => {
  const prefixSource = normalizePrefixSource(config.prefixSource);
  const actorNameSource = normalizeActorNameSource(config.actorNameSource);
  const caseSensitive = normalizeBoolean(config.caseSensitive, false);
  const normalized = {
    ...config,
    storeContext: normalizeContextName(config.storeContext, "Store Context"),
    prefixSource,
    prefix:
      prefixSource === "manual"
        ? normalizeRequiredString(config.prefix, "External State Prefix")
        : "",
    configContext: normalizeContextName(config.configContext, "Config Context"),
    configKey: normalizeRequiredString(config.configKey, "Config Context Key"),
    actorNameSource,
    actorName:
      actorNameSource === "config" ? normalizeRequiredString(config.actorName, "Actor Name") : "",
    actorNameProperty:
      actorNameSource === "msg"
        ? normalizeRequiredString(config.actorNameProperty, "Actor Name Property")
        : "",
    stateProperty: normalizeRequiredString(config.stateProperty, "State Property"),
    caseSensitive,
    invert: normalizeBoolean(config.invert, false),
    acceptRetained: normalizeBoolean(config.acceptRetained, true),
    storeOnlyChanges: normalizeBoolean(config.storeOnlyChanges, true),
    storeMetadata: normalizeBoolean(config.storeMetadata, true),
    configWaitTimeoutMs: normalizeNonNegativeNumber(
      config.configWaitTimeoutMs,
      "Config Ready Wait",
      5000,
    ),
    trueValueSet: parseValueSet(config.trueValues, DEFAULT_TRUE_VALUES, caseSensitive),
    falseValueSet: parseValueSet(config.falseValues, DEFAULT_FALSE_VALUES, caseSensitive),
  };

  for (const trueValue of normalized.trueValueSet) {
    if (normalized.falseValueSet.has(trueValue)) {
      throw new Error(`State value '${trueValue}' cannot be both true and false.`);
    }
  }

  return normalized;
};

/**
 * Narrows the exported effective config to the external actor state prefix.
 */
const asConfigExport = (value: unknown): ConfigExportLike | undefined => {
  if (!isObjectRecord(value) || typeof value.otherDevicesPrefix !== "string") {
    return undefined;
  }

  const prefix = value.otherDevicesPrefix.trim();
  return prefix.length > 0 ? { otherDevicesPrefix: prefix } : undefined;
};

/**
 * Runtime class attached to a single `lsh-external-state` Node-RED node instance.
 */
export class LshExternalStateNode {
  private readonly node: Node;
  private readonly red: NodeAPI;
  private readonly config: NormalizedLshExternalStateNodeDef;
  private readonly pendingStores = new Map<string, PendingStore>();

  /**
   * Creates one runtime instance and validates the editor configuration once.
   */
  public constructor(node: Node, red: NodeAPI, config: LshExternalStateNodeDef) {
    this.node = node;
    this.red = red;
    this.config = normalizeConfig(config);
    this.node.status({ fill: "grey", shape: "ring", text: "Waiting" });
    this.registerNodeEventHandlers();
  }

  /**
   * Wires Node-RED lifecycle events and guarantees pending timers are cleaned up.
   */
  private registerNodeEventHandlers(): void {
    this.node.on("input", (msg, send, done) => {
      this.handleInput(msg, send, done);
    });

    this.node.on("close", (done: () => void) => {
      clearPendingTimers(this.pendingStores);
      done();
    });
  }

  /**
   * Handles one external state message and always completes the Node-RED callback.
   */
  private handleInput(msg: NodeMessage, send: SendFunction, done?: DoneFunction): void {
    try {
      if (!this.config.acceptRetained && msg.retain === true) {
        this.setStatus({ fill: "grey", shape: "ring", text: "Retained ignored" });
        done?.();
        return;
      }

      const update = this.parseUpdate(msg);
      if (update === null) {
        done?.();
        return;
      }

      const result = this.tryStoreUpdate(update);
      if (result === "missing-config") {
        this.deferOrSkip(update);
      } else if (result !== null) {
        send(result);
      }
      done?.();
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      this.node.error(`Error storing external actor state: ${wrappedError.message}`, msg);
      this.setStatus({ fill: "red", shape: "ring", text: "Store error" });
      done?.(wrappedError);
    }
  }

  /**
   * Extracts actor/state data from a message and rejects ambiguous values.
   */
  private parseUpdate(msg: NodeMessage): ExternalStateUpdate | null {
    const actorName =
      this.config.actorNameSource === "config"
        ? this.config.actorName
        : normalizeOptionalString(this.readMessageProperty(msg, this.config.actorNameProperty));
    if (actorName === undefined || actorName.length === 0) {
      return this.skip("Message must include a non-empty external actor name.", "Missing actor");
    }

    const rawState = this.readMessageProperty(msg, this.config.stateProperty);
    const state = this.normalizeExternalState(rawState);
    if (state === undefined) {
      return this.skip(this.invalidStateWarning(), "Invalid state");
    }

    return {
      actorName,
      state,
      rawState,
      retained: msg.retain === true,
      sourceTopic: normalizeOptionalString(msg.topic),
    };
  }

  /**
   * Converts raw integration-specific state into a boolean without guessing.
   */
  private normalizeExternalState(value: unknown): boolean | undefined {
    return normalizeBooleanState(value, {
      trueValues: this.config.trueValueSet,
      falseValues: this.config.falseValueSet,
      caseSensitive: this.config.caseSensitive,
      invert: this.config.invert,
    });
  }

  /**
   * Resolves the target context prefix and stores the update when possible.
   */
  private tryStoreUpdate(update: ExternalStateUpdate): StoreResult {
    const prefix = this.resolvePrefix();
    if (prefix === undefined) {
      return "missing-config";
    }

    return this.storeWithPrefix(prefix, update);
  }

  /**
   * Resolves the external actor prefix from config export or manual config.
   */
  private resolvePrefix(): string | undefined {
    if (this.config.prefixSource === "manual") {
      return this.config.prefix;
    }

    return asConfigExport(this.getContext(this.config.configContext).get(this.config.configKey))
      ?.otherDevicesPrefix;
  }

  /**
   * Writes state and optional metadata to the selected Node-RED context store.
   */
  private storeWithPrefix(prefix: string, update: ExternalStateUpdate): NodeMessage | null {
    const context = this.getContext(this.config.storeContext);
    const stateKey = `${prefix}.${update.actorName}.state`;
    const previousState = context.get(stateKey);
    if (this.config.storeOnlyChanges && previousState === update.state) {
      this.setStatus({
        fill: "blue",
        shape: "dot",
        text: `${update.actorName} already ${formatState(update.state)}`,
      });
      return null;
    }

    const storedAt = Date.now();
    context.set(stateKey, update.state);
    if (this.config.storeMetadata) {
      const baseKey = `${prefix}.${update.actorName}`;
      context.set(`${baseKey}.updatedAt`, storedAt);
      context.set(`${baseKey}.sourceTopic`, update.sourceTopic ?? null);
      context.set(`${baseKey}.rawState`, update.rawState);
      context.set(`${baseKey}.retain`, update.retained);
    }

    this.setStatus({
      fill: "green",
      shape: "dot",
      text: `${update.actorName}: ${formatState(update.state)}`,
    });

    return {
      topic: update.actorName,
      payload: update.state,
      lshExternalState: {
        actorName: update.actorName,
        state: update.state,
        previousState: typeof previousState === "boolean" ? previousState : undefined,
        context: this.config.storeContext,
        key: stateKey,
        prefix,
        sourceTopic: update.sourceTopic,
        retained: update.retained,
        rawState: update.rawState,
        storedAt,
      },
    };
  }

  /**
   * Queues config-readiness problems or reports them immediately when waiting is disabled.
   */
  private deferOrSkip(update: ExternalStateUpdate): void {
    if (this.config.configWaitTimeoutMs <= 0) {
      this.skip(this.missingConfigWarning(), "Missing config");
      return;
    }

    this.queuePendingStore({
      ...update,
      deadline: Date.now() + this.config.configWaitTimeoutMs,
    });
  }

  /**
   * Stores the latest pending state for an actor and schedules the next config check.
   */
  private queuePendingStore(pending: PendingStore): void {
    const existing = this.pendingStores.get(pending.actorName);
    if (existing !== undefined) {
      clearTimeout(existing.timer);
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }

    // Only the latest state for a given actor matters. Replacing earlier
    // pending work avoids replaying stale retained/live states after lsh_config
    // finally appears.
    const delay = Math.max(0, Math.min(CONFIG_RETRY_INTERVAL_MS, pending.deadline - Date.now()));
    const nextPending = {
      ...pending,
      timer: setTimeout(() => this.retryPendingStore(pending.actorName), delay),
    };
    this.pendingStores.set(pending.actorName, nextPending);
    this.setStatus({
      fill: "blue",
      shape: "ring",
      text: `${pending.actorName} waiting config`,
    });
  }

  /**
   * Re-checks one queued actor and stores it once lsh_config is readable.
   */
  private retryPendingStore(actorName: string): void {
    const pending = this.pendingStores.get(actorName);
    if (pending === undefined) {
      return;
    }

    const result = this.tryStoreUpdate(pending);
    if (result === "missing-config") {
      if (Date.now() >= pending.deadline) {
        this.pendingStores.delete(actorName);
        this.skip(this.missingConfigWarning(), "Missing config");
        return;
      }

      this.queuePendingStore(pending);
      return;
    }

    this.pendingStores.delete(actorName);
    if (result !== null) {
      this.node.send(result);
    }
  }

  /**
   * Reads a configured Node-RED message property using the runtime utility API.
   */
  private readMessageProperty(msg: NodeMessage, propertyPath: string): unknown {
    return readMessageProperty(this.red, msg, propertyPath);
  }

  /**
   * Selects the configured flow/global context store.
   */
  private getContext(contextName: ContextName): ContextStore {
    return getNodeContext(this.node, contextName);
  }

  /**
   * Formats the warning shown when state parsing rejects an input message.
   */
  private invalidStateWarning(): string {
    return (
      `State property '${this.config.stateProperty}' must be boolean, 1/0, ` +
      "or one of the configured true/false text values."
    );
  }

  /**
   * Formats the warning shown when exported lsh_config is unavailable.
   */
  private missingConfigWarning(): string {
    return "Effective LSH config export is missing or does not include otherDevicesPrefix.";
  }

  /**
   * Reports an intentional no-op without throwing or failing the Node-RED message.
   */
  private skip(warning: string, statusText: string): null {
    return warnAndSetStatus(this.node, warning, {
      fill: "yellow",
      shape: "ring",
      text: statusText,
    });
  }

  /**
   * Updates the Node-RED node status with the package-wide status shape.
   */
  private setStatus(status: StatusShape): void {
    this.node.status(status);
  }
}

/**
 * Node-RED module entry point; registers the runtime class with the editor type.
 */
const nodeRedModule = function (RED: NodeAPI) {
  /**
   * Node-RED constructor wrapper that translates editor config into runtime state.
   */
  function LshExternalStateNodeWrapper(this: Node, config: LshExternalStateNodeDef) {
    RED.nodes.createNode(this, config);
    try {
      new LshExternalStateNode(this, RED, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Invalid node configuration: ${message}`);
      this.status({ fill: "red", shape: "ring", text: "Node Config Error" });
    }
  }

  RED.nodes.registerType("lsh-external-state", LshExternalStateNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshExternalStateNode });
