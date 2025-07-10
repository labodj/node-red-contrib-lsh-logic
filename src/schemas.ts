/**
 * @file Contains all JSON schema definitions for AJV validation.
 * This ensures that incoming MQTT payloads and configuration files
 * have the expected structure before being processed by the node.
 */

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
      description: "A list of primary actors controlled by this button.",
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
        "A list of secondary actor names (typically managed outside this system).",
      items: { type: "string" },
    },
  },
  required: ["id", "actors", "otherActors"],
};

/**
 * Schema for the main `longClickConfig.json` file.
 * It defines the overall structure, containing a list of all devices
 * and their associated button configurations.
 */
export const longClickConfigSchema = {
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
        required: ["name", "longClickButtons", "superLongClickButtons"],
      },
    },
  },
  required: ["devices"],
};

/**
 * Schema for the payload of an LSH device's 'conf' topic.
 * This payload provides the device's static configuration details.
 */
export const deviceConfPayloadSchema = {
  type: "object",
  properties: {
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
  required: ["ai", "bi", "dn"],
  additionalProperties: true, // Allow other properties, as firmware may add them.
};

/**
 * Schema for the payload of an LSH device's 'state' topic.
 * This payload reports the current state of all actuators.
 */
export const deviceStatePayloadSchema = {
  type: "object",
  properties: {
    as: {
      type: "array",
      items: { type: "boolean" },
      description: "Array of Actuator States (true=ON, false=OFF).",
    },
  },
  required: ["as"],
  additionalProperties: true, // Allow for future firmware extensions.
};

/** Schema for a Network Click payload ('c_nc'). */
export const networkClickPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "c_nc", description: "Protocol: Network Click." },
    bi: { type: "string", description: "Button ID that was pressed." },
    ct: { enum: ["lc", "slc"], description: "Click Type: 'lc' or 'slc'." },
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
export const deviceBootPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "d_b", description: "Protocol: Device Boot." },
  },
  required: ["p"],
  additionalProperties: true,
};

/** Schema for a Ping Response payload ('d_pr'). */
export const pingPayloadSchema = {
  type: "object",
  properties: {
    p: { const: "d_p", description: "Protocol: Ping." },
  },
  required: ["p"],
  additionalProperties: true,
};

/**
 * A "super-schema" that validates any valid 'misc' payload.
 * It uses a discriminator to efficiently select the correct sub-schema based on the 'p' property.
 * This allows validating any incoming 'misc' message with a single `validate` call.
 */
export const anyMiscPayloadSchema = {
  type: "object",
  discriminator: { propertyName: "p" },
  oneOf: [
    networkClickPayloadSchema,
    deviceBootPayloadSchema,
    pingPayloadSchema,
  ],
};
