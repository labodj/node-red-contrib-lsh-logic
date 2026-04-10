/**
 * @file Contains all JSON schema definitions for AJV validation.
 * This file centralizes schema definitions to ensure that incoming MQTT payloads
 * and configuration files have the expected structure before being processed.
 * This approach prevents runtime errors from malformed data.
 */

import type { ValidateFunction } from "ajv";
import Ajv from "ajv";
import type {
  AnyMiscTopicPayload,
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

const actorSchema = {
  type: "object",
  properties: {
    name: {
      ...nonEmptyStringSchema,
      description: "The name of the target device.",
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
      items: actorSchema,
    },
    otherActors: {
      type: "array",
      description: "A list of secondary actor names (e.g., Tasmota, Zigbee devices).",
      items: nonEmptyStringSchema,
      uniqueItems: true,
    },
  },
  required: ["id", "actors", "otherActors"],
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
      items: {
        type: "object",
        properties: {
          name: {
            ...nonEmptyStringSchema,
            description: "The unique name of the device.",
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
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  },
  required: ["devices"],
  additionalProperties: false,
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

/** Schema for a Device Boot payload. */
const deviceBootPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.BOOT_NOTIFICATION },
  },
  required: ["p"],
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
 * A "super-schema" that validates any valid 'misc' topic payload.
 * It uses a `oneOf` keyword to ensure the payload matches exactly one of the
 * valid misc schemas. This replaces the `discriminator` which required string values.
 */
export const anyMiscTopicPayloadSchema = {
  $id: "AnyMiscTopicPayload",
  description: "Schema for any valid 'misc' topic payload.",
  type: "object",
  oneOf: [
    networkClickRequestPayloadSchema,
    networkClickConfirmPayloadSchema,
    deviceBootPayloadSchema,
    pingPayloadSchema,
  ],
  required: ["p"],
};

/** An interface describing the collection of all validation functions for the app. */
export interface AppValidators {
  validateSystemConfig: ValidateFunction<SystemConfig>;
  validateDeviceDetails: ValidateFunction<DeviceDetailsPayload>;
  validateActuatorStates: ValidateFunction<DeviceActuatorsStatePayload>;
  validateAnyMiscTopic: ValidateFunction<AnyMiscTopicPayload>;
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

  return {
    validateSystemConfig: ajv.compile<SystemConfig>(systemConfigSchema),
    validateDeviceDetails: ajv.compile<DeviceDetailsPayload>(deviceDetailsPayloadSchema),
    validateActuatorStates: ajv.compile<DeviceActuatorsStatePayload>(
      deviceActuatorsStatePayloadSchema,
    ),
    validateAnyMiscTopic: ajv.compile<AnyMiscTopicPayload>(anyMiscTopicPayloadSchema),
  };
}
