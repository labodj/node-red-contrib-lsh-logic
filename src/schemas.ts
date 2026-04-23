/**
 * @file Contains all JSON schema definitions for AJV validation.
 * This file centralizes schema definitions to ensure that incoming MQTT payloads
 * and configuration files have the expected structure before being processed.
 * This approach prevents runtime errors from malformed data.
 */

import type { ValidateFunction } from "ajv";
import Ajv from "ajv";
import type {
  AnyBridgeTopicPayload,
  AnyEventsTopicPayload,
  DeviceActuatorsStatePayload,
  DeviceDetailsPayload,
  SystemConfig,
} from "./types";
import { ClickType, LshProtocol } from "./types";

const uint8IntegerSchema = {
  type: "integer",
  minimum: 0,
  maximum: 255,
} as const;

const positiveUint8IntegerSchema = {
  type: "integer",
  minimum: 1,
  maximum: 255,
} as const;

const nonEmptyStringSchema = {
  type: "string",
  minLength: 1,
} as const;

const mqttTopicSegmentSchema = {
  ...nonEmptyStringSchema,
  pattern: "^[A-Za-z0-9_-]+$",
} as const;

const homieNodeIdSchema = mqttTopicSegmentSchema;

const clickTypeEnum = Object.values(ClickType).filter(
  (value): value is number => typeof value === "number",
);

function hasUniqueItemProperty(propertyName: string, data: unknown): boolean {
  if (!Array.isArray(data)) {
    return true;
  }

  const seen = new Set<unknown>();
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const value = (item as Record<string, unknown>)[propertyName];
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
  }

  return true;
}

function hasCaseInsensitiveUniqueItemProperty(propertyName: string, data: unknown): boolean {
  if (!Array.isArray(data)) {
    return true;
  }

  const seen = new Set<string>();
  for (const item of data) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const value = (item as Record<string, unknown>)[propertyName];
    if (typeof value !== "string") {
      continue;
    }

    const normalizedValue = value.toLowerCase();
    if (seen.has(normalizedValue)) {
      return false;
    }
    seen.add(normalizedValue);
  }

  return true;
}

function hasCaseInsensitiveUniquePropertyNames(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return true;
  }

  const seen = new Set<string>();
  for (const propertyName of Object.keys(data)) {
    const normalizedPropertyName = propertyName.toLowerCase();
    if (seen.has(normalizedPropertyName)) {
      return false;
    }
    seen.add(normalizedPropertyName);
  }

  return true;
}

function hasValidActorReferences(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return true;
  }

  const devices = (data as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) {
    return true;
  }

  const configuredDeviceNames = new Set<string>();
  for (const device of devices) {
    if (device === null || typeof device !== "object" || Array.isArray(device)) {
      continue;
    }

    const deviceName = (device as { name?: unknown }).name;
    if (typeof deviceName === "string") {
      configuredDeviceNames.add(deviceName);
    }
  }

  for (const device of devices) {
    if (device === null || typeof device !== "object" || Array.isArray(device)) {
      continue;
    }

    const buttonGroups = [
      (device as { longClickButtons?: unknown }).longClickButtons,
      (device as { superLongClickButtons?: unknown }).superLongClickButtons,
    ];

    for (const buttonGroup of buttonGroups) {
      if (!Array.isArray(buttonGroup)) {
        continue;
      }

      for (const buttonAction of buttonGroup) {
        if (
          buttonAction === null ||
          typeof buttonAction !== "object" ||
          Array.isArray(buttonAction)
        ) {
          continue;
        }

        const actors = (buttonAction as { actors?: unknown }).actors;
        if (!Array.isArray(actors)) {
          continue;
        }

        for (const actor of actors) {
          if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
            continue;
          }

          const actorName = (actor as { name?: unknown }).name;
          if (typeof actorName === "string" && !configuredDeviceNames.has(actorName)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

const actorSchema = {
  type: "object",
  properties: {
    name: {
      ...mqttTopicSegmentSchema,
      description: "The exact configured name of the target device.",
    },
    allActuators: {
      type: "boolean",
      description: "Whether to control all actuators on the device.",
    },
    actuators: {
      type: "array",
      description: "A list of specific actuator IDs to control (if allActuators is false).",
      items: positiveUint8IntegerSchema,
      uniqueItems: true,
    },
  },
  required: ["name", "allActuators"],
  additionalProperties: false,
  if: {
    properties: { allActuators: { const: false } },
  },
  then: {
    required: ["actuators"],
    properties: {
      actuators: {
        type: "array",
        minItems: 1,
        items: positiveUint8IntegerSchema,
        uniqueItems: true,
      },
    },
  },
  else: {
    properties: {
      actuators: { type: "array", maxItems: 0, items: positiveUint8IntegerSchema },
    },
  },
} as const;

/**
 * Schema for a single button action configuration, used within `longClickConfigSchema`.
 * It defines the structure for specifying which actors are controlled by a button.
 * At least one target must exist across `actors` and `otherActors`.
 */
const buttonActionSchema = {
  type: "object",
  properties: {
    id: {
      ...positiveUint8IntegerSchema,
      description: "The unique identifier for the button (e.g., '7').",
    },
    actors: {
      type: "array",
      description: "A list of primary LSH actors controlled by this button.",
      uniqueItemProperty: "name",
      items: actorSchema,
    },
    otherActors: {
      type: "array",
      description: "A list of secondary actor names (e.g., Tasmota, Zigbee devices).",
      items: nonEmptyStringSchema,
      uniqueItems: true,
    },
  },
  required: ["id"],
  additionalProperties: false,
  anyOf: [
    {
      required: ["actors"],
      properties: {
        actors: {
          type: "array",
          minItems: 1,
        },
      },
    },
    {
      required: ["otherActors"],
      properties: {
        otherActors: {
          type: "array",
          minItems: 1,
        },
      },
    },
  ],
} as const;

const homeAssistantNodeDiscoveryConfigSchema = {
  type: "object",
  properties: {
    platform: {
      type: "string",
      enum: ["light", "switch", "fan"],
      description: "Optional Home Assistant entity platform override for this node.",
    },
    name: {
      ...nonEmptyStringSchema,
      description: "Optional Home Assistant friendly entity name override.",
    },
    defaultEntityId: {
      ...nonEmptyStringSchema,
      description: "Optional Home Assistant default entity ID override.",
    },
    icon: {
      ...nonEmptyStringSchema,
      description: "Optional Home Assistant icon override.",
    },
  },
  additionalProperties: false,
} as const;

const deviceHomeAssistantDiscoveryConfigSchema = {
  type: "object",
  properties: {
    deviceName: {
      ...nonEmptyStringSchema,
      description: "Optional Home Assistant device name override.",
    },
    defaultPlatform: {
      type: "string",
      enum: ["light", "switch", "fan"],
      description: "Optional default Home Assistant platform for all nodes of the device.",
    },
    nodes: {
      type: "object",
      description: "Optional per-node Home Assistant discovery overrides keyed by Homie node ID.",
      propertyNames: homieNodeIdSchema,
      caseInsensitiveUniquePropertyNames: true,
      additionalProperties: homeAssistantNodeDiscoveryConfigSchema,
    },
  },
  additionalProperties: false,
} as const;

/**
 * Schema for the main `system-config.json` file.
 * It defines the overall structure, containing a list of all devices
 * and their associated button configurations (which are optional).
 */
export const systemConfigSchema = {
  $id: "SystemConfig",
  description: "Schema for the main system-config.json file.",
  type: "object",
  properties: {
    devices: {
      type: "array",
      uniqueItemProperty: "name",
      caseInsensitiveUniqueItemProperty: "name",
      items: {
        type: "object",
        properties: {
          name: {
            ...mqttTopicSegmentSchema,
            description:
              "The unique name of the device. Must be a single MQTT topic segment using only letters, digits, '_' or '-'.",
          },
          longClickButtons: {
            type: "array",
            description: "Actions to perform on a long click.",
            items: buttonActionSchema,
            uniqueItemProperty: "id",
          },
          superLongClickButtons: {
            type: "array",
            description: "Actions to perform on a super-long click.",
            items: buttonActionSchema,
            uniqueItemProperty: "id",
          },
          haDiscovery: deviceHomeAssistantDiscoveryConfigSchema,
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["devices"],
  additionalProperties: false,
  validActorReferences: true,
} as const;

/**
 * Schema for the payload of an LSH device's 'conf' topic.
 * This payload provides the device's static configuration details.
 */
export const deviceDetailsPayloadSchema = {
  $id: "DeviceDetailsPayload",
  description: "Schema for a device's static configuration details.",
  type: "object",
  properties: {
    p: { const: LshProtocol.DEVICE_DETAILS },
    v: {
      ...uint8IntegerSchema,
      description: "Handshake-only protocol major.",
    },
    n: { ...nonEmptyStringSchema, description: "Device Name." },
    a: {
      type: "array",
      items: positiveUint8IntegerSchema,
      uniqueItems: true,
      description: "Array of Actuator IDs.",
    },
    b: {
      type: "array",
      items: positiveUint8IntegerSchema,
      uniqueItems: true,
      description: "Array of Button IDs.",
    },
  },
  required: ["p", "v", "n", "a", "b"],
  additionalProperties: false,
} as const;

/**
 * Schema for the payload of an LSH device's 'state' topic.
 * This payload reports the current state of all actuators using bitpacked bytes.
 */
export const deviceActuatorsStatePayloadSchema = {
  $id: "DeviceActuatorsStatePayload",
  description: "Schema for a device's bitpacked actuator states.",
  type: "object",
  properties: {
    p: { const: LshProtocol.ACTUATORS_STATE },
    s: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 255 },
      minItems: 0,
      description: "Array of bitpacked bytes (each byte = 8 actuator states).",
    },
  },
  required: ["p", "s"],
  additionalProperties: false,
} as const;

/** Schema for a Network Click Request payload. */
const networkClickRequestPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.NETWORK_CLICK_REQUEST },
    c: { ...positiveUint8IntegerSchema, description: "Click correlation ID." },
    i: { ...positiveUint8IntegerSchema, description: "Button ID that was pressed." },
    t: { enum: clickTypeEnum, description: "Click Type ID." },
  },
  required: ["p", "c", "i", "t"],
  additionalProperties: false,
} as const;

/** Schema for a Network Click Confirmation payload. */
const networkClickConfirmPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.NETWORK_CLICK_CONFIRM },
    c: { ...positiveUint8IntegerSchema, description: "Click correlation ID." },
    i: { ...positiveUint8IntegerSchema, description: "Button ID that was pressed." },
    t: { enum: clickTypeEnum, description: "Click Type ID." },
  },
  required: ["p", "c", "i", "t"],
  additionalProperties: false,
} as const;

/** Schema for a Ping payload. */
const pingPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.PING },
  },
  required: ["p"],
  additionalProperties: false,
} as const;

/**
 * Schema for bridge-local diagnostics emitted by `lsh-bridge` on the `bridge`
 * topic.
 * Keep this intentionally permissive: the diagnostic kind string is the
 * stable contract, while extra numeric fields may grow over time without
 * requiring a Node-RED package release first.
 */
const bridgeDiagnosticPayloadSchema = {
  type: "object",
  properties: {
    event: {
      const: "diagnostic",
      description: "Bridge-local diagnostic envelope.",
    },
    kind: {
      ...nonEmptyStringSchema,
      description: "Bridge-local diagnostic kind emitted on the bridge topic.",
    },
    pending_ms: {
      type: "integer",
      minimum: 0,
      description: "Optional pending batch duration for dropped actuator storms.",
    },
    mutation_count: {
      type: "integer",
      minimum: 0,
      description: "Optional accepted mutation count for a dropped actuator storm.",
    },
    dropped_device_commands: {
      type: "integer",
      minimum: 0,
      description: "Optional count of dropped device-topic commands.",
    },
    dropped_service_commands: {
      type: "integer",
      minimum: 0,
      description: "Optional count of dropped service-topic commands.",
    },
  },
  required: ["event", "kind"],
  additionalProperties: true,
} as const;

/**
 * Schema for bridge-local service ping replies emitted on the `bridge` topic.
 * Keep this tolerant to extra bridge-local diagnostics fields: Node-RED only
 * relies on the reachability booleans, while the bridge may append more
 * runtime metadata over time.
 */
const servicePingReplyPayloadSchema = {
  type: "object",
  properties: {
    event: {
      const: "service_ping_reply",
      description: "Bridge-local response to a service topic ping.",
    },
    controller_connected: {
      type: "boolean",
      description: "Whether the bridge currently sees the downstream controller link as alive.",
    },
    runtime_synchronized: {
      type: "boolean",
      description: "Whether the bridge runtime cache is synchronized with the controller.",
    },
    bootstrap_phase: {
      ...nonEmptyStringSchema,
      description: "Optional current bridge bootstrap phase for runtime diagnostics.",
    },
  },
  required: ["event", "controller_connected", "runtime_synchronized"],
  additionalProperties: true,
} as const;

/**
 * A "super-schema" that validates any valid 'events' topic payload.
 * It uses a `oneOf` keyword to ensure the payload matches exactly one of the
 * valid event schemas. This replaces the `discriminator` which required string values.
 */
export const anyEventsTopicPayloadSchema = {
  $id: "AnyEventsTopicPayload",
  description: "Schema for any valid 'events' topic payload.",
  type: "object",
  oneOf: [networkClickRequestPayloadSchema, networkClickConfirmPayloadSchema, pingPayloadSchema],
};

/**
 * A "super-schema" that validates any valid `bridge` topic payload.
 */
export const anyBridgeTopicPayloadSchema = {
  $id: "AnyBridgeTopicPayload",
  description: "Schema for any valid 'bridge' topic payload.",
  type: "object",
  oneOf: [servicePingReplyPayloadSchema, bridgeDiagnosticPayloadSchema],
};

/** An interface describing the collection of all validation functions for the app. */
export interface AppValidators {
  validateSystemConfig: ValidateFunction<SystemConfig>;
  validateDeviceDetails: ValidateFunction<DeviceDetailsPayload>;
  validateActuatorStates: ValidateFunction<DeviceActuatorsStatePayload>;
  validateAnyEventsTopic: ValidateFunction<AnyEventsTopicPayload>;
  validateAnyBridgeTopic: ValidateFunction<AnyBridgeTopicPayload>;
}

/**
 * Factory function to create and configure an AJV instance and compile all schemas.
 * This centralizes AJV setup and ensures consistency. Pre-compiling the schemas
 * into validation functions is a major performance optimization.
 * @returns An object containing all compiled validation functions for the application.
 */
export function createAppValidators(): AppValidators {
  const ajv = new Ajv({ discriminator: false, allErrors: true });
  ajv.addKeyword({
    keyword: "uniqueItemProperty",
    type: "array",
    schemaType: "string",
    validate: hasUniqueItemProperty,
    errors: false,
  });
  ajv.addKeyword({
    keyword: "caseInsensitiveUniqueItemProperty",
    type: "array",
    schemaType: "string",
    validate: hasCaseInsensitiveUniqueItemProperty,
    errors: false,
  });
  ajv.addKeyword({
    keyword: "caseInsensitiveUniquePropertyNames",
    type: "object",
    schemaType: "boolean",
    validate: (_schema: boolean, data: unknown) => hasCaseInsensitiveUniquePropertyNames(data),
    errors: false,
  });
  ajv.addKeyword({
    keyword: "validActorReferences",
    type: "object",
    schemaType: "boolean",
    validate: (_schema: boolean, data: unknown) => hasValidActorReferences(data),
    errors: false,
  });

  return {
    validateSystemConfig: ajv.compile<SystemConfig>(systemConfigSchema),
    validateDeviceDetails: ajv.compile<DeviceDetailsPayload>(deviceDetailsPayloadSchema),
    validateActuatorStates: ajv.compile<DeviceActuatorsStatePayload>(
      deviceActuatorsStatePayloadSchema,
    ),
    validateAnyEventsTopic: ajv.compile<AnyEventsTopicPayload>(anyEventsTopicPayloadSchema),
    validateAnyBridgeTopic: ajv.compile<AnyBridgeTopicPayload>(anyBridgeTopicPayloadSchema),
  };
}
