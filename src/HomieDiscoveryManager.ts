import {
  buildDeviceCleanupMessages,
  buildDiscoveryPayloads,
  type DiscoveryMessage,
} from "./HomieDiscoveryManager.payloads";
import {
  normalizeDeviceDiscoveryConfig,
  parseHomieV5Description,
} from "./HomieDiscoveryManager.helpers";
import { appendLshMessages, createEmptyServiceResult } from "./LshLogicService.helpers";
import type { DeviceEntry, ServiceResult } from "./types";
import type {
  DiscoveryNodeRuntimeMetadata,
  DiscoveryPlatform,
  NormalizedDeviceDiscoveryConfig,
} from "./HomieDiscoveryManager.helpers";

/**
 * State definitions for the Homie Discovery Manager.
 */
interface DeviceDiscoveryState {
  lastSeenAt: number;
  runtimeDeviceId: string;
  homieName?: string;
  homieType?: string;
  homieDescriptionVersion?: number;
  homieChildren?: string[];
  homieExtensions?: string[];
  homieParent?: string;
  homieRoot?: string;
  effectiveBaseTopic?: string;
  mac?: string;
  fw_version?: string;
  nodes?: string[];
  node_metadata?: Record<string, DiscoveryNodeRuntimeMetadata>;
  last_component_platforms?: Record<string, DiscoveryPlatform>;
  last_discovery_signature?: string;
}

interface ReadyDeviceDiscoveryState extends DeviceDiscoveryState {
  nodes: string[];
}

/**
 * Manages the conversion of Homie devices to Home Assistant MQTT device discovery payloads.
 * It keeps enough in-memory state to emit an explicit component-removal update before the
 * final retained payload whenever the Homie node list shrinks.
 */
export class HomieDiscoveryManager {
  private readonly discoveryState: Map<string, DeviceDiscoveryState> = new Map();
  private readonly discoveryConfigByDevice: Map<string, NormalizedDeviceDiscoveryConfig> =
    new Map();
  private readonly configuredDeviceIds: Set<string> = new Set();
  private readonly pendingCleanupDeviceIds: Set<string> = new Set();
  private readonly pendingDiscoveryDeviceIds: Set<string> = new Set();
  private discoveryConfigDirty = false;
  private discoveryConfigSignature = "[]";
  private static readonly DISCOVERY_FLUSH_DEBOUNCE_MS = 250;
  private static readonly UNCONFIGURED_DEVICE_STATE_TTL_MS = 24 * 60 * 60 * 1000;

  constructor(
    private readonly homieBasePath: string,
    private readonly discoveryPrefix: string = "homeassistant",
    private readonly now: () => number = Date.now,
  ) {}

  private toCanonicalDeviceId(deviceId: string): string {
    return deviceId.toLowerCase();
  }

  public setDiscoveryConfig(deviceConfigMap: ReadonlyMap<string, DeviceEntry>): void {
    const seenDeviceIds = new Map<string, string>();
    for (const deviceId of deviceConfigMap.keys()) {
      const canonicalDeviceId = deviceId.toLowerCase();
      const previousDeviceId = seenDeviceIds.get(canonicalDeviceId);
      if (previousDeviceId) {
        throw new Error(
          `Configured device names '${previousDeviceId}' and '${deviceId}' collide after case-insensitive normalization used by Home Assistant discovery.`,
        );
      }
      seenDeviceIds.set(canonicalDeviceId, deviceId);
    }

    const previouslyConfiguredDeviceIds = new Set(this.configuredDeviceIds);
    const nextConfigEntries: Array<[string, NormalizedDeviceDiscoveryConfig | null]> = [];
    this.configuredDeviceIds.clear();
    this.discoveryConfigByDevice.clear();

    for (const [deviceId, deviceEntry] of Array.from(deviceConfigMap.entries()).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const canonicalDeviceId = this.toCanonicalDeviceId(deviceId);
      this.configuredDeviceIds.add(canonicalDeviceId);
      const normalizedConfig = normalizeDeviceDiscoveryConfig(deviceEntry.haDiscovery);
      if (normalizedConfig) {
        this.discoveryConfigByDevice.set(canonicalDeviceId, normalizedConfig);
      }
      nextConfigEntries.push([canonicalDeviceId, normalizedConfig ?? null]);
    }

    for (const deviceId of previouslyConfiguredDeviceIds) {
      if (!this.configuredDeviceIds.has(deviceId)) {
        this.pendingCleanupDeviceIds.add(deviceId);
        this.discoveryState.delete(deviceId);
      }
    }

    const nextSignature = JSON.stringify(nextConfigEntries);
    if (nextSignature !== this.discoveryConfigSignature) {
      this.discoveryConfigDirty = true;
      this.discoveryConfigSignature = nextSignature;
    }

    this.pruneStaleWildcardDiscoveryState(this.now());
  }

  public reset(): ServiceResult {
    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (deviceData.last_component_platforms !== undefined) {
        this.pendingCleanupDeviceIds.add(deviceId);
      }
    }

    const result = createEmptyServiceResult();
    this.appendPendingCleanupMessages(result);
    this.configuredDeviceIds.clear();
    this.discoveryConfigByDevice.clear();
    this.discoveryState.clear();
    this.pendingDiscoveryDeviceIds.clear();
    this.discoveryConfigDirty = false;
    this.discoveryConfigSignature = "[]";
    return result;
  }

  /**
   * Regenerates retained discovery payloads only when the effective configured
   * discovery model changed. Cleanup payloads for removed devices are still
   * emitted immediately when present.
   */
  public syncConfigIfNeeded(): ServiceResult {
    return this.collectDiscoveryPayloads(false);
  }

  public regenerateDiscoveryPayloads(): ServiceResult {
    return this.collectDiscoveryPayloads(true);
  }

  /**
   * Handles the Homie v5 device-removal signal: an empty retained `$state`
   * payload means the device no longer exists. Discovery cleanup is emitted only
   * when this manager had previously published retained Home Assistant config.
   */
  public removeDevice(deviceId: string): ServiceResult {
    const canonicalDeviceId = this.toCanonicalDeviceId(deviceId);
    const deviceData = this.discoveryState.get(canonicalDeviceId);

    if (deviceData?.last_component_platforms !== undefined) {
      this.pendingCleanupDeviceIds.add(canonicalDeviceId);
    }
    this.discoveryState.delete(canonicalDeviceId);

    const result = createEmptyServiceResult();
    this.appendPendingCleanupMessages(result);
    return result;
  }

  /**
   * Flushes debounced Homie v5 discovery updates and pending cleanup tombstones.
   * Homie v5 carries the full model in `$description`, while optional fork
   * metadata such as `$mac` and `$fw/version` may arrive in the same retained
   * replay burst. Deferring publication briefly lets Home Assistant receive one
   * complete retained config instead of multiple incremental replacements.
   */
  public flushPendingDiscovery(now: number = this.now()): ServiceResult {
    const result = createEmptyServiceResult();

    this.pruneStaleWildcardDiscoveryState(now);
    this.appendPendingCleanupMessages(result);
    this.appendPendingDiscoveryMessages(result);

    return result;
  }

  /**
   * Collects retained discovery payloads through the single production code path.
   * `syncConfigIfNeeded()` uses this with `force=false`, while tests and explicit
   * maintenance paths may use `force=true` without duplicating the generation logic.
   */
  private collectDiscoveryPayloads(force: boolean): ServiceResult {
    const result = createEmptyServiceResult();
    const discoveryMessages: DiscoveryMessage[] = [];
    this.pruneStaleWildcardDiscoveryState(this.now());
    this.appendPendingCleanupMessages(result);

    if (!force && !this.discoveryConfigDirty) {
      return result;
    }

    this.discoveryConfigDirty = false;

    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (!this.isDeviceReady(deviceData)) {
        continue;
      }

      const { messages, componentPlatforms, signature } = this.generateDiscoveryPayloads(
        deviceId,
        deviceData,
      );
      if (force || signature !== deviceData.last_discovery_signature) {
        discoveryMessages.push(...messages);
        deviceData.last_discovery_signature = signature;
      }
      deviceData.last_component_platforms = componentPlatforms;
      this.pendingDiscoveryDeviceIds.delete(deviceId);
    }

    if (discoveryMessages.length > 0) {
      appendLshMessages(result, discoveryMessages);
      result.logs.push(
        `Regenerated HA device discovery config for ${discoveryMessages.length} retained message(s).`,
      );
    }

    return result;
  }

  public pruneExpiredDiscoveryState(now: number = this.now()): ServiceResult {
    this.pruneStaleWildcardDiscoveryState(now);
    const result = createEmptyServiceResult();
    this.appendPendingCleanupMessages(result);
    return result;
  }

  /**
   * Processes incoming Homie attribute messages to build up device state
   * and generate discovery payloads when ready.
   */
  public processDiscoveryMessage(
    deviceId: string,
    topicSuffix: string,
    payload: string,
  ): ServiceResult {
    const result = createEmptyServiceResult();
    const now = this.now();
    const canonicalDeviceId = this.toCanonicalDeviceId(deviceId);
    this.pruneStaleWildcardDiscoveryState(now);

    const deviceData = this.getOrCreateDeviceData(deviceId, canonicalDeviceId, now);
    deviceData.lastSeenAt = now;
    deviceData.runtimeDeviceId = deviceId;
    const { changed: updated, warnings } = this.updateDeviceData(
      deviceId,
      deviceData,
      topicSuffix,
      payload,
    );
    result.warnings.push(...warnings);

    if (updated && this.isDeviceReady(deviceData)) {
      this.pendingDiscoveryDeviceIds.add(canonicalDeviceId);
      result.discoveryFlushDelayMs = HomieDiscoveryManager.DISCOVERY_FLUSH_DEBOUNCE_MS;
    }

    return result;
  }

  /**
   * Retrieves existing state for a device or creates a new one.
   * @param deviceId - The device identifier.
   * @returns The discovery state object for the device.
   */
  private getOrCreateDeviceData(
    runtimeDeviceId: string,
    canonicalDeviceId: string,
    now: number,
  ): DeviceDiscoveryState {
    let deviceData = this.discoveryState.get(canonicalDeviceId);
    if (!deviceData) {
      // A wildcard device may legitimately reappear after its transient state
      // was pruned but before the retained cleanup queue is flushed. In that
      // case the pending tombstones must be cancelled so the renewed discovery
      // config is not deleted by a stale cleanup batch.
      this.pendingCleanupDeviceIds.delete(canonicalDeviceId);
      deviceData = { lastSeenAt: now, runtimeDeviceId };
      this.discoveryState.set(canonicalDeviceId, deviceData);
    }
    return deviceData;
  }

  /**
   * Wildcard discovery intentionally accepts devices that are not yet present
   * in the system config, but their transient state must remain bounded when
   * IDs churn over time.
   */
  private pruneStaleWildcardDiscoveryState(now: number): void {
    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (this.configuredDeviceIds.has(deviceId)) {
        continue;
      }

      if (now - deviceData.lastSeenAt > HomieDiscoveryManager.UNCONFIGURED_DEVICE_STATE_TTL_MS) {
        this.pendingCleanupDeviceIds.add(deviceId);
        this.discoveryState.delete(deviceId);
      }
    }
  }

  private appendPendingCleanupMessages(result: ServiceResult): void {
    const removedDeviceIds = Array.from(this.pendingCleanupDeviceIds).sort((left, right) =>
      left.localeCompare(right),
    );
    if (removedDeviceIds.length === 0) {
      return;
    }

    this.pendingCleanupDeviceIds.clear();
    for (const deviceId of removedDeviceIds) {
      this.pendingDiscoveryDeviceIds.delete(deviceId);
    }
    const cleanupMessages = removedDeviceIds.flatMap((deviceId) =>
      this.buildDeviceCleanupMessages(deviceId),
    );
    appendLshMessages(result, cleanupMessages);
    result.logs.push(
      `Removed HA discovery config for ${removedDeviceIds.length} device(s) using ${cleanupMessages.length} retained cleanup message(s).`,
    );
  }

  private appendPendingDiscoveryMessages(result: ServiceResult): void {
    const pendingDeviceIds = Array.from(this.pendingDiscoveryDeviceIds).sort((left, right) =>
      left.localeCompare(right),
    );
    if (pendingDeviceIds.length === 0) {
      return;
    }

    this.pendingDiscoveryDeviceIds.clear();
    const discoveryMessages: DiscoveryMessage[] = [];
    const publishedDeviceIds: string[] = [];

    for (const deviceId of pendingDeviceIds) {
      const deviceData = this.discoveryState.get(deviceId);
      if (!deviceData || !this.isDeviceReady(deviceData)) {
        continue;
      }

      const { messages, componentPlatforms, signature } = this.generateDiscoveryPayloads(
        deviceId,
        deviceData,
      );
      deviceData.last_component_platforms = componentPlatforms;

      if (signature === deviceData.last_discovery_signature) {
        continue;
      }

      discoveryMessages.push(...messages);
      publishedDeviceIds.push(deviceData.runtimeDeviceId);
      deviceData.last_discovery_signature = signature;
    }

    if (discoveryMessages.length === 0) {
      return;
    }

    appendLshMessages(result, discoveryMessages);
    result.logs.push(
      `Generated HA device discovery config for ${publishedDeviceIds.join(", ")} (${discoveryMessages.length} messages)`,
    );
  }

  private buildDeviceCleanupMessages(deviceId: string): DiscoveryMessage[] {
    return buildDeviceCleanupMessages(this.discoveryPrefix, this.toCanonicalDeviceId(deviceId));
  }

  /**
   * Updates the device state based on the incoming topic suffix and payload.
   * Homie v5 discovery is driven by `$description`; `$mac` and `$fw/version`
   * are accepted as optional fork extensions so Home Assistant can show richer
   * device metadata when those retained attributes are available.
   * @param data - The mutable device state object.
   * @param topicSuffix - The specific Homie attribute being updated (e.g., '/$mac').
   * @param payload - The new value for the attribute.
   * @returns True if the state was updated, false otherwise.
   */
  private updateDeviceData(
    deviceId: string,
    data: DeviceDiscoveryState,
    topicSuffix: string,
    payload: string,
  ): { changed: boolean; warnings: string[] } {
    switch (topicSuffix) {
      case "/$description":
        return this.updateFromDescription(deviceId, data, payload);
      case "/$mac": {
        if (data.mac !== payload) {
          data.mac = payload;
          return { changed: true, warnings: [] };
        }
        break;
      }
      case "/$fw/version": {
        if (data.fw_version !== payload) {
          data.fw_version = payload;
          return { changed: true, warnings: [] };
        }
        break;
      }
      case "/$implementation/config":
        return this.updateFromImplementationConfig(deviceId, data, payload);
    }
    return { changed: false, warnings: [] };
  }

  private updateFromImplementationConfig(
    deviceId: string,
    data: DeviceDiscoveryState,
    payload: string,
  ): { changed: boolean; warnings: string[] } {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      return {
        changed: false,
        warnings: [
          `Ignored Homie implementation config for '${deviceId}' because it is not valid JSON.`,
        ],
      };
    }

    if (
      typeof parsedPayload !== "object" ||
      parsedPayload === null ||
      Array.isArray(parsedPayload) ||
      !("mqtt" in parsedPayload) ||
      typeof parsedPayload.mqtt !== "object" ||
      parsedPayload.mqtt === null ||
      Array.isArray(parsedPayload.mqtt)
    ) {
      return { changed: false, warnings: [] };
    }

    const mqttConfig = parsedPayload.mqtt as Record<string, unknown>;
    const effectiveBaseTopic =
      typeof mqttConfig.effective_base_topic === "string"
        ? mqttConfig.effective_base_topic
        : undefined;
    const warnings: string[] = [];
    if (effectiveBaseTopic && effectiveBaseTopic !== this.homieBasePath) {
      warnings.push(
        `Homie device '${deviceId}' advertises effective_base_topic='${effectiveBaseTopic}', but this node is configured for homieBasePath='${this.homieBasePath}'.`,
      );
    }

    if (data.effectiveBaseTopic !== effectiveBaseTopic) {
      data.effectiveBaseTopic = effectiveBaseTopic;
      return { changed: true, warnings };
    }

    return { changed: false, warnings };
  }

  private updateFromDescription(
    deviceId: string,
    data: DeviceDiscoveryState,
    payload: string,
  ): { changed: boolean; warnings: string[] } {
    const parsedDescription = parseHomieV5Description(deviceId, payload);
    if (!parsedDescription.ok) {
      return { changed: false, warnings: parsedDescription.warnings };
    }

    const {
      children,
      deviceName,
      deviceType,
      extensions,
      nodeMetadata,
      nodes,
      parent,
      root,
      version,
    } = parsedDescription.description;
    const oldSignature = this.buildDescriptionSignature(data);
    data.homieName = deviceName;
    data.homieType = deviceType;
    data.homieDescriptionVersion = version;
    data.homieChildren = children;
    data.homieExtensions = extensions;
    data.homieParent = parent;
    data.homieRoot = root;
    data.nodes = nodes;
    data.node_metadata = nodeMetadata;

    return {
      changed: oldSignature !== this.buildDescriptionSignature(data),
      warnings: parsedDescription.warnings,
    };
  }

  private buildDescriptionSignature(data: DeviceDiscoveryState): string {
    return JSON.stringify({
      homieName: data.homieName,
      homieType: data.homieType,
      homieDescriptionVersion: data.homieDescriptionVersion,
      homieChildren: data.homieChildren ?? [],
      homieExtensions: data.homieExtensions ?? [],
      homieParent: data.homieParent,
      homieRoot: data.homieRoot,
      effectiveBaseTopic: data.effectiveBaseTopic,
      nodes: data.nodes ?? [],
      nodeMetadata: data.node_metadata ?? {},
    });
  }

  /**
   * Checks if the atomic Homie v5 description supplied at least one state node.
   * MAC and firmware are optional fork extensions, so they must not block HA
   * discovery for standards-compliant Homie v5 devices.
   * @param data - The device state to check.
   * @returns True if the device is ready for discovery generation.
   */
  private isDeviceReady(data: DeviceDiscoveryState): data is ReadyDeviceDiscoveryState {
    return Boolean(data.nodes && data.nodes.length > 0);
  }

  /**
   * Main orchestrator for generating retained device discovery messages for a device.
   * When components disappear, HA expects a transitional update that carries only the
   * platform for each removed component before the final payload omits it entirely.
   */
  private generateDiscoveryPayloads(
    deviceId: string,
    data: ReadyDeviceDiscoveryState,
  ): {
    messages: DiscoveryMessage[];
    componentPlatforms: Record<string, DiscoveryPlatform>;
    signature: string;
  } {
    return buildDiscoveryPayloads({
      canonicalDeviceId: deviceId,
      runtimeDeviceId: data.runtimeDeviceId,
      homieBasePath: this.homieBasePath,
      discoveryPrefix: this.discoveryPrefix,
      mac: data.mac,
      fwVersion: data.fw_version,
      deviceName: data.homieName,
      deviceType: data.homieType,
      homieParent: data.homieParent,
      homieRoot: data.homieRoot,
      nodes: data.nodes,
      nodeMetadata: data.node_metadata ?? {},
      lastComponentPlatforms: data.last_component_platforms,
      discoveryConfig: this.discoveryConfigByDevice.get(deviceId),
    });
  }
}
