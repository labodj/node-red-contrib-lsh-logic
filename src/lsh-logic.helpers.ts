import type { NodeMessage } from "node-red";

/**
 * Extracts a normalized topic string from an inbound Node-RED message.
 * Missing topics are treated as the empty string, while non-string topics are
 * rejected explicitly so the adapter fails in a controlled way.
 */
export function normalizeInboundTopic(
  msg: NodeMessage,
): { ok: true; topic: string } | { ok: false; error: string } {
  if (msg.topic === undefined || msg.topic === null) {
    return { ok: true, topic: "" };
  }

  if (typeof msg.topic !== "string") {
    return {
      ok: false,
      error: `Inbound msg.topic must be a string when provided, got ${typeof msg.topic}.`,
    };
  }

  return { ok: true, topic: msg.topic };
}

/**
 * Builds a stable signature for a semantic MQTT topic set.
 * Topics are compared as sets, not as user-defined ordered lists, so sorting is
 * required to avoid unnecessary churn when configuration order changes.
 */
export function buildTopicSetSignature(topics: string[]): string {
  return JSON.stringify([...topics].sort((left, right) => left.localeCompare(right)));
}

/**
 * Returns the Homie metadata subscriptions required by Home Assistant
 * auto-discovery. The retained metadata lets the discovery manager distinguish
 * writable toggle nodes from read-only or sensor-like nodes.
 */
export function getHomieDiscoveryTopics(homieBasePath: string): string[] {
  return [
    `${homieBasePath}+/$nodes`,
    `${homieBasePath}+/$mac`,
    `${homieBasePath}+/$fw/version`,
    `${homieBasePath}+/+/state/$datatype`,
    `${homieBasePath}+/+/state/$settable`,
  ];
}
