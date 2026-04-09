import { ClickTransactionManager } from "../ClickTransactionManager";
import { ClickType, LshProtocol, Output, SystemConfig } from "../types";
import {
  createLoadedServiceHarness,
  createServiceHarness,
  getOtherActorsPayload,
  getOutputMessages,
  getSingleOutputMessage,
  ServiceHarness,
} from "./helpers/serviceTestUtils";

const defaultClickSystemConfig: SystemConfig = {
  devices: [
    {
      name: "device-sender",
      longClickButtons: [
        {
          id: 1,
          actors: [{ name: "actor1", allActuators: true, actuators: [] }],
          otherActors: [],
        },
      ],
      superLongClickButtons: [
        {
          id: 1,
          actors: [{ name: "actor1", allActuators: true, actuators: [] }],
          otherActors: [],
        },
      ],
    },
    { name: "actor1" },
  ],
};

const createClickHarness = (
  systemConfig: SystemConfig = defaultClickSystemConfig
) => createLoadedServiceHarness({ systemConfig });

const startClick = (
  sendMisc: ServiceHarness["sendMisc"],
  deviceName: string,
  clickType: ClickType = ClickType.Long,
  buttonId = 1
) =>
  sendMisc(deviceName, {
    p: LshProtocol.NETWORK_CLICK_REQUEST,
    i: buttonId,
    t: clickType,
  });

const confirmClick = (
  sendMisc: ServiceHarness["sendMisc"],
  deviceName: string,
  clickType: ClickType = ClickType.Long,
  buttonId = 1
) =>
  sendMisc(deviceName, {
    p: LshProtocol.NETWORK_CLICK_CONFIRM,
    i: buttonId,
    t: clickType,
  });

describe("LshLogicService - Network Click Logic", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should handle the 3-way click handshake", () => {
    const { setDeviceOnline, sendMisc } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const requestResult = startClick(sendMisc, "device-sender");

    expect(
      getSingleOutputMessage<{ p: number }>(requestResult, Output.Lsh).payload.p
    ).toBe(LshProtocol.NETWORK_CLICK_ACK);

    const confirmResult = confirmClick(sendMisc, "device-sender");

    expect(confirmResult.logs).toContain(
      "Click confirmed for device-sender.1.1. Executing logic."
    );
    expect(getOutputMessages(confirmResult, Output.Lsh)[0].topic).toBe(
      "LSH/actor1/IN"
    );
  });

  it("should reject confirmations for unknown or expired clicks", () => {
    const { setDeviceOnline, sendMisc } = createClickHarness();
    setDeviceOnline("device-sender");

    const result = confirmClick(sendMisc, "device-sender", ClickType.Long, 99);

    expect(result.warnings).toContain(
      "Received confirmation for an expired or unknown click: device-sender.99.1."
    );
  });

  it("should handle a super-long click by turning the target off", () => {
    const { setDeviceOnline, sendMisc } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendMisc, "device-sender", ClickType.SuperLong);
    const result = confirmClick(sendMisc, "device-sender", ClickType.SuperLong);

    const command = getOutputMessages(result, Output.Lsh)[0] as {
      payload: { p: number; s: number[] };
    };
    expect(command.payload.p).toBe(LshProtocol.SET_STATE);
    expect(command.payload.s).toEqual([0]);
  });

  it("should target a specific subset of actuators with packed state", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender",
          longClickButtons: [
            {
              id: 1,
              actors: [{ name: "actor1", allActuators: false, actuators: [1, 3] }],
              otherActors: [],
            },
          ],
        },
        { name: "actor1" },
      ],
    };

    const { setDeviceOnline, sendLshState, sendMisc } =
      createClickHarness(systemConfig);
    setDeviceOnline("sender");
    setDeviceOnline("actor1", { a: [1, 2, 3, 4] });
    sendLshState("actor1", [0]);

    startClick(sendMisc, "sender");
    const result = confirmClick(sendMisc, "sender");

    const command = getOutputMessages(result, Output.Lsh)[0] as {
      payload: { p: number; s: number[] };
    };
    expect(command.payload.p).toBe(LshProtocol.SET_STATE);
    expect(command.payload.s).toEqual([5]);
  });

  it("should use SET_SINGLE_ACTUATOR when a single actuator is targeted", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "device-sender-specific",
          longClickButtons: [
            {
              id: 1,
              actors: [
                { name: "actor1", allActuators: false, actuators: [2] },
              ],
              otherActors: [],
            },
          ],
        },
        { name: "actor1" },
      ],
    };

    const { setDeviceOnline, sendMisc } = createClickHarness(systemConfig);
    setDeviceOnline("actor1", { a: [1, 2] });
    setDeviceOnline("device-sender-specific");

    startClick(sendMisc, "device-sender-specific");
    const result = confirmClick(sendMisc, "device-sender-specific");

    const command = getOutputMessages(result, Output.Lsh)[0] as {
      payload: { p: number; i: number; s: number };
    };
    expect(command.payload).toEqual({
      p: LshProtocol.SET_SINGLE_ACTUATOR,
      i: 2,
      s: 1,
    });
  });

  it("should correctly unpack bitpacked actuator states", () => {
    const { loadConfig, sendDeviceDetails, sendLshState, service } =
      createServiceHarness();
    loadConfig();
    sendDeviceDetails("actor1", { a: [1, 2, 3, 4, 5, 6, 7, 8, 9] });

    const result = sendLshState("actor1", [0b10101010, 0b00000001]);
    const actorState = service.getDeviceRegistry()["actor1"];

    expect(result.stateChanged).toBe(true);
    expect(actorState.actuatorStates[0]).toBe(false);
    expect(actorState.actuatorStates[1]).toBe(true);
    expect(actorState.actuatorStates[8]).toBe(true);
  });

  it("should include other actors in click execution results", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender-other",
          longClickButtons: [
            { id: 1, actors: [], otherActors: ["zigbee-bulb"] },
          ],
        },
      ],
    };

    const { setDeviceOnline, sendMisc, contextReader } =
      createClickHarness(systemConfig);
    setDeviceOnline("sender-other");
    contextReader.get.mockReturnValue(false);

    startClick(sendMisc, "sender-other");
    const result = confirmClick(sendMisc, "sender-other");

    expect(getOtherActorsPayload(result)).toEqual({
      otherActors: ["zigbee-bulb"],
      stateToSet: true,
    });
  });

  it("should propagate smart-toggle warnings for other actors with unknown state", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender-other",
          longClickButtons: [
            { id: 1, actors: [], otherActors: ["zigbee-bulb"] },
          ],
        },
      ],
    };

    const { setDeviceOnline, sendMisc, contextReader } =
      createClickHarness(systemConfig);
    setDeviceOnline("sender-other");
    contextReader.get.mockReturnValue("unknown");

    startClick(sendMisc, "sender-other");
    const result = confirmClick(sendMisc, "sender-other");

    expect(result.warnings).toContain(
      "State for otherActor 'zigbee-bulb' not found or not a boolean."
    );
    expect(getOtherActorsPayload(result)).toEqual({
      otherActors: ["zigbee-bulb"],
      stateToSet: false,
    });
  });

  it("should turn a target off when the smart-toggle majority is already active", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender",
          longClickButtons: [
            {
              id: 1,
              actors: [{ name: "actor1", allActuators: true, actuators: [] }],
              otherActors: [],
            },
          ],
        },
        { name: "actor1" },
      ],
    };

    const { setDeviceOnline, sendLshState, sendMisc } =
      createClickHarness(systemConfig);
    setDeviceOnline("sender");
    setDeviceOnline("actor1", { a: [1, 2] });
    sendLshState("actor1", [0b11]);

    startClick(sendMisc, "sender");
    const result = confirmClick(sendMisc, "sender");

    expect(result.logs).toContain("Smart Toggle: 2/2 active. Decision: OFF");
    expect(getOutputMessages(result, Output.Lsh)[0]).toEqual(
      expect.objectContaining({
        topic: "LSH/actor1/IN",
        payload: { p: LshProtocol.SET_STATE, s: [0] },
      })
    );
  });

  it("should send failover when target actors are offline", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender",
          longClickButtons: [
            {
              id: 1,
              actors: [{ name: "offline_act", allActuators: true, actuators: [] }],
              otherActors: [],
            },
          ],
        },
        { name: "offline_act" },
      ],
    };

    const { setDeviceOnline, sendMisc } = createClickHarness(systemConfig);
    setDeviceOnline("sender");

    const result = startClick(sendMisc, "sender");

    expect(
      getSingleOutputMessage<{ p: number }>(result, Output.Lsh).payload.p
    ).toBe(LshProtocol.FAILOVER);
  });

  it("should send failover when no action is configured for a button", () => {
    const systemConfig: SystemConfig = {
      devices: [{ name: "sender", longClickButtons: [] }],
    };

    const { setDeviceOnline, sendMisc } = createClickHarness(systemConfig);
    setDeviceOnline("sender");

    const result = startClick(sendMisc, "sender", ClickType.Long, 99);

    expect(
      getSingleOutputMessage<{ p: number }>(result, Output.Lsh).payload.p
    ).toBe(LshProtocol.FAILOVER);
  });

  it("should send failover when an action has no targets", () => {
    const systemConfig: SystemConfig = {
      devices: [
        {
          name: "sender",
          longClickButtons: [{ id: 1, actors: [], otherActors: [] }],
        },
      ],
    };

    const { setDeviceOnline, sendMisc } = createClickHarness(systemConfig);
    setDeviceOnline("sender");

    const result = startClick(sendMisc, "sender");

    expect(
      getSingleOutputMessage<{ p: number }>(result, Output.Lsh).payload.p
    ).toBe(LshProtocol.FAILOVER);
  });

  it("should surface unexpected errors while starting a click transaction", () => {
    jest
      .spyOn(ClickTransactionManager.prototype, "startTransaction")
      .mockImplementation(() => {
        throw new Error("storage unavailable");
      });

    const { setDeviceOnline, sendMisc } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const result = startClick(sendMisc, "device-sender");

    expect(result.errors).toContain(
      "Unexpected error during click processing for device-sender.1.1: Error: storage unavailable"
    );
    expect(result.messages).toEqual({});
  });

  it("should clean up expired pending click transactions", () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const { setDeviceOnline, sendMisc, service, config } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendMisc, "device-sender");

    nowSpy.mockReturnValue(1_000 + config.clickTimeout * 1000 + 1);

    expect(service.cleanupPendingClicks()).toBe(
      "Cleaned up 1 expired click transactions."
    );
  });
});
