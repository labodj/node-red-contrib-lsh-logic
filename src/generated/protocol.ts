/**
 * Auto-generated from shared/lsh_protocol.json.
 * Do not edit manually. Run tools/generate_lsh_protocol.py instead.
 */

export const LSH_PROTOCOL_SPEC_REVISION = 2026041005 as const;
export const LSH_WIRE_PROTOCOL_MAJOR = 3 as const;

export const LSH_PROTOCOL_KEYS = {
  PAYLOAD: "p",
  PROTOCOL_MAJOR: "v",
  NAME: "n",
  ACTUATORS_ARRAY: "a",
  BUTTONS_ARRAY: "b",
  CORRELATION_ID: "c",
  ID: "i",
  STATE: "s",
  TYPE: "t",
} as const;

export enum ClickType {
  Long = 1,
  SuperLong = 2,
}

export enum LshProtocol {
  DEVICE_DETAILS = 1,
  ACTUATORS_STATE = 2,
  NETWORK_CLICK_REQUEST = 3,
  BOOT = 4,
  BOOT_NOTIFICATION = 4,
  PING = 5,
  REQUEST_DETAILS = 10,
  REQUEST_STATE = 11,
  SET_STATE = 12,
  SET_SINGLE_ACTUATOR = 13,
  NETWORK_CLICK_ACK = 14,
  FAILOVER = 15,
  GENERAL_FAILOVER = 15,
  FAILOVER_CLICK = 16,
  NETWORK_CLICK_CONFIRM = 17,
  SYSTEM_REBOOT = 254,
  REBOOT = 254,
  SYSTEM_RESET = 255,
  RESET = 255,
}
