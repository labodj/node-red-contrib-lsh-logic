import { createAppValidators } from "../schemas";
import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol } from "../types";

describe("schemas", () => {
  const validators = createAppValidators();

  it("rejects duplicate identifiers across config and details payloads", () => {
    const duplicateCases = [
      () =>
        validators.validateSystemConfig({
          devices: [{ name: "c1" }, { name: "c1" }],
        }),
      () =>
        validators.validateSystemConfig({
          devices: [
            {
              name: "c1",
              longClickButtons: [
                { id: 1, actors: [], otherActors: [] },
                { id: 1, actors: [], otherActors: [] },
              ],
            },
          ],
        }),
      () =>
        validators.validateSystemConfig({
          devices: [
            {
              name: "c1",
              longClickButtons: [
                {
                  id: 1,
                  actors: [
                    { name: "actor-1", allActuators: false, actuators: [1] },
                    { name: "actor-1", allActuators: true, actuators: [] },
                  ],
                  otherActors: [],
                },
              ],
            },
            { name: "actor-1" },
          ],
        }),
      () =>
        validators.validateDeviceDetails({
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "c1",
          a: [1, 1],
          b: [7, 7],
        }),
    ];

    for (const validate of duplicateCases) {
      expect(validate()).toBe(false);
    }
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

    const eventsValid = validators.validateAnyEventsTopic({
      p: LshProtocol.NETWORK_CLICK_REQUEST,
      c: 1,
      i: 7,
      t: ClickType.Long,
      extra: true,
    });

    expect(detailsValid).toBe(false);
    expect(eventsValid).toBe(false);
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
    const isValid = validators.validateAnyEventsTopic({
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
    const eventsValid = validators.validateAnyEventsTopic({
      p: LshProtocol.NETWORK_CLICK_REQUEST,
      c: 0,
      i: 7,
      t: ClickType.Long,
    });

    expect(configValid).toBe(false);
    expect(detailsValid).toBe(false);
    expect(eventsValid).toBe(false);
  });

  it("accepts empty bitpacked state payloads for zero-actuator devices", () => {
    const isValid = validators.validateActuatorStates({
      p: LshProtocol.ACTUATORS_STATE,
      s: [],
    });

    expect(isValid).toBe(true);
  });

  it("accepts bridge-local diagnostic payloads on the bridge topic", () => {
    const isValid = validators.validateAnyBridgeTopic({
      event: "diagnostic",
      kind: "mqtt_queue_overflow",
      dropped_device_commands: 2,
      extra_future_field: true,
    });

    expect(isValid).toBe(true);
  });

  it("accepts service ping replies on the bridge topic", () => {
    const isValid = validators.validateAnyBridgeTopic({
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "runtime_ready",
      extra_future_field: true,
    });

    expect(isValid).toBe(true);
  });

  it("rejects non-array containers for click button configuration", () => {
    expect(
      validators.validateSystemConfig({
        devices: [
          {
            name: "c1",
            longClickButtons: {},
          },
        ],
      }),
    ).toBe(false);
  });

  it("accepts optional Home Assistant discovery overrides in system config", () => {
    const isValid = validators.validateSystemConfig({
      devices: [
        {
          name: "c1",
          haDiscovery: {
            deviceName: "Kitchen Board",
            defaultPlatform: "switch",
            nodes: {
              "1": {
                platform: "fan",
                name: "Kitchen Extractor",
                defaultEntityId: "fan.kitchen_extractor",
              },
            },
          },
        },
      ],
    });

    expect(isValid).toBe(true);
  });

  it("rejects unsupported Home Assistant platform overrides in system config", () => {
    const isValid = validators.validateSystemConfig({
      devices: [
        {
          name: "c1",
          haDiscovery: {
            defaultPlatform: "cover",
          },
        },
      ],
    });

    expect(isValid).toBe(false);
  });
});
