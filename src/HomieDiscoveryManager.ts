import {
  buildDeviceCleanupMessages,
  buildDiscoveryPayloads,
  type DiscoveryMessage,
} from "./HomieDiscoveryManager.payloads";
import {
  normalizeDeviceDiscoveryConfig,
  normalizeDiscoveryStateDatatype,
  parseDiscoveryStateMetadataTopic,
  parseDiscoveryStateSettable,
} from "./HomieDiscoveryManager.helpers";
import { Output } from "./types";
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
  mac?: string;
  fw_version?: string;
  nodes?: string[];
  node_metadata?: Record<string, DiscoveryNodeRuntimeMetadata>;
  last_component_platforms?: Record<string, DiscoveryPlatform>;
  last_discovery_signature?: string;
  pending_discovery_flush_at?: number;
}

interface ReadyDeviceDiscoveryState extends DeviceDiscoveryState {
  mac: string;
  fw_version: string;
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
  private discoveryConfigDirty = false;
  private discoveryConfigSignature = "[]";
  private static readonly UNCONFIGURED_DEVICE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
  private static readonly VALID_NODE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
  private static readonly DISCOVERY_METADATA_SETTLE_MS = 150;

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
   * Flushes any ready device whose discovery publication was intentionally
   * delayed to let retained `state/$datatype` and `state/$settable` stabilize.
   */
  public flushPendingDiscovery(now: number = this.now()): ServiceResult {
    const result = createEmptyServiceResult();
    const discoveryMessages: DiscoveryMessage[] = [];
    let flushedDeviceCount = 0;

    this.pruneStaleWildcardDiscoveryState(now);
    this.appendPendingCleanupMessages(result);

    for (const [deviceId, deviceData] of this.discoveryState.entries()) {
      if (!this.isDeviceReady(deviceData)) {
        continue;
      }

      if (
        deviceData.pending_discovery_flush_at === undefined ||
        deviceData.pending_discovery_flush_at > now
      ) {
        continue;
      }

      const { messages, componentPlatforms, signature } = this.generateDiscoveryPayloads(
        deviceId,
        deviceData,
      );
      delete deviceData.pending_discovery_flush_at;
      deviceData.last_component_platforms = componentPlatforms;

      if (signature === deviceData.last_discovery_signature) {
        continue;
      }

      deviceData.last_discovery_signature = signature;
      discoveryMessages.push(...messages);
      flushedDeviceCount++;
    }

    if (discoveryMessages.length > 0) {
      appendLshMessages(result, discoveryMessages);
      result.logs.push(
        `Generated HA device discovery config for ${flushedDeviceCount} device(s) after metadata settle (${discoveryMessages.length} messages).`,
      );
    }

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
      if (this.shouldDeferDiscoveryPublication(deviceData, topicSuffix)) {
        deviceData.pending_discovery_flush_at =
          now + HomieDiscoveryManager.DISCOVERY_METADATA_SETTLE_MS;
        result.discoveryFlushDelayMs = HomieDiscoveryManager.DISCOVERY_METADATA_SETTLE_MS;
        return result;
      }

      const { messages, componentPlatforms, signature } = this.generateDiscoveryPayloads(
        canonicalDeviceId,
        deviceData,
      );
      if (signature !== deviceData.last_discovery_signature) {
        result.messages[Output.Lsh] = messages;
        deviceData.last_discovery_signature = signature;
        result.logs.push(
          `Generated HA device discovery config for ${deviceData.runtimeDeviceId} (${messages.length} messages)`,
        );
      }
      delete deviceData.pending_discovery_flush_at;
      deviceData.last_component_platforms = componentPlatforms;
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

  private shouldDeferDiscoveryPublication(
    data: ReadyDeviceDiscoveryState,
    topicSuffix: string,
  ): boolean {
    if (parseDiscoveryStateMetadataTopic(topicSuffix) !== null) {
      return true;
    }

    if (topicSuffix !== "/$nodes") {
      return false;
    }

    return data.nodes.some((nodeId) => {
      const metadata = data.node_metadata?.[nodeId.toLowerCase()];
      if (!metadata?.stateDatatype) {
        return true;
      }

      return metadata.stateDatatype === "boolean" && metadata.stateSettable === undefined;
    });
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
    const cleanupMessages = removedDeviceIds.flatMap((deviceId) =>
      this.buildDeviceCleanupMessages(deviceId),
    );
    appendLshMessages(result, cleanupMessages);
    result.logs.push(
      `Removed HA discovery config for ${removedDeviceIds.length} device(s) using ${cleanupMessages.length} retained cleanup message(s).`,
    );
  }

  private buildDeviceCleanupMessages(deviceId: string): DiscoveryMessage[] {
    return buildDeviceCleanupMessages(this.discoveryPrefix, this.toCanonicalDeviceId(deviceId));
  }

  /**
   * Updates the device state based on the incoming topic suffix and payload.
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
    const metadataTopic = parseDiscoveryStateMetadataTopic(topicSuffix);
    if (metadataTopic) {
      return this.updateNodeMetadata(
        deviceId,
        data,
        metadataTopic.nodeId,
        metadataTopic.field,
        payload,
      );
    }

    switch (topicSuffix) {
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
      case "/$nodes": {
        const {
          nodes: newNodes,
          rejectedNodes,
          caseCollidingNodes,
        } = this.normalizeDiscoveryNodes(payload);
        const warnings: string[] = [];
        if (rejectedNodes.length > 0) {
          warnings.push(
            `Ignored invalid Homie node id(s) for '${deviceId}': ${rejectedNodes.join(", ")}.`,
          );
        }
        if (caseCollidingNodes.length > 0) {
          warnings.push(
            `Ignored Homie node id(s) for '${deviceId}' because they collide case-insensitively with another node id: ${caseCollidingNodes.join(", ")}.`,
          );
        }
        if (newNodes.length === 0) {
          warnings.push(
            `Ignored Homie $nodes payload for '${deviceId}' because it contained no valid node ids.`,
          );
          return { changed: false, warnings };
        }
        if (!this.areNodesEqual(data.nodes, newNodes)) {
          data.nodes = newNodes;
          this.pruneNodeMetadata(data, newNodes);
          return { changed: true, warnings };
        }
        return { changed: false, warnings };
      }
    }
    return { changed: false, warnings: [] };
  }

  private updateNodeMetadata(
    deviceId: string,
    data: DeviceDiscoveryState,
    nodeId: string,
    field: "stateDatatype" | "stateSettable",
    payload: string,
  ): { changed: boolean; warnings: string[] } {
    const canonicalNodeId = nodeId.toLowerCase();
    const nodeMetadata = data.node_metadata ?? (data.node_metadata = {});
    const currentMetadata = nodeMetadata[canonicalNodeId] ?? {};

    if (field === "stateDatatype") {
      const normalizedDatatype = normalizeDiscoveryStateDatatype(payload);
      if (normalizedDatatype === null) {
        return {
          changed: false,
          warnings: [
            `Ignored Homie state datatype for '${deviceId}/${nodeId}' because it was empty.`,
          ],
        };
      }

      if (currentMetadata.stateDatatype === normalizedDatatype) {
        return { changed: false, warnings: [] };
      }

      nodeMetadata[canonicalNodeId] = {
        ...currentMetadata,
        stateDatatype: normalizedDatatype,
      };
      return { changed: true, warnings: [] };
    }

    const normalizedSettable = parseDiscoveryStateSettable(payload);
    if (normalizedSettable === null) {
      return {
        changed: false,
        warnings: [
          `Ignored Homie state settable flag for '${deviceId}/${nodeId}' because it was not 'true' or 'false'.`,
        ],
      };
    }

    if (currentMetadata.stateSettable === normalizedSettable) {
      return { changed: false, warnings: [] };
    }

    nodeMetadata[canonicalNodeId] = {
      ...currentMetadata,
      stateSettable: normalizedSettable,
    };
    return { changed: true, warnings: [] };
  }

  private pruneNodeMetadata(data: DeviceDiscoveryState, nodes: string[]): void {
    if (!data.node_metadata) {
      return;
    }

    const allowedNodeIds = new Set(nodes.map((nodeId) => nodeId.toLowerCase()));
    for (const nodeId of Object.keys(data.node_metadata)) {
      if (!allowedNodeIds.has(nodeId)) {
        delete data.node_metadata[nodeId];
      }
    }

    if (Object.keys(data.node_metadata).length === 0) {
      delete data.node_metadata;
    }
  }

  private normalizeDiscoveryNodes(payload: string): {
    nodes: string[];
    rejectedNodes: string[];
    caseCollidingNodes: string[];
  } {
    const nodesByCanonicalId = new Map<string, string>();
    const rejectedNodes: string[] = [];
    const caseCollidingNodes: string[] = [];

    for (const token of payload.split(",")) {
      const normalized = token.trim();
      if (!normalized) {
        continue;
      }

      if (!HomieDiscoveryManager.VALID_NODE_ID_PATTERN.test(normalized)) {
        rejectedNodes.push(normalized);
        continue;
      }

      const canonicalNodeId = normalized.toLowerCase();
      const existingNodeId = nodesByCanonicalId.get(canonicalNodeId);

      if (!existingNodeId) {
        nodesByCanonicalId.set(canonicalNodeId, normalized);
        continue;
      }

      if (existingNodeId !== normalized) {
        // Home Assistant entity IDs and config overrides are lowercased, so two
        // node ids that differ only by case would collapse onto the same entity.
        // Keep the first spelling we saw and surface the ambiguity explicitly.
        caseCollidingNodes.push(normalized);
      }
    }

    return {
      nodes: Array.from(nodesByCanonicalId.values()).sort(
        (left, right) =>
          left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right),
      ),
      rejectedNodes,
      caseCollidingNodes,
    };
  }

  /**
   * Compares two arrays of node strings for equality after canonicalization.
   * @param oldNodes - The existing array of nodes.
   * @param newNodes - The new array of nodes.
   * @returns True if both arrays contain the same canonical node set.
   */
  private areNodesEqual(oldNodes: string[] | undefined, newNodes: string[]): boolean {
    if (!oldNodes) return false;
    const canonicalOldNodes = Array.from(
      new Set(oldNodes.map((nodeId) => nodeId.toLowerCase())),
    ).sort((left, right) => left.localeCompare(right));
    const canonicalNewNodes = Array.from(
      new Set(newNodes.map((nodeId) => nodeId.toLowerCase())),
    ).sort((left, right) => left.localeCompare(right));
    if (canonicalOldNodes.length !== canonicalNewNodes.length) return false;
    return canonicalOldNodes.every((val, index) => val === canonicalNewNodes[index]);
  }

  /**
   * Checks if all required properties (mac, fw_version, nodes) are present.
   * @param data - The device state to check.
   * @returns True if the device is ready for discovery generation.
   */
  private isDeviceReady(data: DeviceDiscoveryState): data is ReadyDeviceDiscoveryState {
    return Boolean(data.mac && data.fw_version && data.nodes && data.nodes.length > 0);
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
      nodes: data.nodes,
      nodeMetadata: data.node_metadata ?? {},
      lastComponentPlatforms: data.last_component_platforms,
      discoveryConfig: this.discoveryConfigByDevice.get(deviceId),
    });
  }
}
