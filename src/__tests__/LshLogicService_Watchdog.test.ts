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

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + config.pingTimeout + 2) * 1000,
    );
    const firstStaleResult = service.runWatchdogCheck();

    nowSpy.mockReturnValue(
      START_TIME + (config.interrogateThreshold + 2 * config.pingTimeout + 4) * 1000,
    );
    const secondStaleResult = service.runWatchdogCheck();
    const secondStaleMessages = getOutputMessages(secondStaleResult, Output.Lsh);

    expect(getAlertPayload(firstStaleResult).message).toContain("No response to ping");
    expect(secondStaleResult.messages[Output.Alerts]).toBeUndefined();
    expect(secondStaleMessages).toHaveLength(2);
    expect(secondStaleMessages.map((message) => message.topic)).toEqual([
      config.serviceTopic,
      "LSH/dev1/IN",
    ]);
    expect(secondStaleMessages.map((message) => (message.payload as { p: number }).p)).toEqual([
      LshProtocol.PING,
      LshProtocol.PING,
    ]);
    expect(secondStaleResult.staggerLshMessages).toBe(true);
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

    expect(result.messages).toEqual({});
    expect(result.logs).toEqual([]);
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
