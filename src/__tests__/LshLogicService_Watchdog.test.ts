import { LshProtocol, Output } from "../types";
import {
  createAjvError,
  createLoadedServiceHarness,
  createSystemConfig,
  getAlertPayload,
  getOutputMessages,
  getSingleOutputMessage,
} from "./helpers/serviceTestUtils";

describe("LshLogicService - Watchdog & Health", () => {
  const START_TIME = 1_000_000;

  const mockNow = () => jest.spyOn(Date, "now");

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should request full state and emit a recovery alert on Homie ready", () => {
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
  });

  it("should emit an unhealthy alert on Homie lost", () => {
    const { sendHomieState } = createLoadedServiceHarness();
    sendHomieState("actor1", "ready");

    const result = sendHomieState("actor1", "lost");

    expect(getAlertPayload(result).message).toContain("Alert");
  });

  it("should prepare a broadcast ping when every configured device is silent", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, service, config } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");
    setDeviceOnline("device-silent");

    nowSpy.mockReturnValue(START_TIME + 4000);
    const result = service.runWatchdogCheck();
    const message = getSingleOutputMessage<{ p: number }>(result, Output.Lsh);

    expect(message.topic).toBe(config.serviceTopic);
    expect(message.payload.p).toBe(LshProtocol.PING);
    expect(result.staggerLshMessages).toBeUndefined();
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
      stateChanged: false,
    });
  });

  it("should prepare staggered pings when only some devices are silent", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendMisc, service } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");
    setDeviceOnline("actor1");
    setDeviceOnline("device-silent");

    nowSpy.mockReturnValue(START_TIME + 3500);
    sendMisc("actor1", { p: LshProtocol.PING });

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

    const { setDeviceOnline, sendMisc, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1", "dev2"),
    });
    setDeviceOnline("dev1");
    setDeviceOnline("dev2");

    nowSpy.mockReturnValue(START_TIME + 3500);
    sendMisc("dev1", { p: LshProtocol.PING });

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

    expect(getAlertPayload(result).message).toContain("No response to ping");
    expect(getSingleOutputMessage<{ p: number }>(result, Output.Lsh).payload.p).toBe(
      LshProtocol.PING,
    );
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
    expect(secondResult.messages).toEqual({});
  });

  it("should log redundant ping responses without emitting a recovery alert", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { setDeviceOnline, sendMisc } = createLoadedServiceHarness();
    setDeviceOnline("device-sender");

    nowSpy.mockReturnValue(START_TIME + 1000);
    const result = sendMisc("device-sender", { p: LshProtocol.PING });

    expect(result.logs).toContain("Received ping response from 'device-sender'.");
    expect(result.messages[Output.Alerts]).toBeUndefined();
    expect(result.messages[Output.Lsh]).toBeUndefined();
  });

  it("should emit a recovery alert when an unseen device answers a ping", () => {
    const nowSpy = mockNow();
    nowSpy.mockReturnValue(START_TIME);

    const { sendMisc, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });

    const result = sendMisc("dev1", { p: LshProtocol.PING });

    expect(result.stateChanged).toBe(true);
    expect(result.logs).toContain("Device 'dev1' is now responsive.");
    expect(result.logs).toContain("Device 'dev1' is healthy again after ping response.");
    expect(result.logs).toContain(
      "Device 'dev1' is missing details and state. Requesting a full authoritative snapshot.",
    );
    expect(getAlertPayload(result).status).toBe("healthy");
    expect(service.getDeviceRegistry().dev1.connected).toBe(true);
    expect(service.getDeviceRegistry().dev1.isHealthy).toBe(true);
    expect(getOutputMessages(result, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_DETAILS },
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should request only state when a ping response arrives after details but before state", () => {
    const { sendDeviceDetails, sendMisc, service } = createLoadedServiceHarness({
      systemConfig: createSystemConfig("dev1"),
    });
    sendDeviceDetails("dev1", { a: [1, 2] });

    const result = sendMisc("dev1", { p: LshProtocol.PING });

    expect(service.getDeviceRegistry().dev1.connected).toBe(true);
    expect(result.logs).toContain(
      "Device 'dev1' is missing an authoritative state snapshot. Requesting state refresh.",
    );
    expect(getOutputMessages(result, Output.Lsh).map((message) => message.payload)).toEqual([
      { p: LshProtocol.REQUEST_STATE },
    ]);
  });

  it("should reject a boot payload on the misc topic", () => {
    const { config, service, validators } = createLoadedServiceHarness();
    const invalidBootPayload: unknown = {
      p: LshProtocol.BOOT_NOTIFICATION,
    };
    validators.validateAnyMiscTopic.mockReturnValue(false);
    validators.validateAnyMiscTopic.errors = [
      createAjvError("must match exactly one schema in oneOf"),
    ];

    const result = service.processMessage(`${config.lshBasePath}actor1/misc`, invalidBootPayload);

    expect(result.warnings[0]).toContain("Invalid 'misc' payload from actor1:");
    expect(result.warnings[0]).toContain("must match exactly one schema in oneOf");
    expect(result.stateChanged).toBe(false);
    expect(result.messages).toEqual({});
  });
});
