import { ClickTransactionManager } from "../ClickTransactionManager";
import { ClickValidationError } from "../LshLogicService";
import type { SystemConfig } from "../types";
import { ClickType, LshProtocol, Output } from "../types";
import type { ServiceHarness } from "./helpers/serviceTestUtils";
import {
  createLoadedServiceHarness,
  createServiceHarness,
  getAlertPayload,
  getAlertPayloads,
  getOtherActorsPayload,
  getOutputMessages,
  getSingleOutputMessage,
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

const createClickHarness = (systemConfig: SystemConfig = defaultClickSystemConfig) =>
  createLoadedServiceHarness({ systemConfig });

const startClick = (
  sendEvents: ServiceHarness["sendEvents"],
  deviceName: string,
  clickType: ClickType = ClickType.Long,
  buttonId = 1,
  correlationId = 1,
) =>
  sendEvents(deviceName, {
    p: LshProtocol.NETWORK_CLICK_REQUEST,
    c: correlationId,
    i: buttonId,
    t: clickType,
  });

const confirmClick = (
  sendEvents: ServiceHarness["sendEvents"],
  deviceName: string,
  clickType: ClickType = ClickType.Long,
  buttonId = 1,
  correlationId = 1,
) =>
  sendEvents(deviceName, {
    p: LshProtocol.NETWORK_CLICK_CONFIRM,
    c: correlationId,
    i: buttonId,
    t: clickType,
  });

describe("LshLogicService - Network Click Logic", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should handle the 3-way click handshake", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const requestResult = startClick(sendEvents, "device-sender");

    expect(
      getSingleOutputMessage<{ c: number; i: number; p: number; t: number }>(
        requestResult,
        Output.Lsh,
      ).payload,
    ).toEqual({
      p: LshProtocol.NETWORK_CLICK_ACK,
      c: 1,
      i: 1,
      t: ClickType.Long,
    });

    const confirmResult = confirmClick(sendEvents, "device-sender");

    expect(confirmResult.logs).toContain(
      "Click confirmed for device-sender.1.1.1. Executing logic.",
    );
    expect(getOutputMessages(confirmResult, Output.Lsh)[0].topic).toBe("LSH/actor1/IN");
  });

  it("should reject confirmations for unknown or expired clicks", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("device-sender");

    const result = confirmClick(sendEvents, "device-sender", ClickType.Long, 99);

    expect(result.warnings).toContain(
      "Received confirmation for an expired or unknown click: device-sender.99.1.1.",
    );
  });

  it("should ignore retained click requests and leave no pending transaction behind", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const retainedRequest = sendEvents(
      "device-sender",
      {
        p: LshProtocol.NETWORK_CLICK_REQUEST,
        c: 77,
        i: 1,
        t: ClickType.Long,
      },
      { retained: true },
    );

    expect(retainedRequest.messages).toEqual({});
    expect(retainedRequest.logs).toContain(
      "Ignoring retained 'events' payload from 'device-sender' because only live runtime traffic can affect reachability, clicks or bridge health.",
    );

    const confirmResult = sendEvents("device-sender", {
      p: LshProtocol.NETWORK_CLICK_CONFIRM,
      c: 77,
      i: 1,
      t: ClickType.Long,
    });

    expect(confirmResult.warnings).toContain(
      "Received confirmation for an expired or unknown click: device-sender.1.1.77.",
    );
  });

  it("should ignore retained click confirmations and keep the live transaction pending", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendEvents, "device-sender", ClickType.Long, 1, 78);

    const retainedConfirm = sendEvents(
      "device-sender",
      {
        p: LshProtocol.NETWORK_CLICK_CONFIRM,
        c: 78,
        i: 1,
        t: ClickType.Long,
      },
      { retained: true },
    );

    expect(retainedConfirm.messages).toEqual({});
    expect(retainedConfirm.logs).toContain(
      "Ignoring retained 'events' payload from 'device-sender' because only live runtime traffic can affect reachability, clicks or bridge health.",
    );

    const liveConfirm = confirmClick(sendEvents, "device-sender", ClickType.Long, 1, 78);

    expect(liveConfirm.logs).toContain(
      "Click confirmed for device-sender.1.1.78. Executing logic.",
    );
    expect(getOutputMessages(liveConfirm, Output.Lsh)[0].topic).toBe("LSH/actor1/IN");
  });

  it("should handle a super-long click by turning the target off", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendEvents, "device-sender", ClickType.SuperLong);
    const result = confirmClick(sendEvents, "device-sender", ClickType.SuperLong);

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

    const { setDeviceOnline, sendLshState, sendEvents } = createClickHarness(systemConfig);
    setDeviceOnline("sender");
    setDeviceOnline("actor1", { a: [1, 2, 3, 4] });
    sendLshState("actor1", [0]);

    startClick(sendEvents, "sender");
    const result = confirmClick(sendEvents, "sender");

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
              actors: [{ name: "actor1", allActuators: false, actuators: [2] }],
              otherActors: [],
            },
          ],
        },
        { name: "actor1" },
      ],
    };

    const { setDeviceOnline, sendEvents } = createClickHarness(systemConfig);
    setDeviceOnline("actor1", { a: [1, 2] });
    setDeviceOnline("device-sender-specific");

    startClick(sendEvents, "device-sender-specific");
    const result = confirmClick(sendEvents, "device-sender-specific");

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
    const { loadConfig, sendDeviceDetails, sendLshState, service } = createServiceHarness();
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
          longClickButtons: [{ id: 1, actors: [], otherActors: ["zigbee-bulb"] }],
        },
      ],
    };

    const { setDeviceOnline, sendEvents, contextReader } = createClickHarness(systemConfig);
    setDeviceOnline("sender-other");
    contextReader.get.mockReturnValue(false);

    startClick(sendEvents, "sender-other");
    const result = confirmClick(sendEvents, "sender-other");

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
          longClickButtons: [{ id: 1, actors: [], otherActors: ["zigbee-bulb"] }],
        },
      ],
    };

    const { setDeviceOnline, sendEvents, contextReader } = createClickHarness(systemConfig);
    setDeviceOnline("sender-other");
    contextReader.get.mockReturnValue("unknown");

    startClick(sendEvents, "sender-other");
    const result = confirmClick(sendEvents, "sender-other");

    expect(result.warnings).toContain(
      "State for otherActor 'zigbee-bulb' not found or not a boolean.",
    );
    expect(result.logs).toContain(
      "Skipping click execution because no authoritative actor state is available.",
    );
    expect(result.messages[Output.OtherActors]).toBeUndefined();
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

    const { setDeviceOnline, sendLshState, sendEvents } = createClickHarness(systemConfig);
    setDeviceOnline("sender");
    setDeviceOnline("actor1", { a: [1, 2] });
    sendLshState("actor1", [0b11]);

    startClick(sendEvents, "sender");
    const result = confirmClick(sendEvents, "sender");

    expect(result.logs).toContain("Smart Toggle: 2/2 active. Decision: OFF");
    expect(getOutputMessages(result, Output.Lsh)[0]).toEqual(
      expect.objectContaining({
        topic: "LSH/actor1/IN",
        payload: { p: LshProtocol.SET_STATE, s: [0] },
      }),
    );
  });

  it("should emit action-validation failover for unreachable or invalid click targets", () => {
    const cases: Array<{
      expectedButtonId?: number;
      expectedMessage?: string;
      run: () => ReturnType<ServiceHarness["sendEvents"]>;
    }> = [
      {
        expectedMessage: "Target actor 'offline_act' bridge is offline.",
        run: () => {
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
          const { setDeviceOnline, sendEvents, sendHomieState } = createClickHarness(systemConfig);
          setDeviceOnline("sender");
          sendHomieState("offline_act", "lost");
          return startClick(sendEvents, "sender");
        },
      },
      {
        expectedMessage: "Target actor 'actor1' has no authoritative actuator state yet.",
        run: () => {
          const { setDeviceOnline, sendDeviceDetails, sendEvents } = createClickHarness();
          setDeviceOnline("device-sender");
          sendDeviceDetails("actor1", { a: [1] });
          return startClick(sendEvents, "device-sender");
        },
      },
      {
        expectedMessage: "Target actor 'actor1' is stale after a timed-out ping.",
        run: () => {
          const nowSpy = jest.spyOn(Date, "now");
          const START_TIME = 1_000_000;
          nowSpy.mockReturnValue(START_TIME);

          const { setDeviceOnline, sendEvents, service, config } = createClickHarness();
          setDeviceOnline("device-sender");
          setDeviceOnline("actor1");

          nowSpy.mockReturnValue(START_TIME + (config.interrogateThreshold + 1) * 1000);
          service.runWatchdogCheck();
          service.recordDispatchedControllerPing(
            "actor1",
            START_TIME + (config.interrogateThreshold + 1) * 1000,
          );

          nowSpy.mockReturnValue(
            START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
          );
          service.runWatchdogCheck();

          const result = startClick(sendEvents, "device-sender");
          nowSpy.mockRestore();
          return result;
        },
      },
      {
        expectedMessage: "Target actor 'actor1' is unhealthy.",
        run: () => {
          const { setDeviceOnline, sendEvents, service } = createClickHarness();
          setDeviceOnline("device-sender");
          setDeviceOnline("actor1");

          const actorState = (
            service as unknown as {
              deviceManager: {
                getDevice(
                  name: string,
                ): { connected: boolean; isHealthy: boolean; isStale: boolean } | undefined;
              };
            }
          ).deviceManager.getDevice("actor1");
          if (!actorState) {
            throw new Error("Expected actor1 to exist in the registry.");
          }
          actorState.connected = true;
          actorState.isStale = false;
          actorState.isHealthy = false;

          return startClick(sendEvents, "device-sender");
        },
      },
      {
        expectedButtonId: 99,
        run: () => {
          const systemConfig: SystemConfig = {
            devices: [{ name: "sender", longClickButtons: [] }],
          };
          const { setDeviceOnline, sendEvents } = createClickHarness(systemConfig);
          setDeviceOnline("sender");
          return startClick(sendEvents, "sender", ClickType.Long, 99);
        },
      },
      {
        expectedMessage: "Target actor 'actor1' controller is offline or not responding.",
        run: () => {
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
          const { setDeviceOnline, sendEvents, sendHomieState } = createClickHarness(systemConfig);
          setDeviceOnline("sender");
          sendHomieState("actor1", "ready");
          return startClick(sendEvents, "sender");
        },
      },
      {
        expectedMessage: "Target actor 'actor1' has no actuators.",
        run: () => {
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
          const { setDeviceOnline, sendEvents } = createClickHarness(systemConfig);
          setDeviceOnline("sender");
          setDeviceOnline("actor1", { a: [] });
          return startClick(sendEvents, "sender");
        },
      },
      {
        run: () => {
          const systemConfig: SystemConfig = {
            devices: [
              {
                name: "sender",
                longClickButtons: [
                  {
                    id: 1,
                    actors: [{ name: "actor1", allActuators: false, actuators: [99] }],
                    otherActors: [],
                  },
                ],
              },
              { name: "actor1" },
            ],
          };
          const { setDeviceOnline, sendEvents } = createClickHarness(systemConfig);
          setDeviceOnline("sender");
          setDeviceOnline("actor1", { a: [1, 2, 3] });
          return startClick(sendEvents, "sender");
        },
      },
    ];

    for (const { expectedButtonId = 1, expectedMessage, run } of cases) {
      const result = run();

      expect(getSingleOutputMessage(result, Output.Lsh).payload).toEqual({
        p: LshProtocol.FAILOVER_CLICK,
        c: 1,
        i: expectedButtonId,
        t: ClickType.Long,
      });
      if (expectedMessage) {
        expect(
          getAlertPayloads(result).some(
            (alert) =>
              alert.event_type === "action_failed" &&
              alert.event_source === "action_validation" &&
              alert.message.includes(expectedMessage),
          ),
        ).toBe(true);
      } else {
        expect(result.messages[Output.Alerts]).toBeDefined();
      }
      expect(
        getAlertPayloads(result).some(
          (alert) =>
            alert.event_type === "action_failed" && alert.event_source === "action_validation",
        ),
      ).toBe(true);
    }
  });

  it("should accept a target recovered via ping even without a retained Homie ready state", () => {
    const { setDeviceOnline, sendDeviceDetails, sendLshState, sendEvents, service } =
      createClickHarness();
    setDeviceOnline("device-sender");
    sendDeviceDetails("actor1", { a: [1] });
    sendLshState("actor1", [0]);

    const recoveryResult = sendEvents("actor1", { p: LshProtocol.PING });
    const clickResult = startClick(sendEvents, "device-sender");

    expect(service.getDeviceRegistry().actor1.connected).toBe(true);
    expect(recoveryResult.logs).toContain("Received ping response from 'actor1'.");
    expect(
      getSingleOutputMessage<{ c: number; i: number; p: number; t: number }>(
        clickResult,
        Output.Lsh,
      ).payload,
    ).toEqual({
      p: LshProtocol.NETWORK_CLICK_ACK,
      c: 1,
      i: 1,
      t: ClickType.Long,
    });
  });

  it("should request fresh state immediately after a bridge desync report and recover clicks after the next live state", () => {
    const { setDeviceOnline, sendBridge, sendEvents, sendLshState } = createClickHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");

    const desyncResult = sendBridge("actor1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: false,
      bootstrap_phase: "waiting_for_state",
    });

    expect(getOutputMessages(desyncResult, Output.Lsh)).toEqual([
      expect.objectContaining({
        topic: "LSH/actor1/IN",
        payload: { p: LshProtocol.REQUEST_STATE },
      }),
    ]);
    expect(desyncResult.logs).toContain(
      "Bridge 'actor1' reported an unsynchronized runtime cache. Requesting a fresh authoritative state immediately.",
    );

    const blockedClick = startClick(sendEvents, "device-sender");
    expect(getAlertPayload(blockedClick).message).toContain(
      "Target actor 'actor1' has no authoritative actuator state yet.",
    );

    sendLshState("actor1", [0]);

    const recoveredClick = startClick(sendEvents, "device-sender");
    expect(
      getSingleOutputMessage<{ c: number; i: number; p: number; t: number }>(
        recoveredClick,
        Output.Lsh,
      ).payload,
    ).toEqual({
      p: LshProtocol.NETWORK_CLICK_ACK,
      c: 1,
      i: 1,
      t: ClickType.Long,
    });
  });

  it("should ignore retained Homie offline markers when validating target actors", () => {
    const { setDeviceOnline, sendEvents, service } = createClickHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");

    service.processMessage("homie/actor1/$state", "lost", { retained: true });

    const result = startClick(sendEvents, "device-sender");

    expect(
      getSingleOutputMessage<{ c: number; i: number; p: number; t: number }>(result, Output.Lsh)
        .payload,
    ).toEqual({
      p: LshProtocol.NETWORK_CLICK_ACK,
      c: 1,
      i: 1,
      t: ClickType.Long,
    });
  });

  it("should treat live network click traffic as proof the sender is reachable", () => {
    const { setDeviceOnline, sendHomieState, sendEvents, service } = createClickHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");
    sendHomieState("device-sender", "lost");

    const result = startClick(sendEvents, "device-sender");

    expect(service.getDeviceRegistry()["device-sender"].connected).toBe(true);
    expect(result.logs).toContain(
      "Device 'device-sender' sent live events traffic and is reachable.",
    );
    expect(
      getSingleOutputMessage<{ c: number; i: number; p: number; t: number }>(result, Output.Lsh)
        .payload,
    ).toEqual({
      p: LshProtocol.NETWORK_CLICK_ACK,
      c: 1,
      i: 1,
      t: ClickType.Long,
    });
  });

  it("should skip super-long click targets that become invalid before confirmation executes", () => {
    const cases: Array<{
      expectedWarning: string;
      setup: (harness: ReturnType<typeof createClickHarness>) => void;
    }> = [
      {
        expectedWarning:
          "Skipping actor 'actor1' because its actuator state is not authoritative yet.",
        setup: ({ sendDeviceDetails }) => {
          sendDeviceDetails("actor1", { a: [3, 4] });
        },
      },
      {
        expectedWarning: "Skipping actor 'actor1' because it disappeared before command execution.",
        setup: ({ service }) => {
          (
            service as unknown as {
              deviceManager: { pruneDevice(deviceName: string): void };
            }
          ).deviceManager.pruneDevice("actor1");
        },
      },
    ];

    for (const { expectedWarning, setup } of cases) {
      const systemConfig: SystemConfig = {
        devices: [
          {
            name: "sender",
            superLongClickButtons: [
              {
                id: 1,
                actors: [{ name: "actor1", allActuators: false, actuators: [1, 2] }],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      };

      const harness = createClickHarness(systemConfig);
      harness.setDeviceOnline("sender");
      harness.setDeviceOnline("actor1", { a: [1, 2] });
      harness.sendLshState("actor1", [0]);

      startClick(harness.sendEvents, "sender", ClickType.SuperLong);
      setup(harness);

      const result = confirmClick(harness.sendEvents, "sender", ClickType.SuperLong);

      expect(result.messages[Output.Lsh]).toBeUndefined();
      expect(result.warnings).toContain(expectedWarning);
    }
  });

  it("should keep general failover mapped to the protocol general failover command", () => {
    jest.spyOn(ClickTransactionManager.prototype, "startTransaction").mockImplementation(() => {
      throw new ClickValidationError("coordinator unavailable", "general");
    });

    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const result = startClick(sendEvents, "device-sender");

    expect(getSingleOutputMessage(result, Output.Lsh).payload).toEqual({
      p: LshProtocol.FAILOVER,
    });
  });

  it("should surface unexpected errors while starting a click transaction", () => {
    jest.spyOn(ClickTransactionManager.prototype, "startTransaction").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    const result = startClick(sendEvents, "device-sender");

    expect(result.errors).toContain(
      "Unexpected error during click processing for device-sender.1.1.1: Error: storage unavailable",
    );
    expect(result.messages).toEqual({});
  });

  it("should clean up expired pending click transactions", () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const { setDeviceOnline, sendEvents, service, config } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendEvents, "device-sender");

    nowSpy.mockReturnValue(1_000 + config.clickTimeout * 1000 + 1);

    expect(service.cleanupPendingClicks()).toBe("Cleaned up 1 expired click transactions.");
  });

  it("should reject a late confirmation even if periodic cleanup has not run yet", () => {
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000);

    const { setDeviceOnline, sendEvents, config } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendEvents, "device-sender");

    nowSpy.mockReturnValue(1_000 + config.clickTimeout * 1000 + 1);

    const result = confirmClick(sendEvents, "device-sender");

    expect(result.warnings).toContain(
      "Received confirmation for an expired or unknown click: device-sender.1.1.1.",
    );
    expect(result.messages).toEqual({});
  });

  it("should ignore stale confirmations when a newer correlation replaced the same click slot", () => {
    const { setDeviceOnline, sendEvents } = createClickHarness();
    setDeviceOnline("actor1");
    setDeviceOnline("device-sender");

    startClick(sendEvents, "device-sender", ClickType.Long, 1, 7);
    startClick(sendEvents, "device-sender", ClickType.Long, 1, 8);

    const staleConfirm = confirmClick(sendEvents, "device-sender", ClickType.Long, 1, 7);
    const freshConfirm = confirmClick(sendEvents, "device-sender", ClickType.Long, 1, 8);

    expect(staleConfirm.warnings).toContain(
      "Received confirmation for an expired or unknown click: device-sender.1.1.7.",
    );
    expect(freshConfirm.logs).toContain(
      "Click confirmed for device-sender.1.1.8. Executing logic.",
    );
  });
});
