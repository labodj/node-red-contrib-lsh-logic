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
  LshProtocol,
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
      type: "integer",
      description: "The unique identifier for the button (e.g., '7').",
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
            items: { type: "integer" },
          },
        },
        required: ["name", "allActuators"],

        if: {
          properties: { allActuators: { const: false } },
        },
        then: {
          required: ["actuators"],
          properties: {
            actuators: { type: "array", minItems: 1 }
          }
        },
        else: {
          properties: {
            actuators: { type: "array", maxItems: 0 }
          }
        }
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
 * Schema for the payload of an LSH device's 'conf' topic.
 * This payload provides the device's static configuration details.
 */
export const deviceDetailsPayloadSchema = {
  $id: "DeviceDetailsPayload",
  description: "Schema for a device's static configuration details.",
  type: "object",
  properties: {
    p: { const: LshProtocol.DEVICE_DETAILS },
    n: { type: "string", description: "Device Name." },
    a: {
      type: "array",
      items: { type: "integer" },
      description: "Array of Actuator IDs.",
    },
    b: {
      type: "array",
      items: { type: "integer" },
      description: "Array of Button IDs.",
    },
  },
  required: ["p", "n", "a", "b"],
  additionalProperties: true,
};

/**
 * Schema for the payload of an LSH device's 'state' topic.
 * This payload reports the current state of all actuators.
 */
export const deviceActuatorsStatePayloadSchema = {
  $id: "DeviceActuatorsStatePayload",
  description: "Schema for a device's actuator states.",
  type: "object",
  properties: {
    p: { const: LshProtocol.ACTUATORS_STATE },
    s: {
      type: "array",
      items: { type: "integer", enum: [0, 1] },
      description: "Array of Actuator States (1=ON, 0=OFF).",
    },
  },
  required: ["p", "s"],
  additionalProperties: true,
};

/** Schema for a Network Click payload. */
const networkClickPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.NETWORK_CLICK },
    i: { type: "integer", description: "Button ID that was pressed." },
    t: { enum: Object.values(ClickType).filter(v => typeof v === 'number'), description: "Click Type ID." },
    c: { type: "integer", enum: [0, 1], description: "Confirmation flag." },
  },
  required: ["p", "i", "t", "c"],
  additionalProperties: true,
};

/** Schema for a Device Boot payload. */
const deviceBootPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.BOOT_NOTIFICATION },
  },
  required: ["p"],
  additionalProperties: true,
};

/** Schema for a Ping payload. */
const pingPayloadSchema = {
  type: "object",
  properties: {
    p: { const: LshProtocol.PING },
  },
  required: ["p"],
  additionalProperties: true,
};

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
  const ajv = new Ajv({ discriminator: false, allErrors: true });

  return {
    validateSystemConfig: ajv.compile<SystemConfig>(systemConfigSchema),
    validateDeviceDetails: ajv.compile<DeviceDetailsPayload>(deviceDetailsPayloadSchema),
    validateActuatorStates: ajv.compile<DeviceActuatorsStatePayload>(deviceActuatorsStatePayloadSchema),
    validateAnyMiscTopic: ajv.compile<AnyMiscTopicPayload>(anyMiscTopicPayloadSchema),
  };
}