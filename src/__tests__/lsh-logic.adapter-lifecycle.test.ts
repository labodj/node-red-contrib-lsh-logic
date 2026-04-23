import * as utils from "../utils";
import type { NodeMessage } from "node-red";
import { LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "../types";
import { LshLogicService } from "../LshLogicService";
import * as fs from "fs/promises";
import type { LshLogicNode } from "../lsh-logic";
import type { AlertPayload, DeviceState } from "../types";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";
import { defaultNodeConfig, flushMicrotasks } from "./helpers/nodeRedTestUtils";
import type { AdapterHarness, MockWatcher } from "./helpers/lshLogicAdapterTestUtils";
import {
  createAdapterHarness,
  createServiceResult,
  createValidator,
  getCloseHandler,
  warmupNodeConfig,
} from "./helpers/lshLogicAdapterTestUtils";
import { createAjvError } from "./helpers/serviceTestUtils";

jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn(),
}));

describe("LshLogicNode Adapter - Runtime & Lifecycle", () => {
  let adapterHarness: AdapterHarness;
  let mockNodeInstance: MockNodeInstance;
  let nodeInstance: LshLogicNode;
  let mockWatcher: MockWatcher;

  const initializeNode = async (config = defaultNodeConfig): Promise<LshLogicNode> => {
    nodeInstance = await adapterHarness.initializeNode(config);
    return nodeInstance;
  };

  beforeEach(() => {
    jest.useFakeTimers();

    adapterHarness = createAdapterHarness();
    mockNodeInstance = adapterHarness.mockNodeInstance;
    mockWatcher = adapterHarness.mockWatcher;
  });

  afterEach(async () => {
    await adapterHarness.cleanupNode();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("should suppress recovery alerts during the warm-up period regardless of payload shape", async () => {
    await initializeNode(warmupNodeConfig);
    for (const payload of [
      {
        status: "healthy",
        event_type: "device_recovered",
        event_source: "live_telemetry",
        message: "✅ System Health Recovery...",
        devices: [],
      },
      "✅ Device recovered",
    ]) {
      mockNodeInstance.send.mockClear();
      mockNodeInstance.log.mockClear();

      await nodeInstance.processServiceResult(
        createServiceResult({
          messages: {
            [Output.Alerts]: {
              payload,
            },
          },
        }),
      );

      expect(mockNodeInstance.send).not.toHaveBeenCalled();
      expect(mockNodeInstance.log).toHaveBeenCalledWith(
        "Suppressing 'device recovered' alert during warm-up period.",
      );
    }
  });

  it("should forward non-recovery alerts during the warm-up period", async () => {
    await initializeNode(warmupNodeConfig);
    mockNodeInstance.send.mockClear();

    const alertPayload: AlertPayload = {
      status: "unhealthy",
      event_type: "device_lifecycle_offline",
      event_source: "homie_lifecycle",
      message: "‼️ Device offline",
      devices: [{ name: "j1", reason: "Device reported as 'lost' by Homie." }],
    };

    await nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Alerts]: {
            payload: alertPayload,
          },
        },
      }),
    );

    expect(mockNodeInstance.send).toHaveBeenCalledWith([
      null,
      null,
      { payload: alertPayload },
      null,
      null,
    ]);
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Suppressing 'device recovered' alert during warm-up period.",
    );
  });

  it("should send LSH messages in a staggered sequence", async () => {
    await initializeNode();
    mockNodeInstance.send.mockClear();

    jest.spyOn(utils, "sleep").mockResolvedValue(undefined);

    const lshMsg1 = { topic: "LSH/dev1/IN", payload: "p1" };
    const lshMsg2 = { topic: "LSH/dev2/IN", payload: "p2" };
    const otherMsg = { payload: "other" };

    await nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [lshMsg1, lshMsg2],
          [Output.OtherActors]: otherMsg,
        },
        staggerLshMessages: true,
      }),
    );
    await flushMicrotasks(10);

    expect(mockNodeInstance.send).toHaveBeenCalledTimes(3);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(1, [lshMsg1, null, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(2, [null, otherMsg, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(3, [lshMsg2, null, null, null, null]);
  });

  it("should let high-priority outputs overtake future low-priority staggered frames", async () => {
    await initializeNode();
    mockNodeInstance.send.mockClear();

    let releaseFirstSleep: (() => void) | undefined;
    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const firstRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [
            { topic: "LSH/dev1/IN", payload: "p1" },
            { topic: "LSH/dev2/IN", payload: "p2" },
          ],
        },
        staggerLshMessages: true,
      }),
    );

    await flushMicrotasks();

    const secondRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.OtherActors]: { payload: "other" },
        },
      }),
    );

    await flushMicrotasks();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(2);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(1, [
      { topic: "LSH/dev1/IN", payload: "p1" },
      null,
      null,
      null,
      null,
    ]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(2, [
      null,
      { payload: "other" },
      null,
      null,
      null,
    ]);

    releaseFirstSleep?.();
    await Promise.all([firstRun, secondRun]);
    await flushMicrotasks(10);

    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(3, [
      { topic: "LSH/dev2/IN", payload: "p2" },
      null,
      null,
      null,
      null,
    ]);
  });

  it("should update the exposed state in context when state changes", async () => {
    const deviceState: DeviceState = {
      name: "device-1",
      connected: true,
      controllerLinkConnected: true,
      isHealthy: true,
      isStale: false,
      lastSeenTime: 1,
      bridgeConnected: true,
      bridgeLastSeenTime: 1,
      lastHomieState: "ready",
      lastHomieStateTime: 1,
      lastDetailsTime: 1,
      lastStateTime: 1,
      actuatorsIDs: [],
      buttonsIDs: [],
      actuatorStates: [],
      actuatorIndexes: {},
      alertSent: false,
    };

    jest
      .spyOn(LshLogicService.prototype, "getDeviceRegistry")
      .mockReturnValue({ "device-1": deviceState });

    await initializeNode({
      ...defaultNodeConfig,
      exposeStateContext: "flow",
      exposeStateKey: "my_state",
    });

    mockNodeInstance.__context.flow.set.mockClear();
    await nodeInstance.processServiceResult(createServiceResult({ stateChanged: true }));

    expect(mockNodeInstance.__context.flow.set).toHaveBeenCalledWith(
      "my_state",
      expect.objectContaining({
        devices: { "device-1": deviceState },
      }),
    );
  });

  it("should log when the cleanup timer removes expired clicks", async () => {
    jest
      .spyOn(LshLogicService.prototype, "cleanupPendingClicks")
      .mockReturnValue("Cleaned up 2 clicks.");

    await initializeNode();

    jest.advanceTimersByTime(defaultNodeConfig.clickCleanupInterval * 1000);
    await flushMicrotasks();

    expect(mockNodeInstance.log).toHaveBeenCalledWith("Cleaned up 2 clicks.");
  });

  it("should process discovery sync messages after loading system config", async () => {
    const discoveryMessage = {
      topic: "homeassistant/device/lsh_test/config",
      payload: { components: {} },
      qos: 1,
      retain: true,
    };

    jest.spyOn(LshLogicService.prototype, "syncDiscoveryConfig").mockReturnValue(
      createServiceResult({
        messages: {
          [Output.Lsh]: discoveryMessage,
        },
      }),
    );

    await initializeNode();

    expect(mockNodeInstance.send).toHaveBeenCalledWith([discoveryMessage, null, null, null, null]);
  });

  it("should run the watchdog check periodically", async () => {
    jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(createServiceResult());

    await initializeNode();

    const processResultSpy = jest.spyOn(nodeInstance, "processServiceResult");
    jest.advanceTimersByTime(defaultNodeConfig.watchdogInterval * 1000);
    await flushMicrotasks();

    expect(LshLogicService.prototype.runWatchdogCheck).toHaveBeenCalled();
    expect(processResultSpy).toHaveBeenCalled();
  });

  it("should let later watchdog cycles proceed while low-priority staggered traffic is still draining", async () => {
    const runWatchdogCheckSpy = jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(
        createServiceResult({
          messages: {
            [Output.Lsh]: [
              { topic: "LSH/dev1/IN", payload: "p1" },
              { topic: "LSH/dev2/IN", payload: "p2" },
            ],
          },
          staggerLshMessages: true,
        }),
      );

    await initializeNode({
      ...defaultNodeConfig,
      watchdogInterval: 2,
      initialStateTimeout: 0.1,
      pingTimeout: 0.1,
    });

    jest.advanceTimersByTime(1500);
    await flushMicrotasks(6);
    runWatchdogCheckSpy.mockClear();

    let resolveSleep: (() => void) | undefined;
    const firstSleep = new Promise<void>((resolve) => {
      resolveSleep = resolve;
    });

    const sleepSpy = jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(() => firstSleep)
      .mockResolvedValue(undefined);

    jest.advanceTimersByTime(2000);
    await flushMicrotasks();
    expect(runWatchdogCheckSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(4000);
    await flushMicrotasks();
    expect(runWatchdogCheckSpy).toHaveBeenCalledTimes(3);

    resolveSleep?.();
    await flushMicrotasks(6);

    expect(runWatchdogCheckSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalled();
  });

  it("should wait for an in-flight watchdog cycle to quiesce before finishing close", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());
    const runWatchdogCheckSpy = jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(
        createServiceResult({
          messages: {
            [Output.Lsh]: [
              { topic: "LSH/dev1/IN", payload: "p1" },
              { topic: "LSH/dev2/IN", payload: "p2" },
            ],
          },
          staggerLshMessages: true,
        }),
      );

    await initializeNode({
      ...defaultNodeConfig,
      watchdogInterval: 2,
      initialStateTimeout: 0.1,
      pingTimeout: 0.1,
    });

    jest.advanceTimersByTime(1500);
    await flushMicrotasks(6);
    mockNodeInstance.send.mockClear();
    runWatchdogCheckSpy.mockClear();

    let resolveSleep: (() => void) | undefined;
    const firstSleep = new Promise<void>((resolve) => {
      resolveSleep = resolve;
    });

    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(() => firstSleep)
      .mockResolvedValue(undefined);

    jest.advanceTimersByTime(2000);
    await flushMicrotasks();

    expect(runWatchdogCheckSpy).toHaveBeenCalledTimes(1);
    const sendsBeforeClose = mockNodeInstance.send.mock.calls.length;
    expect(sendsBeforeClose).toBeGreaterThanOrEqual(1);
    expect(mockNodeInstance.send).toHaveBeenLastCalledWith([
      { topic: "LSH/dev1/IN", payload: "p1" },
      null,
      null,
      null,
      null,
    ]);

    const done = jest.fn();
    getCloseHandler(mockNodeInstance)(done);
    await flushMicrotasks(10);

    expect(done).not.toHaveBeenCalled();

    resolveSleep?.();
    await flushMicrotasks(10);

    expect(done).toHaveBeenCalled();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(sendsBeforeClose);
  });

  it("should skip watchdog checks while the node is still warming up", async () => {
    jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(createServiceResult());
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(true);
    jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      watchdogInterval: 1,
      initialStateTimeout: 10,
      pingTimeout: 10,
    });
    (LshLogicService.prototype.runWatchdogCheck as jest.Mock).mockClear();

    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(LshLogicService.prototype.runWatchdogCheck).not.toHaveBeenCalled();
  });

  it("should handle config reload successfully", async () => {
    await initializeNode();

    const validateFn = createValidator(true);
    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", validateFn);

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "yellow",
      shape: "dot",
      text: "Reloading config...",
    });
    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Configuration successfully reloaded from /tmp/new-config.json.",
    );
  });

  it("should defer post-reload strong recovery until pending startup verification completes", async () => {
    jest
      .spyOn(LshLogicService.prototype, "needsStartupBootReplay")
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });
    verifySpy.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(2000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(2);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Running post-reload device recovery: reconciling snapshots for the updated runtime configuration.",
    );
  });

  it("should schedule a strong runtime recovery pass after a hot reload once warm-up is over", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 1,
      pingTimeout: 1,
    });

    jest.advanceTimersByTime(1500);
    await flushMicrotasks(6);
    verifySpy.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Running post-reload device recovery: reconciling snapshots for the updated runtime configuration.",
    );
  });

  it("should schedule a strong runtime recovery pass during late warm-up once startup verification already ran", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 1,
      pingTimeout: 1,
    });

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    expect(verifySpy).toHaveBeenCalledTimes(1);
    verifySpy.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Running post-reload device recovery: reconciling snapshots for the updated runtime configuration.",
    );
  });

  it("should drop stale low-priority LSH traffic after a successful config reload", async () => {
    await initializeNode();
    mockNodeInstance.send.mockClear();

    let releaseFirstSleep: (() => void) | undefined;
    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const staleMessage = { topic: "LSH/stale-device/IN", payload: "stale" };

    const drainRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [{ topic: "LSH/live-device/IN", payload: "live" }, staleMessage],
        },
        staggerLshMessages: true,
      }),
    );

    await flushMicrotasks();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(1);

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    await flushMicrotasks(6);

    releaseFirstSleep?.();
    await drainRun;
    await flushMicrotasks(10);

    const sentTopics = mockNodeInstance.send.mock.calls.flatMap((call) => {
      const outputs = call[0] as Array<{ topic?: string } | null>;
      return outputs
        .map((message) => message?.topic ?? null)
        .filter((topic): topic is string => topic !== null);
    });

    expect(sentTopics).not.toContain(staleMessage.topic);
  });

  it("should cancel a queued bridge probe when a stale low-priority batch is invalidated", async () => {
    await initializeNode();

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    service.processMessage("homie/test-device/$state", "ready", { retained: true });

    const watchdogResult = service.runWatchdogCheck();
    const probeMessage = watchdogResult.messages[Output.Lsh] as NodeMessage | undefined;
    expect(probeMessage).toBeDefined();

    let releaseFirstSleep: (() => void) | undefined;
    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    mockNodeInstance.send.mockClear();
    const drainRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [{ topic: "LSH/backlog/IN", payload: "backlog" }, probeMessage!],
        },
        staggerLshMessages: true,
      }),
    );

    await flushMicrotasks();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(1);

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    await flushMicrotasks(6);

    releaseFirstSleep?.();
    await drainRun;
    await flushMicrotasks(10);

    const retryResult = service.runWatchdogCheck();
    expect(retryResult.messages[Output.Lsh]).toEqual(probeMessage);
  });

  it("should cancel queued snapshot recovery cooldown when stale low-priority recovery is invalidated", async () => {
    await initializeNode();

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    service.processMessage("homie/test-device/$state", "ready", { retained: true });

    const recoveryResult = service.processMessage("LSH/test-device/bridge", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    const recoveryMessages = recoveryResult.messages[Output.Lsh] as NodeMessage[] | undefined;
    expect(recoveryMessages).toHaveLength(2);

    let releaseFirstSleep: (() => void) | undefined;
    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    mockNodeInstance.send.mockClear();
    const drainRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [{ topic: "LSH/backlog/IN", payload: "backlog" }, ...recoveryMessages!],
        },
        staggerLshMessages: true,
      }),
    );

    await flushMicrotasks();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(1);

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    await flushMicrotasks(6);

    releaseFirstSleep?.();
    await drainRun;
    await flushMicrotasks(10);

    const retryResult = service.processMessage("LSH/test-device/bridge", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(retryResult.messages[Output.Lsh]).toEqual(recoveryMessages);
  });

  it("should allow snapshot recovery replacement when only the first recovery frame was sent before reload invalidated the second", async () => {
    await initializeNode();

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    service.processMessage("homie/test-device/$state", "ready", { retained: true });

    const requestDetails: NodeMessage = {
      topic: "LSH/test-device/IN",
      payload: { p: LshProtocol.REQUEST_DETAILS },
    };
    const requestState: NodeMessage = {
      topic: "LSH/test-device/IN",
      payload: { p: LshProtocol.REQUEST_STATE },
    };

    let releaseFirstSleep: (() => void) | undefined;
    jest
      .spyOn(utils, "sleep")
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstSleep = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    mockNodeInstance.send.mockClear();
    const drainRun = nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Lsh]: [requestDetails, requestState],
        },
        staggerLshMessages: true,
      }),
    );

    await flushMicrotasks();
    expect(mockNodeInstance.send).toHaveBeenCalledTimes(1);
    expect(mockNodeInstance.send).toHaveBeenLastCalledWith([
      requestDetails,
      null,
      null,
      null,
      null,
    ]);

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    await flushMicrotasks(6);

    releaseFirstSleep?.();
    await drainRun;
    await flushMicrotasks(10);

    const retryResult = service.processMessage("LSH/test-device/bridge", {
      event: "service_ping_reply",
      controller_connected: true,
      runtime_synchronized: true,
      bootstrap_phase: "synced",
    });
    expect(
      (retryResult.messages[Output.Lsh] as NodeMessage[] | undefined)?.map(
        (message) => message.payload,
      ),
    ).toEqual([{ p: LshProtocol.REQUEST_DETAILS }, { p: LshProtocol.REQUEST_STATE }]);
  });

  it("should handle config reload failures", async () => {
    await initializeNode();

    const validateFn = createValidator(false);
    validateFn.errors = [createAjvError("invalid config")];

    await nodeInstance.handleConfigFileChange("/tmp/bad-config.json", validateFn);

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Error reloading /tmp/bad-config.json: Invalid system-config.json: invalid config",
    );
    expect(mockNodeInstance.warn).toHaveBeenCalledWith(
      "Keeping the last valid runtime configuration because a hot-reload failed.",
    );
    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "yellow",
      shape: "ring",
      text: "Reload failed, using last config",
    });
    expect(service.getConfiguredDeviceNames()).toEqual(["test-device"]);
  });

  it("should keep published HA discovery state intact when a config reload fails", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      haDiscovery: true,
    });

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    await nodeInstance.processServiceResult(
      service.processMessage("homie/test-device/$mac", "AA:BB:CC:DD:EE:FF"),
    );
    await nodeInstance.processServiceResult(
      service.processMessage("homie/test-device/$fw/version", "1.0.0"),
    );
    await nodeInstance.processServiceResult(
      service.processMessage("homie/test-device/$nodes", "relay"),
    );

    mockNodeInstance.send.mockClear();

    const validateFn = createValidator(false);
    validateFn.errors = [createAjvError("invalid config")];

    await nodeInstance.handleConfigFileChange("/tmp/bad-config.json", validateFn);

    const cleanupOutputs = mockNodeInstance.send.mock.calls
      .map((call) => call[0])
      .find(
        (outputs): outputs is Array<NodeMessage | NodeMessage[] | null> =>
          Array.isArray(outputs) && Array.isArray(outputs[Output.Lsh]),
      );

    expect(cleanupOutputs).toBeUndefined();
  });

  it("should preserve exposed registry state when a config reload fails", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      exposeStateContext: "flow",
      exposeStateKey: "lsh_state",
    });

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    await nodeInstance.processServiceResult(
      service.processMessage("LSH/test-device/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "test-device",
        a: [1],
        b: [],
      }),
    );
    await nodeInstance.processServiceResult(
      service.processMessage("LSH/test-device/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [0],
      }),
    );
    await nodeInstance.processServiceResult(
      service.processMessage("homie/test-device/$state", "ready"),
    );

    const lastPublishedState = mockNodeInstance.__context.flow.set.mock.calls
      .filter(([key]) => key === "lsh_state")
      .at(-1)?.[1] as
      | {
          devices: Record<string, { lastSeenTime: number }>;
        }
      | undefined;

    expect(lastPublishedState).toEqual(
      expect.objectContaining({
        devices: expect.objectContaining({
          "test-device": expect.objectContaining({
            lastSeenTime: expect.any(Number),
          }),
        }),
      }),
    );

    mockNodeInstance.__context.flow.set.mockClear();

    const validateFn = createValidator(false);
    validateFn.errors = [createAjvError("invalid config")];

    await nodeInstance.handleConfigFileChange("/tmp/bad-config.json", validateFn);

    expect(mockNodeInstance.__context.flow.set).not.toHaveBeenCalled();
  });

  it("should serialize overlapping config reloads and apply them in request order", async () => {
    await initializeNode();

    const readFileMock = jest.mocked(fs.readFile);
    readFileMock.mockClear();

    let resolveFirstRead: ((value: string) => void) | undefined;
    const firstRead = new Promise<string>((resolve) => {
      resolveFirstRead = resolve;
    });

    let resolveSecondRead: ((value: string) => void) | undefined;
    const secondRead = new Promise<string>((resolve) => {
      resolveSecondRead = resolve;
    });

    readFileMock
      .mockImplementationOnce(async () => firstRead)
      .mockImplementationOnce(async () => secondRead);

    const firstReload = nodeInstance.handleConfigFileChange(
      "/tmp/config-a.json",
      createValidator(true),
    );
    const secondReload = nodeInstance.handleConfigFileChange(
      "/tmp/config-b.json",
      createValidator(true),
    );

    await flushMicrotasks();
    expect(readFileMock).toHaveBeenCalledTimes(1);

    resolveFirstRead?.(JSON.stringify({ devices: [{ name: "config-a" }] }));
    await flushMicrotasks(6);
    expect(readFileMock).toHaveBeenCalledTimes(2);

    resolveSecondRead?.(JSON.stringify({ devices: [{ name: "config-b" }] }));
    await Promise.all([firstReload, secondReload]);

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    expect(service.getConfiguredDeviceNames()).toEqual(["config-b"]);
  });

  it("should skip MQTT reconfiguration when a successful reload keeps the same effective topic set", async () => {
    await initializeNode();
    mockNodeInstance.send.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/same-config.json", createValidator(true));

    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "MQTT topic set unchanged after config update. Skipping runtime subscription reconfiguration.",
    );
  });

  it("should treat topic-set comparison as order-insensitive across config reordering", async () => {
    jest
      .mocked(fs.readFile)
      .mockResolvedValueOnce(
        JSON.stringify({
          devices: [{ name: "zeta-device" }, { name: "alpha-device" }],
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          devices: [{ name: "alpha-device" }, { name: "zeta-device" }],
        }),
      );

    await initializeNode();
    mockNodeInstance.send.mockClear();
    mockNodeInstance.log.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/reordered-config.json", createValidator(true));

    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "MQTT topic set unchanged after config update. Skipping runtime subscription reconfiguration.",
    );
  });

  it("should delegate file watcher add/change events to the reload handler after debounce", async () => {
    await initializeNode();

    const reloadSpy = jest
      .spyOn(nodeInstance, "handleConfigFileChange")
      .mockResolvedValue(undefined);

    for (const eventName of ["change", "add"] as const) {
      reloadSpy.mockClear();
      const handler = mockWatcher.on.mock.calls.find(([event]) => event === eventName)?.[1] as
        | ((path: string) => void)
        | undefined;

      expect(handler).toBeDefined();
      handler?.("/tmp/changed-config.json");
      jest.advanceTimersByTime(250);
      await flushMicrotasks();

      expect(reloadSpy).toHaveBeenCalledWith("/tmp/changed-config.json", expect.any(Function));
    }
  });

  it("should validate discovery and topic path settings at initialization", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      haDiscovery: false,
      haDiscoveryPrefix: "   ",
    });

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        haDiscovery: true,
        haDiscoveryPrefix: "   ",
      }),
    ).rejects.toThrow("Discovery Prefix cannot be empty.");

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        lshBasePath: "custom/base",
      }),
    ).rejects.toThrow("LSH Base Path must end with '/'.");

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        homieBasePath: "homie/#/",
      }),
    ).rejects.toThrow("Homie Base Path must not contain MQTT wildcards");

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        lshBasePath: "LSH/+/",
      }),
    ).rejects.toThrow("LSH Base Path must not contain MQTT wildcards");

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        serviceTopic: "LSH/Node-RED/#",
      }),
    ).rejects.toThrow("Service Topic must not contain MQTT wildcards");

    await expect(
      initializeNode({
        ...defaultNodeConfig,
        haDiscovery: true,
        haDiscoveryPrefix: "homeassistant/#",
      }),
    ).rejects.toThrow("Discovery Prefix must not contain MQTT wildcards");
  });

  it("should run the initial verification timer using the configured LSH base path", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(true);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(
        createServiceResult({
          messages: {
            [Output.Lsh]: [
              { topic: "custom/device-a/IN", payload: {} },
              { topic: "custom/device-b/OUT", payload: {} },
            ],
          },
        }),
      );

    await initializeNode({
      ...defaultNodeConfig,
      lshBasePath: "custom/",
      initialStateTimeout: 2,
      pingTimeout: 3,
    });
    mockNodeInstance.send.mockClear();

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(2000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Running initial device state verification: repairing incomplete snapshots and pinging unreachable devices...",
    );

    jest.advanceTimersByTime(3000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("should finish warm-up after the standard startup window when no retry is needed", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(true);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());
    const startupSpy = jest.spyOn(LshLogicService.prototype, "getStartupCommands");

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    jest.advanceTimersByTime(2500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(3000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalled();
    expect(startupSpy).toHaveBeenCalledTimes(1);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );
  });

  it("should anchor startup warm-up to the last staggered startup ping dispatch instead of the fixed verification start", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    jest.spyOn(LshLogicService.prototype, "verifyInitialDeviceStates").mockReturnValue(
      createServiceResult({
        messages: {
          [Output.Lsh]: [
            { topic: "LSH/dev1/IN", payload: { p: LshProtocol.PING } },
            { topic: "LSH/dev2/IN", payload: { p: LshProtocol.PING } },
          ],
        },
        staggerLshMessages: true,
      }),
    );
    jest
      .spyOn(utils, "sleep")
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });
    mockNodeInstance.log.mockClear();

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(250);
    await flushMicrotasks(6);

    jest.advanceTimersByTime(2750);
    await flushMicrotasks(6);
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );

    jest.advanceTimersByTime(249);
    await flushMicrotasks(6);
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );

    jest.advanceTimersByTime(1);
    await flushMicrotasks(6);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );
  });

  it("should delay startup BOOT until after settle and anchor verification to the replay time", async () => {
    const startupSpy = jest.spyOn(LshLogicService.prototype, "getStartupCommands");
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(true);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    const configurationCall = mockNodeInstance.send.mock.calls.find((call) => {
      const outputs = call[0] as Array<unknown>;
      return outputs[Output.Configuration] !== null;
    });
    expect(configurationCall).toBeDefined();
    expect(startupSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(499);
    await flushMicrotasks(6);
    expect(startupSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushMicrotasks(6);

    const configurationCallIndex = mockNodeInstance.send.mock.calls.indexOf(configurationCall!);
    const bootCallIndex = mockNodeInstance.send.mock.calls.findIndex((call) => {
      const outputs = call[0] as Array<{ payload?: { p?: number } } | null>;
      return outputs[Output.Lsh]?.payload?.p === LshProtocol.BOOT;
    });

    expect(startupSpy).toHaveBeenCalledTimes(1);
    expect(bootCallIndex).toBeGreaterThan(configurationCallIndex);
    expect(verifySpy).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Requesting startup bridge-local BOOT resync after MQTT subscription settle because one or more configured devices are missing authoritative snapshots.",
    );

    jest.advanceTimersByTime(1999);
    await flushMicrotasks(6);
    expect(verifySpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushMicrotasks(6);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("should skip startup BOOT and begin verification immediately after settle when replay is unnecessary", async () => {
    const startupSpy = jest.spyOn(LshLogicService.prototype, "getStartupCommands");
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    jest.advanceTimersByTime(499);
    await flushMicrotasks(6);
    expect(startupSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushMicrotasks(6);

    expect(startupSpy).not.toHaveBeenCalled();
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Skipping startup bridge-local BOOT resync because all configured devices already have authoritative details and state snapshots.",
    );
  });

  it("should suppress late startup ping recoveries until pingTimeout after the last staggered startup ping dispatch", async () => {
    jest.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        devices: [{ name: "dev1" }, { name: "dev2" }],
      }),
    );
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    jest.spyOn(LshLogicService.prototype, "verifyInitialDeviceStates").mockReturnValue(
      createServiceResult({
        messages: {
          [Output.Lsh]: [
            { topic: "LSH/dev1/IN", payload: { p: LshProtocol.PING } },
            { topic: "LSH/dev2/IN", payload: { p: LshProtocol.PING } },
          ],
        },
        staggerLshMessages: true,
      }),
    );
    jest
      .spyOn(utils, "sleep")
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(250);
    await flushMicrotasks(6);

    mockNodeInstance.send.mockClear();
    mockNodeInstance.log.mockClear();

    jest.advanceTimersByTime(2850);
    await flushMicrotasks(6);

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    const result = service.processMessage("LSH/dev2/events", { p: LshProtocol.PING });
    await nodeInstance.processServiceResult(result);

    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Suppressing 'device recovered' alert during warm-up period.",
    );
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );
  });

  it("should suppress late startup snapshot recoveries until pingTimeout after the last staggered startup recovery dispatch", async () => {
    jest.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify({
        devices: [{ name: "dev1" }],
      }),
    );
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    jest.spyOn(LshLogicService.prototype, "verifyInitialDeviceStates").mockReturnValue(
      createServiceResult({
        messages: {
          [Output.Lsh]: [
            { topic: "LSH/dev1/IN", payload: { p: LshProtocol.REQUEST_DETAILS } },
            { topic: "LSH/dev1/IN", payload: { p: LshProtocol.REQUEST_STATE } },
          ],
        },
        staggerLshMessages: true,
      }),
    );
    jest
      .spyOn(utils, "sleep")
      .mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    jest.advanceTimersByTime(500);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(250);
    await flushMicrotasks(6);

    mockNodeInstance.send.mockClear();
    mockNodeInstance.log.mockClear();

    jest.advanceTimersByTime(2850);
    await flushMicrotasks(6);
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );

    const service = (nodeInstance as unknown as { service: LshLogicService }).service;
    const result = service.processMessage("LSH/dev1/conf", {
      p: LshProtocol.DEVICE_DETAILS,
      v: LSH_WIRE_PROTOCOL_MAJOR,
      n: "dev1",
      a: [1],
      b: [],
    });
    await nodeInstance.processServiceResult(result);

    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Suppressing 'device recovered' alert during warm-up period.",
    );
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );
  });

  it("should run cleanup when the close handler is invoked", async () => {
    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(false);
    jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());
    await initializeNode();

    mockNodeInstance.log.mockClear();
    const done = jest.fn();

    getCloseHandler(mockNodeInstance)(done);
    await flushMicrotasks(6);

    expect(mockNodeInstance.log).toHaveBeenCalledWith("Closing LSH Logic node.");
    expect(done).toHaveBeenCalled();
  });

  it("should report errors raised during node close cleanup", async () => {
    await initializeNode();

    const cleanupSpy = jest
      .spyOn(nodeInstance, "_cleanupResources")
      .mockRejectedValue(new Error("cleanup boom"));
    const done = jest.fn();

    getCloseHandler(mockNodeInstance)(done);
    await flushMicrotasks(6);

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Error during node close: Error: cleanup boom",
    );
    expect(done).toHaveBeenCalled();
    cleanupSpy.mockRestore();
  });
});
