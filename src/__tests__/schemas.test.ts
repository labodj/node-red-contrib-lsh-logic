import { createAppValidators } from "../schemas";
import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol } from "../types";

describe("schemas", () => {
  const validators = createAppValidators();

  it("rejects duplicate device names in system config", () => {
    const isValid = validators.validateSystemConfig({
      devices: [{ name: "c1" }, { name: "c1" }],
    });

    expect(isValid).toBe(false);
  });

  it("ignores malformed unique-item candidates while still rejecting real duplicates", () => {
    const isValid = validators.validateSystemConfig({
      devices: [1, { name: "c1" }, { name: "c1" }],
    });

    expect(isValid).toBe(false);
  });

  it("rejects duplicate button IDs inside the same device click config", () => {
    const isValid = validators.validateSystemConfig({
      devices: [
        {
          name: "c1",
          longClickButtons: [
            { id: 1, actors: [], otherActors: [] },
            { id: 1, actors: [], otherActors: [] },
          ],
        },
      ],
    });

    expect(isValid).toBe(false);
  });

  it("rejects duplicate actuator or button IDs in details payloads", () => {
    const isValid = validators.validateDeviceDetails({
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "c1",
      a: [1, 1],
      b: [7, 7],
    });

    expect(isValid).toBe(false);
  });

  it("rejects additional properties on LSH payloads", () => {
    const detailsValid = validators.validateDeviceDetails({
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "c1",
      a: [1],
      b: [7],
      extra: true,
    });

    const miscValid = validators.validateAnyMiscTopic({
      p: LshProtocol.NETWORK_CLICK_REQUEST,
      c: 1,
      i: 7,
      t: ClickType.Long,
      extra: true,
    });

    expect(detailsValid).toBe(false);
    expect(miscValid).toBe(false);
  });

  it("rejects details payloads without the handshake protocol major", () => {
    const isValid = validators.validateDeviceDetails({
      p: LshProtocol.DEVICE_DETAILS,
      n: "c1",
      a: [1],
      b: [7],
    });

    expect(isValid).toBe(false);
  });

  it("rejects network click payloads without a correlation ID", () => {
    const isValid = validators.validateAnyMiscTopic({
      p: LshProtocol.NETWORK_CLICK_REQUEST,
      i: 7,
      t: ClickType.Long,
    });

    expect(isValid).toBe(false);
  });

  it("rejects zero-valued IDs in configs and protocol payloads", () => {
    const configValid = validators.validateSystemConfig({
      devices: [
        {
          name: "c1",
          longClickButtons: [{ id: 0, actors: [], otherActors: [] }],
        },
      ],
    });
    const detailsValid = validators.validateDeviceDetails({
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "c1",
      a: [0],
      b: [7],
    });
    const miscValid = validators.validateAnyMiscTopic({
      p: LshProtocol.NETWORK_CLICK_REQUEST,
      c: 0,
      i: 7,
      t: ClickType.Long,
    });

    expect(configValid).toBe(false);
    expect(detailsValid).toBe(false);
    expect(miscValid).toBe(false);
  });

  it("accepts empty bitpacked state payloads for zero-actuator devices", () => {
    const isValid = validators.validateActuatorStates({
      p: LshProtocol.ACTUATORS_STATE,
      s: [],
    });

    expect(isValid).toBe(true);
  });

  it("rejects non-array containers for click button configuration", () => {
    const isValid = validators.validateSystemConfig({
      devices: [
        {
          name: "c1",
          longClickButtons: {},
        },
      ],
    });

    expect(isValid).toBe(false);
  });
});
