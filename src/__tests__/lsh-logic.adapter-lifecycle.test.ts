import * as utils from "../utils";
import { LshLogicService } from "../LshLogicService";
import type { LshLogicNode } from "../lsh-logic";
import { Output } from "../types";
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

  it("should suppress healthy alerts during the warm-up period", async () => {
    await initializeNode(warmupNodeConfig);
    mockNodeInstance.send.mockClear();

    await nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Alerts]: {
            payload: {
              status: "healthy",
              message: "✅ System Health Recovery...",
              devices: [],
            } as AlertPayload,
          },
        },
      }),
    );

    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Suppressing 'device recovered' alert during warm-up period.",
    );
  });

  it("should suppress string recovery alerts during the warm-up period", async () => {
    await initializeNode(warmupNodeConfig);
    mockNodeInstance.send.mockClear();

    await nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Alerts]: {
            payload: "✅ Device recovered",
          },
        },
      }),
    );

    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Suppressing 'device recovered' alert during warm-up period.",
    );
  });

  it("should forward non-recovery alerts during the warm-up period", async () => {
    await initializeNode(warmupNodeConfig);
    mockNodeInstance.send.mockClear();

    await nodeInstance.processServiceResult(
      createServiceResult({
        messages: {
          [Output.Alerts]: {
            payload: 123,
          },
        },
      }),
    );

    expect(mockNodeInstance.send).toHaveBeenCalledWith([null, null, { payload: 123 }, null, null]);
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

    expect(mockNodeInstance.send).toHaveBeenCalledTimes(3);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(1, [lshMsg1, null, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(2, [lshMsg2, null, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(3, [null, otherMsg, null, null, null]);
  });

  it("should update the exposed state in context when state changes", async () => {
    const deviceState: DeviceState = {
      name: "device-1",
      connected: true,
      isHealthy: true,
      isStale: false,
      lastSeenTime: 1,
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

  it("should skip watchdog checks while the node is still warming up", async () => {
    jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      watchdogInterval: 1,
      initialStateTimeout: 10,
      pingTimeout: 10,
    });

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

  it("should not restart startup verification timers on config reload", async () => {
    const verifySpy = jest.spyOn(LshLogicService.prototype, "verifyInitialDeviceStates");

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });
    verifySpy.mockClear();

    await nodeInstance.handleConfigFileChange("/tmp/new-config.json", createValidator(true));
    jest.advanceTimersByTime(5000);
    await flushMicrotasks(6);

    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("should handle config reload failures", async () => {
    await initializeNode();

    const validateFn = createValidator(false);
    validateFn.errors = [createAjvError("invalid config")];

    await nodeInstance.handleConfigFileChange("/tmp/bad-config.json", validateFn);

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Error reloading /tmp/bad-config.json: Invalid system-config.json: invalid config",
    );
    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "red",
      shape: "ring",
      text: "Config reload failed",
    });
  });

  it("should delegate file watcher change events to the reload handler", async () => {
    await initializeNode();

    const reloadSpy = jest
      .spyOn(nodeInstance, "handleConfigFileChange")
      .mockResolvedValue(undefined);
    const changeHandler = mockWatcher.on.mock.calls.find(([event]) => event === "change")?.[1] as
      | ((path: string) => void)
      | undefined;

    expect(changeHandler).toBeDefined();
    changeHandler?.("/tmp/changed-config.json");
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(reloadSpy).toHaveBeenCalledWith("/tmp/changed-config.json", expect.any(Function));
  });

  it("should delegate file watcher add events to the reload handler after debounce", async () => {
    await initializeNode();

    const reloadSpy = jest
      .spyOn(nodeInstance, "handleConfigFileChange")
      .mockResolvedValue(undefined);
    const addHandler = mockWatcher.on.mock.calls.find(([event]) => event === "add")?.[1] as
      | ((path: string) => void)
      | undefined;

    expect(addHandler).toBeDefined();
    addHandler?.("/tmp/changed-config.json");
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(reloadSpy).toHaveBeenCalledWith("/tmp/changed-config.json", expect.any(Function));
  });

  it("should allow an empty discovery prefix when HA discovery is disabled", async () => {
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
  });

  it("should reject an empty discovery prefix when HA discovery is enabled", async () => {
    await expect(
      initializeNode({
        ...defaultNodeConfig,
        haDiscovery: true,
        haDiscoveryPrefix: "   ",
      }),
    ).rejects.toThrow("Discovery Prefix cannot be empty.");
  });

  it("should reject topic bases without a trailing slash", async () => {
    await expect(
      initializeNode({
        ...defaultNodeConfig,
        lshBasePath: "custom/base",
      }),
    ).rejects.toThrow("LSH Base Path must end with '/'.");
  });

  it("should run the initial verification timer using the configured LSH base path", async () => {
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

    jest.advanceTimersByTime(2000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Running initial device state verification: pinging unreachable devices...",
    );

    jest.advanceTimersByTime(3000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("should finish warm-up without any second startup verification phase", async () => {
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    jest.advanceTimersByTime(2000);
    await flushMicrotasks(6);
    jest.advanceTimersByTime(3000);
    await flushMicrotasks(6);

    expect(verifySpy).toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Warm-up period finished. Node is now fully operational.",
    );
  });

  it("should run cleanup when the close handler is invoked", async () => {
    await initializeNode();

    mockNodeInstance.log.mockClear();
    const done = jest.fn();

    getCloseHandler(mockNodeInstance)(done);
    await flushMicrotasks();

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
