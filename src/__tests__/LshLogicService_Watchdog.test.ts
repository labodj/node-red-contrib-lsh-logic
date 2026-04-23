import { LshProtocol, Output } from "../types";
import {
  createAjvError,
  createLoadedServiceHarness,
  createSystemConfig,
  getAlertPayload,
  getOutputMessages,
} from "./helpers/serviceTestUtils";

describe("LshLogicService - Watchdog & Health", () => {
  const START_TIME = 1_000_000;

  const mockNow = () => jest.spyOn(Date, "now");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should request the missing snapshot data and emit a recovery alert on Homie ready", () => {
    const { sendHomieState } = createLoadedServiceHarness();

    const result = sendHomieState("actor1", "ready");
    const messages = getOutputMessages(result, Output.Lsh);
    const payloads = messages.map((message) => message.payload as { p: number });

    expect(result.stateChanged).toBe(true);
    expect(payloads).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
    expect(getAlertPayload(result).message).toContain("back online");
    expect(getAlertPayload(result).event_type).toBe("device_lifecycle_online");
    expect(getAlertPayload(result).event_source).toBe("homie_lifecycle");
  });

  it("should bridge-probe retained-ready baseline devices instead of leaving them stuck offline", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    nowSpy.mockReturnValue(START_TIME + 1);
    const result = service.runWatchdogCheck();

    expect(getOutputMessages(result, Output.Lsh)).toEqual([
      expect.objectContaining({
        topic: config.serviceTopic,
        payload: { p: LshProtocol.PING },
      }),
    ]);
    expect(result.logs).toContain(
      "Requesting one bridge-level service ping to distinguish bridge health from controller silence.",
    );
  });

  it("should keep probing a never-seen configured device after the first unreachable alert", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });

    nowSpy.mockReturnValue(START_TIME + 1);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toEqual([
      expect.objectContaining({
        topic: config.serviceTopic,
        payload: { p: LshProtocol.PING },
      }),
    ]);
    expect(getAlertPayload(firstResult).event_type).toBe("device_unreachable");
    service.recordDispatchedBridgeProbe(START_TIME + 1);

    nowSpy.mockReturnValue(START_TIME + (config.pingTimeout + 2) * 1000);
    const secondResult = service.runWatchdogCheck();
    expect(getOutputMessages(secondResult, Output.Lsh)).toEqual([
      expect.objectContaining({
        topic: config.serviceTopic,
        payload: { p: LshProtocol.PING },
      }),
    ]);
    expect(secondResult.messages[Output.Alerts]).toBeUndefined();
  });

  it("should rate-limit repeated bridge probes for retained-ready baseline devices", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    nowSpy.mockReturnValue(START_TIME + 1);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(1);

    nowSpy.mockReturnValue(START_TIME + 2);
    const secondResult = service.runWatchdogCheck();
    expect(secondResult.messages[Output.Lsh]).toBeUndefined();
    expect(secondResult.logs).not.toContain(
      "Requesting one bridge-level service ping to distinguish bridge health from controller silence.",
    );
  });

  it("should allow an immediate bridge probe retry when a queued probe is invalidated before dispatch", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    nowSpy.mockReturnValue(START_TIME + 1);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(1);

    service.cancelQueuedBridgeProbe();

    nowSpy.mockReturnValue(START_TIME + 2);
    const secondResult = service.runWatchdogCheck();
    expect(getOutputMessages(secondResult, Output.Lsh)).toHaveLength(1);
  });

  it("should request missing snapshot data when a bridge ping confirms the controller path", () => {
    const { service, sendBridge } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    const result = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    const payloads = getOutputMessages(result, Output.Lsh).map(
      (message) => message.payload as { p: number },
    );

    expect(payloads).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
    expect(result.logs).toContain(
      "Bridge 'dev1' confirmed the controller path is up. Requesting the missing authoritative snapshot data.",
    );
  });

  it("should rate-limit repeated snapshot recovery requests from repeated bridge replies", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, sendBridge } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    nowSpy.mockReturnValue(START_TIME + 1);
    const firstResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(2);

    nowSpy.mockReturnValue(START_TIME + 2);
    const secondResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(secondResult.messages[Output.Lsh]).toBeUndefined();
  });

  it("should allow immediate snapshot recovery requeue when a queued repair is invalidated before dispatch", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, sendBridge } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    const firstResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(getOutputMessages(firstResult, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);

    service.cancelQueuedSnapshotRecovery("dev1");

    const secondResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(getOutputMessages(secondResult, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should allow immediate snapshot recovery requeue when only the first frame of a burst was dispatched", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, sendBridge } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    const firstResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(getOutputMessages(firstResult, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);

    service.recordDispatchedSnapshotRecovery("dev1", START_TIME + 1);
    service.cancelQueuedSnapshotRecovery("dev1");

    nowSpy.mockReturnValue(START_TIME + 2);
    const secondResult = sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(getOutputMessages(secondResult, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should avoid controller pings after a bridge reports controller_connected=false", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, sendBridge } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    service.processMessage("homie/dev1/$state", "ready", { retained: true });

    nowSpy.mockReturnValue(START_TIME + 1);
    service.runWatchdogCheck();
    sendBridge("dev1", {
      event: "service_ping_reply",
      controller_connected: false,
      runtime_synchronized: false,
      bootstrap_phase: "waiting_details",
    });

    nowSpy.mockReturnValue(START_TIME + 2);
    const result = service.runWatchdogCheck();
    expect(result.messages[Output.Lsh]).toBeUndefined();
    expect(result.logs).not.toContain(
      "Requesting one bridge-level service ping to distinguish bridge health from controller silence.",
    );
  });

  it("should request only state on Homie ready when details are already known", () => {
    const { sendDeviceDetails, sendHomieState } = createLoadedServiceHarness();
    sendDeviceDetails("actor1", { a: [1, 2] }, { retained: true });

    const result = sendHomieState("actor1", "ready");
    const messages = getOutputMessages(result, Output.Lsh);
    const payloads = messages.map((message) => message.payload as { p: number });

    expect(payloads).toEqual([{ p: LshProtocol.REQUEST_STATE }]);
    expect(result.logs).toContain(
      "Bridge 'actor1' is online. Requesting the missing authoritative snapshot data.",
    );
  });

  it("should emit an unhealthy alert on Homie lost across live and retained-bootstrap paths", () => {
    const cases = [
      {
        setup: ({ sendHomieState }: ReturnType<typeof createLoadedServiceHarness>) => {
          sendHomieState("actor1", "ready");
        },
      },
      {
        setup: ({ sendHomieState }: ReturnType<typeof createLoadedServiceHarness>) => {
          const retainedReadyResult = sendHomieState("actor1", "ready", { retained: true });
          expect(retainedReadyResult.stateChanged).toBe(false);
          expect(retainedReadyResult.messages[Output.Alerts]).toBeUndefined();
        },
        expectedLog:
          "Bridge 'actor1' reported a live Homie transition from retained 'ready' to live 'lost'. Treating it as an offline event.",
      },
    ];

    for (const { setup, expectedLog } of cases) {
      const harness = createLoadedServiceHarness();
      setup(harness);

      const result = harness.sendHomieState("actor1", "lost");

      if (expectedLog) {
        expect(result.logs).toContain(expectedLog);
        expect(getAlertPayload(result).status).toBe("unhealthy");
      } else {
        expect(getAlertPayload(result).message).toContain("Alert");
      }
      expect(getAlertPayload(result).event_type).toBe("device_lifecycle_offline");
      expect(getAlertPayload(result).event_source).toBe("homie_lifecycle");
    }
  });

  it("should prepare controller-level pings for every configured device when all are silent", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");
    setDeviceOnline("device-silent");

    nowSpy.mockReturnValue(START_TIME + 4000);
    const result = service.runWatchdogCheck();
    const messages = getOutputMessages(result, Output.Lsh);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.topic)).toEqual([
      "LSH/device-sender/IN",
      "LSH/actor1/IN",
      "LSH/device-silent/IN",
    ]);
    expect(messages.map((message) => (message.payload as { p: number }).p)).toEqual([
      LshProtocol.PING,
      LshProtocol.PING,
      LshProtocol.PING,
    ]);
    expect(result.staggerLshMessages).toBe(true);
  });

  it("should not mark a device stale before its queued watchdog ping is actually dispatched", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, setDeviceOnline } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + 4000);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(1);

    nowSpy.mockReturnValue(START_TIME + 9000);
    const secondResult = service.runWatchdogCheck();
    expect(secondResult.messages[Output.Lsh]).toBeUndefined();
    expect(secondResult.messages[Output.Alerts]).toBeUndefined();
  });

  it("should mark a device stale only after the dispatched watchdog ping times out", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, setDeviceOnline } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + 4000);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(1);
    service.recordDispatchedControllerPing("dev1", START_TIME + 4000);

    nowSpy.mockReturnValue(START_TIME + 9001);
    const secondResult = service.runWatchdogCheck();
    expect(getAlertPayload(secondResult).message).toContain("No response to ping");
  });

  it("should not keep requeueing the same stale-device retry while it is still queued", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { service, setDeviceOnline, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + 4000);
    const firstResult = service.runWatchdogCheck();
    expect(getOutputMessages(firstResult, Output.Lsh)).toHaveLength(1);
    service.recordDispatchedControllerPing("dev1", START_TIME + 4000);

    nowSpy.mockReturnValue(START_TIME + 9001);
    const timeoutResult = service.runWatchdogCheck();
    expect(getOutputMessages(timeoutResult, Output.Lsh).map((message) => message.topic)).toEqual([
      config.serviceTopic,
      "LSH/dev1/IN",
    ]);
    expect(getAlertPayload(timeoutResult).message).toContain("No response to ping");

    nowSpy.mockReturnValue(START_TIME + 9500);
    const queuedRetryResult = service.runWatchdogCheck();
    expect(queuedRetryResult.messages[Output.Lsh]).toBeUndefined();
    expect(queuedRetryResult.messages[Output.Alerts]).toBeUndefined();

    nowSpy.mockReturnValue(START_TIME + 10_000);
    const nextQueuedRetryResult = service.runWatchdogCheck();
    expect(nextQueuedRetryResult.messages[Output.Lsh]).toBeUndefined();
    expect(nextQueuedRetryResult.messages[Output.Alerts]).toBeUndefined();
  });

  it("should do nothing when watchdog runs with no configured devices", () => {
    const { service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig(),
    });

    expect(service.runWatchdogCheck()).toEqual({
      messages: {},
      logs: [],
      warnings: [],
      errors: [],
      registryChanged: false,
      stateChanged: false,
    });
  });

  it("should prepare staggered pings when only some devices are silent", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendEvents, service } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");
    setDeviceOnline("device-silent");

    nowSpy.mockReturnValue(START_TIME + 3500);
    sendEvents("actor1", { p: LshProtocol.PING });

    nowSpy.mockReturnValue(START_TIME + 4001);
    const result = service.runWatchdogCheck();
    const messages = getOutputMessages(result, Output.Lsh);

    expect(messages).toHaveLength(2);
    expect(result.staggerLshMessages).toBe(true);
    expect(messages.map((message) => message.topic)).toEqual([
      "LSH/device-sender/IN",
      "LSH/device-silent/IN",
    ]);
  });

  it("should prepare a single targeted ping without staggering when only one device is silent", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendEvents, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1", "dev2"),
    });
    setDeviceOnline("dev1");
    setDeviceOnline("dev2");

    nowSpy.mockReturnValue(START_TIME + 3500);
    sendEvents("dev1", { p: LshProtocol.PING });

    nowSpy.mockReturnValue(START_TIME + 4001);
    const result = service.runWatchdogCheck();

    expect(result.staggerLshMessages).toBeUndefined();
    expect(getOutputMessages(result, Output.Lsh)).toEqual([
      expect.objectContaining({ topic: "LSH/dev2/IN" }),
    ]);
  });

  it("should emit an alert when a device becomes stale after a timed-out ping", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + (config.interrogateThreshold + 1) * 1000);
    service.runWatchdogCheck();
    service.recordDispatchedControllerPing(
      "dev1",
      START_TIME + (config.interrogateThreshold + 1) * 1000,
    );

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
    );
    const result = service.runWatchdogCheck();
    const messages = getOutputMessages(result, Output.Lsh);

    expect(getAlertPayload(result).message).toContain("No response to ping");
    expect(getAlertPayload(result).event_type).toBe("device_unreachable");
    expect(getAlertPayload(result).event_source).toBe("watchdog");
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.topic)).toEqual([config.serviceTopic, "LSH/dev1/IN"]);
    expect(messages.map((message) => (message.payload as { p: number }).p)).toEqual([
      LshProtocol.PING,
      LshProtocol.PING,
    ]);
    expect(result.staggerLshMessages).toBe(true);
  });

  it("should not treat non-liveness traffic as live watchdog activity", () => {
    const cases = [
      ({ service }: ReturnType<typeof createLoadedServiceHarness>) => {
        service.processMessage("homie/dev1/$nodes", "relay", { retained: true });
      },
      ({ sendBridge }: ReturnType<typeof createLoadedServiceHarness>) => {
        sendBridge("dev1", {
          event: "diagnostic",
          kind: "mqtt_queue_overflow",
          dropped_device_commands: 1,
        });
      },
      ({ service, validators }: ReturnType<typeof createLoadedServiceHarness>) => {
        validators.validateAnyEventsTopic.mockReturnValue(false);
        validators.validateAnyEventsTopic.errors = [createAjvError("must match schema")];
        service.processMessage("LSH/dev1/events", { p: 999 });
      },
    ];

    for (const touch of cases) {
      const nowSpy = mockNow();
      nowSpy.mockReturnValue(START_TIME);

      const harness = createLoadedServiceHarness({
        systemConfig: createSystemConfig("dev1"),
      });
      harness.setDeviceOnline("dev1");

      nowSpy.mockReturnValue(START_TIME + (harness.config.interrogateThreshold + 1) * 1000);
      harness.service.runWatchdogCheck();
      harness.service.recordDispatchedControllerPing(
        "dev1",
        START_TIME + (harness.config.interrogateThreshold + 1) * 1000,
      );

      touch(harness);

      nowSpy.mockReturnValue(
        START_TIME + (harness.config.interrogateThreshold + harness.config.pingTimeout + 2) * 1000,
      );
      const result = harness.service.runWatchdogCheck();

      expect(getAlertPayload(result).message).toContain("No response to ping");
      expect(getOutputMessages(result, Output.Lsh).map((message) => message.topic)).toEqual([
        harness.config.serviceTopic,
        "LSH/dev1/IN",
      ]);

      nowSpy.mockRestore();
    }
  });

  it("should warn about unhandled but valid live events without silently swallowing them", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service, config, validators } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + (config.interrogateThreshold + 1) * 1000);
    service.runWatchdogCheck();
    service.recordDispatchedControllerPing(
      "dev1",
      START_TIME + (config.interrogateThreshold + 1) * 1000,
    );

    validators.validateAnyEventsTopic.mockReturnValue(true);
    const eventResult = service.processMessage("LSH/dev1/events", { p: 999 });

    expect(eventResult.warnings).toContain(
      "Unhandled 'events' payload from dev1: protocol id '999'.",
    );

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
    );
    const result = service.runWatchdogCheck();

    expect(getAlertPayload(result).message).toContain("No response to ping");
    expect(getOutputMessages(result, Output.Lsh).map((message) => message.topic)).toEqual([
      config.serviceTopic,
      "LSH/dev1/IN",
    ]);
  });

  it("should not emit the stale alert again while the device remains stale", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");

    nowSpy.mockReturnValue(START_TIME + (config.interrogateThreshold + 1) * 1000);
    service.runWatchdogCheck();
    service.recordDispatchedControllerPing(
      "dev1",
      START_TIME + (config.interrogateThreshold + 1) * 1000,
    );

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
    );
    const firstStaleResult = service.runWatchdogCheck();

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + 2 * config.pingTimeout + 4) * 1000,
    );
    const secondStaleResult = service.runWatchdogCheck();

    expect(getAlertPayload(firstStaleResult).message).toContain("No response to ping");
    expect(secondStaleResult.messages[Output.Alerts]).toBeUndefined();
    expect(secondStaleResult.messages[Output.Lsh]).toBeUndefined();
  });

  it("should emit only one bridge probe even when multiple devices become stale together", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service, config } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1", "dev2"),
    });
    setDeviceOnline("dev1");
    setDeviceOnline("dev2");

    nowSpy.mockReturnValue(START_TIME + (config.interrogateThreshold + 1) * 1000);
    service.runWatchdogCheck();
    service.recordDispatchedControllerPing(
      "dev1",
      START_TIME + (config.interrogateThreshold + 1) * 1000,
    );
    service.recordDispatchedControllerPing(
      "dev2",
      START_TIME + (config.interrogateThreshold + 1) * 1000,
    );

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
    );
    const result = service.runWatchdogCheck();
    const messages = getOutputMessages(result, Output.Lsh);

    expect(messages).toHaveLength(3);
    expect(messages.map((message) => message.topic)).toEqual([
      config.serviceTopic,
      "LSH/dev1/IN",
      "LSH/dev2/IN",
    ]);
    expect(result.staggerLshMessages).toBe(true);
  });

  it("should not re-mark a recently disconnected device as healthy during watchdog checks", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendHomieState, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    setDeviceOnline("dev1");
    sendHomieState("dev1", "lost");

    nowSpy.mockReturnValue(START_TIME + 1000);
    const result = service.runWatchdogCheck();

    expect(getOutputMessages(result, Output.Lsh)).toEqual([
      expect.objectContaining({
        topic: "LSH/Node-RED/SRV",
        payload: { p: LshProtocol.PING },
      }),
    ]);
    expect(service.getDeviceRegistry().dev1.connected).toBe(false);
    expect(service.getDeviceRegistry().dev1.isHealthy).toBe(false);
  });

  it("should stop alerting repeatedly once a missing device has already been alerted", () => {
    const { service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });

    const firstResult = service.runWatchdogCheck();
    const secondResult = service.runWatchdogCheck();

    expect(getAlertPayload(firstResult).message).toContain("Never seen");
    expect(getAlertPayload(firstResult).event_type).toBe("device_unreachable");
    expect(getAlertPayload(firstResult).event_source).toBe("watchdog");
    expect(secondResult.messages).toEqual({});
  });

  it("should log redundant ping responses without emitting a recovery alert", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendEvents } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");

    nowSpy.mockReturnValue(START_TIME + 1000);
    const result = sendEvents("device-sender", { p: LshProtocol.PING });

    expect(result.logs).toContain("Received ping response from 'device-sender'.");
    expect(result.messages[Output.Alerts]).toBeUndefined();
    expect(result.messages[Output.Lsh]).toBeUndefined();
  });

  it("should emit a recovery alert when an unseen device answers a ping", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { sendEvents, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });

    const result = sendEvents("dev1", { p: LshProtocol.PING });

    expect(result.stateChanged).toBe(true);
    expect(result.logs).toContain("Device 'dev1' is now responsive.");
    expect(result.logs).toContain("Device 'dev1' is healthy again after ping response.");
    expect(result.logs).toContain(
      "Device 'dev1' is missing device details. Requesting details and state.",
    );
    expect(getAlertPayload(result).status).toBe("healthy");
    expect(getAlertPayload(result).event_type).toBe("device_recovered");
    expect(getAlertPayload(result).event_source).toBe("watchdog");
    expect(service.getDeviceRegistry().dev1.connected).toBe(true);
    expect(service.getDeviceRegistry().dev1.isHealthy).toBe(true);
    expect(getOutputMessages(result, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should request only state when a ping response arrives after details but before state", () => {
    const { sendDeviceDetails, sendEvents, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    sendDeviceDetails("dev1", { a: [1, 2] });

    const result = sendEvents("dev1", { p: LshProtocol.PING });

    expect(service.getDeviceRegistry().dev1.connected).toBe(true);
    expect(result.logs).toContain(
      "Device 'dev1' is missing an authoritative actuator state. Requesting state.",
    );
    expect(getOutputMessages(result, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should reject a boot payload on the events topic", () => {
    const { config, service, validators } = createLoadedServiceHarness();
    const invalidBootPayload: unknown = {
      p: LshProtocol.BOOT_NOTIFICATION,
    };
    validators.validateAnyEventsTopic.mockReturnValue(false);
    validators.validateAnyEventsTopic.errors = [
      createAjvError("must match exactly one schema in oneOf"),
    ];

    const result = service.processMessage(`${config.lshBasePath}actor1/events`, invalidBootPayload);

    expect(result.warnings[0]).toContain("Invalid 'events' payload from actor1:");
    expect(result.warnings[0]).toContain("must match exactly one schema in oneOf");
    expect(result.stateChanged).toBe(false);
    expect(result.messages).toEqual({});
  });
});
