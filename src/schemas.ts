/**
 * @file Contains all JSON schema definitions for AJV validation.
 * This file centralizes schema definitions to ensure that incoming MQTT payloads
 * and configuration files have the expected structure before being processed.
 * This approach prevents runtime errors from malformed data.
 */

import Ajv, { ValidateFunction } from "ajv";
import {
  AnyMiscTopicPayload,
  ClickType,
  DeviceActuatorsStatePayload,
  DeviceDetailsPayload,
  SystemConfig
} from "./types";


/**
 * Schema for a single button action configuration, used within `longClickConfigSchema`.
 * It defines the structure for specifying which actors are controlled by a button.
 */
const buttonActionSchema = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "The unique identifier for the button (e.g., 'B1').",
    },
    actors: {
      type: "array",
      description: "A list of primary LSH actors controlled by this button.",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the target device.",
          },
          allActuators: {
            type: "boolean",
            description: "Whether to control all actuators on the device.",
          },
          actuators: {
            type: "array",
            description:
              "A list of specific actuator IDs to control (if allActuators is false).",
            items: { type: "string" },
          },
        },
        required: ["name", "allActuators", "actuators"],
      },
    },
    otherActors: {
      type: "array",
      description:
        "A list of secondary actor names (e.g., Tasmota, Zigbee devices).",
      items: { type: "string" },
    },
  },
  required: ["id", "actors", "otherActors"],
};

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
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The unique name of the device.",
          },
          longClickButtons: {
            type: "array",
            description: "Actions to perform on a long click.",
            items: buttonActionSchema,
          },
          superLongClickButtons: {
            type: "array",
            description: "Actions to perform on a super-long click.",
            items: buttonActionSchema,
          },
        },
        required: ["name"],
      },
    },
  },
  required: ["devices"],
};


/**
 * Schema for the payload of an LSH device's 'conf' topic (`d_dd`).
 * This payload provides the device's static configuration details.
 */
export const deviceDetailsPayloadSchema = {
  $id: "DeviceDetailsPayload",
  description: "Schema for a device's static configuration details (d_dd).",
  type: "object",
  properties: {
    p: { const: "d_dd" },
    ai: {
      type: "array",
      items: { type: "string" },
      description: "Array of Actuator IDs.",
    },
    bi: {
      type: "array",
      items: { type: "string" },
      description: "Array of Button IDs.",
    },
    dn: { type: "string", description: "Device Name." },
  },
  required: ["p", "ai", "bi", "dn"],
  additionalProperties: true,
};

/**
 * Schema for the payload of an LSH device's 'state' topic (`d_as`).
 * This payload reports the current state of all actuators.
 */
export const deviceActuatorsStatePayloadSchema = {
  $id: "DeviceActuatorsStatePayload",
  description: "Schema for a device's actuator states (d_as).",
  type: "object",
  properties: {
    p: { const: "d_as" },
    as: {
      type: "array",
      items: { type: "boolean" },
      description: "Array of Actuator States (true=ON, false=OFF).",
    },
  },
  required: ["p", "as"],
  additionalProperties: true,
};

/** Schema for a Network Click payload ('c_nc'). */
const networkClickPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "c_nc", description: "Protocol: Network Click." },
    bi: { type: "string", description: "Button ID that was pressed." },
    ct: { enum: Object.values(ClickType), description: "Click Type: 'lc' or 'slc'." },
    c: {
      type: "boolean",
      description:
        "Confirmation flag: false for request, true for confirmation.",
    },
  },
  required: ["p", "bi", "ct", "c"],
  additionalProperties: true,
};

/** Schema for a Device Boot payload ('d_b'). */
const deviceBootPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "d_b", description: "Protocol: Device Boot." },
  },
  required: ["p"],
  additionalProperties: true,
};

/** Schema for a Ping payload ('d_p'). */
const pingPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "d_p", description: "Protocol: Ping." },
  },
  required: ["p"],
  additionalProperties: true,
};

/**
 * A "super-schema" that validates any valid 'misc' topic payload.
 * It uses a discriminator to efficiently select the correct sub-schema based
 * on the 'p' property. This allows validating any incoming 'misc' message
 * with a single `validate` call.
 */
export const anyMiscTopicPayloadSchema = {
  $id: "AnyMiscTopicPayload",
  description: "Discriminator schema for any valid 'misc' topic payload.",
  type: "object",
  discriminator: { propertyName: "p" },
  oneOf: [
    networkClickPayloadSchema,
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
  const ajv = new Ajv({ discriminator: true, allErrors: true });

  return {
    validateSystemConfig: ajv.compile<SystemConfig>(systemConfigSchema),
    validateDeviceDetails: ajv.compile<DeviceDetailsPayload>(deviceDetailsPayloadSchema),
    validateActuatorStates: ajv.compile<DeviceActuatorsStatePayload>(deviceActuatorsStatePayloadSchema),
    validateAnyMiscTopic: ajv.compile<AnyMiscTopicPayload>(anyMiscTopicPayloadSchema),
  };
}