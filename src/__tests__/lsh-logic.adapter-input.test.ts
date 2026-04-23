import * as chokidar from "chokidar";
import * as fs from "fs/promises";
import type { NodeAPI, NodeMessage } from "node-red";
import { LshLogicService } from "../LshLogicService";
import { LshCodec } from "../LshCodec";
import type { LshLogicNode } from "../lsh-logic";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";
import { defaultNodeConfig } from "./helpers/nodeRedTestUtils";
import type { AdapterHarness } from "./helpers/lshLogicAdapterTestUtils";
import {
  createAdapterHarness,
  createServiceResult,
  getCloseHandler,
  getInputHandler,
  MOCK_CONFIG_CONTENT,
  waitForInitialization,
} from "./helpers/lshLogicAdapterTestUtils";
import { flushMicrotasks } from "./helpers/nodeRedTestUtils";

jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn(),
}));

describe("LshLogicNode Adapter - Initialization & Input", () => {
  let adapterHarness: AdapterHarness;
  let mockNodeInstance: MockNodeInstance;
  let nodeInstance: LshLogicNode;
  let mockRED: NodeAPI;

  const initializeNode = async (
    config = defaultNodeConfig,
    red = mockRED,
  ): Promise<LshLogicNode> => {
    nodeInstance = await adapterHarness.initializeNode(config, red);
    return nodeInstance;
  };

  beforeEach(() => {
    jest.useFakeTimers();

    adapterHarness = createAdapterHarness();
    mockNodeInstance = adapterHarness.mockNodeInstance;
    mockRED = adapterHarness.mockRED;
  });

  afterEach(async () => {
    await adapterHarness.cleanupNode();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("should initialize correctly", async () => {
    await initializeNode();

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "blue",
      shape: "dot",
      text: "Initializing...",
    });
    expect(fs.readFile).toHaveBeenCalled();
    expect(chokidar.watch).toHaveBeenCalled();
    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });
  });

  it("should handle file read errors during initialization", async () => {
    jest.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));

    await initializeNode();

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Critical error during initialization: File not found",
    );
    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "red",
      shape: "ring",
      text: "Config Error",
    });
  });

  it("should keep the file watcher active so a startup config failure can recover after the file is fixed", async () => {
    const cleanupSpy = jest
      .spyOn(LshLogicService.prototype, "cleanupPendingClicks")
      .mockReturnValue(null);
    jest
      .mocked(fs.readFile)
      .mockRejectedValueOnce(new Error("File not found"))
      .mockResolvedValue(MOCK_CONFIG_CONTENT);

    await initializeNode();

    jest.advanceTimersByTime(defaultNodeConfig.clickCleanupInterval * 1000);
    expect(cleanupSpy).not.toHaveBeenCalled();

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "red",
      shape: "ring",
      text: "Config Error",
    });

    mockNodeInstance.status.mockClear();

    const changeHandler = adapterHarness.mockWatcher.on.mock.calls.find(
      ([event]) => event === "change",
    )?.[1] as ((changedPath: string) => void) | undefined;

    expect(changeHandler).toBeDefined();
    changeHandler?.("/tmp/fixed-config.json");
    jest.advanceTimersByTime(250);
    await flushMicrotasks(16);

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });

    jest.advanceTimersByTime(defaultNodeConfig.clickCleanupInterval * 1000);
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it("should re-enter the full startup bootstrap flow when a startup config failure is later fixed", async () => {
    jest
      .mocked(fs.readFile)
      .mockRejectedValueOnce(new Error("File not found"))
      .mockResolvedValue(MOCK_CONFIG_CONTENT);

    jest.spyOn(LshLogicService.prototype, "needsStartupBootReplay").mockReturnValue(true);
    const startupSpy = jest
      .spyOn(LshLogicService.prototype, "getStartupCommands")
      .mockReturnValue(createServiceResult());
    const verifySpy = jest
      .spyOn(LshLogicService.prototype, "verifyInitialDeviceStates")
      .mockReturnValue(createServiceResult());
    const watchdogSpy = jest
      .spyOn(LshLogicService.prototype, "runWatchdogCheck")
      .mockReturnValue(createServiceResult());

    await initializeNode({
      ...defaultNodeConfig,
      watchdogInterval: 1,
      initialStateTimeout: 2,
      pingTimeout: 3,
    });

    const changeHandler = adapterHarness.mockWatcher.on.mock.calls.find(
      ([event]) => event === "change",
    )?.[1] as ((changedPath: string) => void) | undefined;

    expect(changeHandler).toBeDefined();
    changeHandler?.("/tmp/fixed-config.json");
    jest.advanceTimersByTime(250);
    await flushMicrotasks(16);

    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Configuration successfully recovered from /tmp/fixed-config.json. Restarting the full startup bootstrap flow.",
    );
    expect(mockNodeInstance.log).not.toHaveBeenCalledWith(
      "Running post-reload device recovery: reconciling snapshots for the updated runtime configuration.",
    );

    jest.advanceTimersByTime(499);
    await flushMicrotasks(6);
    expect(startupSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await flushMicrotasks(6);
    expect(startupSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    await flushMicrotasks(6);
    expect(watchdogSpy).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2000);
    await flushMicrotasks(6);
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it("should not mark the node ready until the newest queued startup reload has actually applied", async () => {
    let resolveFirstRead: ((value: string) => void) | undefined;
    let resolveSecondRead: ((value: string) => void) | undefined;

    const firstRead = new Promise<string>((resolve) => {
      resolveFirstRead = resolve;
    });
    const secondRead = new Promise<string>((resolve) => {
      resolveSecondRead = resolve;
    });

    jest
      .mocked(fs.readFile)
      .mockImplementationOnce(async () => firstRead)
      .mockImplementationOnce(async () => secondRead);

    await initializeNode();

    const changeHandler = adapterHarness.mockWatcher.on.mock.calls.find(
      ([event]) => event === "change",
    )?.[1] as ((changedPath: string) => void) | undefined;

    expect(changeHandler).toBeDefined();
    mockNodeInstance.status.mockClear();
    mockNodeInstance.log.mockClear();

    changeHandler?.("/tmp/reloaded-config.json");
    jest.advanceTimersByTime(250);
    await flushMicrotasks(6);

    resolveFirstRead?.(JSON.stringify({ devices: [{ name: "initial-device" }] }));
    await flushMicrotasks(10);

    expect(mockNodeInstance.status).not.toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });
    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Initial config load was superseded by a newer queued reload. Waiting for the latest load to determine readiness.",
    );

    resolveSecondRead?.(JSON.stringify({ devices: [{ name: "reloaded-device" }] }));
    await flushMicrotasks(12);

    expect(mockNodeInstance.status).toHaveBeenCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready",
    });
  });

  it("should decode Homie buffer payloads as text before passing them to the service", async () => {
    const processMessageSpy = jest
      .spyOn(LshLogicService.prototype, "processMessage")
      .mockReturnValue(createServiceResult());

    await initializeNode();

    const done = jest.fn();
    const message = {
      topic: "homie/device-1/$state",
      payload: Buffer.from("ready"),
    };

    getInputHandler(mockNodeInstance)(message, jest.fn(), done);
    await flushMicrotasks();

    expect(processMessageSpy).toHaveBeenCalledWith("homie/device-1/$state", "ready", {
      retained: false,
    });
    expect(mockNodeInstance.send).toHaveBeenLastCalledWith([null, null, null, null, message]);
    expect(done).toHaveBeenCalledWith();
  });

  it("should decode LSH MsgPack payloads before passing them to the service", async () => {
    const processMessageSpy = jest
      .spyOn(LshLogicService.prototype, "processMessage")
      .mockReturnValue(createServiceResult());

    await initializeNode({ ...defaultNodeConfig, protocol: "msgpack" });
    mockNodeInstance.log.mockClear();

    const done = jest.fn();
    const payload = new LshCodec().encode({ p: 6, i: 1, t: 1 }, "msgpack");

    getInputHandler(mockNodeInstance)(
      {
        topic: "LSH/device-1/events",
        payload,
      },
      jest.fn(),
      done,
    );
    await flushMicrotasks();

    expect(mockNodeInstance.log).not.toHaveBeenCalled();
    expect(processMessageSpy).toHaveBeenCalledWith(
      "LSH/device-1/events",
      {
        p: 6,
        i: 1,
        t: 1,
      },
      { retained: false },
    );
    expect(done).toHaveBeenCalledWith();
  });

  it("should handle decode errors before the service is called", async () => {
    await initializeNode({ ...defaultNodeConfig, protocol: "msgpack" });
    mockNodeInstance.send.mockClear();

    const done = jest.fn();

    await getInputHandler(mockNodeInstance)(
      {
        topic: "LSH/device-1/events",
        payload: Buffer.from([0xc1]),
      },
      jest.fn(),
      done,
    );

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to decode payload on topic LSH/device-1/events:"),
    );
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(mockNodeInstance.send).not.toHaveBeenCalled();
  });

  it("should reject non-Buffer LSH MsgPack payloads when mqtt-in returns parsed text or objects", async () => {
    for (const payload of ['{"p":6,"i":1,"t":1}', { p: 6, i: 1, t: 1 }]) {
      const processMessageSpy = jest.spyOn(LshLogicService.prototype, "processMessage");

      await initializeNode({ ...defaultNodeConfig, protocol: "msgpack" });
      mockNodeInstance.send.mockClear();
      mockNodeInstance.error.mockClear();

      const done = jest.fn();

      await getInputHandler(mockNodeInstance)(
        {
          topic: "LSH/device-1/events",
          payload,
        },
        jest.fn(),
        done,
      );

      expect(processMessageSpy).not.toHaveBeenCalled();
      expect(mockNodeInstance.error).toHaveBeenCalledWith(
        "Failed to decode payload on topic LSH/device-1/events: MsgPack payloads must arrive as Buffers.",
      );
      expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(mockNodeInstance.send).not.toHaveBeenCalled();
      processMessageSpy.mockRestore();
    }
  });

  it("should handle errors from the service during message processing", async () => {
    jest.spyOn(LshLogicService.prototype, "processMessage").mockImplementation(() => {
      throw new Error("Service layer explosion!");
    });

    await initializeNode();
    mockNodeInstance.send.mockClear();

    const done = jest.fn();

    await getInputHandler(mockNodeInstance)({ topic: "t", payload: "p" }, jest.fn(), done);

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Error processing message: Service layer explosion!",
    );
    expect(done).toHaveBeenCalledWith(new Error("Service layer explosion!"));
    expect(mockNodeInstance.send).not.toHaveBeenCalled();
  });

  it("should ignore new input once close has started", async () => {
    const processMessageSpy = jest
      .spyOn(LshLogicService.prototype, "processMessage")
      .mockReturnValue(createServiceResult());

    await initializeNode();
    processMessageSpy.mockClear();
    mockNodeInstance.send.mockClear();

    getCloseHandler(mockNodeInstance)(jest.fn());

    const done = jest.fn();
    await getInputHandler(mockNodeInstance)({ topic: "t", payload: "p" }, jest.fn(), done);

    expect(processMessageSpy).not.toHaveBeenCalled();
    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith();
  });

  it("should handle input messages with no topic", async () => {
    const processMessageSpy = jest
      .spyOn(LshLogicService.prototype, "processMessage")
      .mockReturnValue(createServiceResult());

    await initializeNode();

    const done = jest.fn();

    getInputHandler(mockNodeInstance)({ payload: "some_payload" }, jest.fn(), done);
    await flushMicrotasks();

    expect(processMessageSpy).toHaveBeenCalledWith("", "some_payload", { retained: false });
    expect(done).toHaveBeenCalledWith();
  });

  it("should reject inbound messages with a non-string topic explicitly", async () => {
    const processMessageSpy = jest.spyOn(LshLogicService.prototype, "processMessage");

    await initializeNode();

    const done = jest.fn();

    await getInputHandler(mockNodeInstance)(
      { topic: { bad: true }, payload: "some_payload" } as unknown as NodeMessage,
      jest.fn(),
      done,
    );

    expect(processMessageSpy).not.toHaveBeenCalled();
    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Rejected inbound message: Inbound msg.topic must be a string when provided, got object.",
    );
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
    processMessageSpy.mockRestore();
  });

  it("should refresh exposed state for retained Homie baselines even when stateChanged stays false", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      exposeStateContext: "flow",
      exposeStateKey: "lsh_state",
    });

    mockNodeInstance.__context.flow.set.mockClear();

    const done = jest.fn();
    getInputHandler(mockNodeInstance)(
      {
        topic: "homie/test-device/$state",
        payload: "ready",
        retain: true,
      },
      jest.fn(),
      done,
    );
    await flushMicrotasks();

    expect(mockNodeInstance.__context.flow.set).toHaveBeenCalledWith(
      "lsh_state",
      expect.objectContaining({
        devices: expect.objectContaining({
          "test-device": expect.objectContaining({
            lastHomieState: "ready",
            connected: false,
          }),
        }),
      }),
    );
    expect(done).toHaveBeenCalledWith();
  });

  it("should export topics and exposed config during initialization", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      exportTopics: "flow",
      exportTopicsKey: "lsh_topics",
      exposeConfigContext: "global",
      exposeConfigKey: "lsh_config",
      haDiscovery: true,
    });

    expect(mockNodeInstance.__context.global.set).toHaveBeenCalledWith(
      "lsh_config",
      expect.objectContaining({
        nodeConfig: expect.objectContaining({ haDiscovery: true }),
        systemConfig: expect.objectContaining({
          devices: [{ name: "test-device" }],
        }),
      }),
    );
    expect(mockNodeInstance.__context.flow.set).toHaveBeenCalledWith(
      "lsh_topics",
      expect.objectContaining({
        lsh: [
          "LSH/test-device/conf",
          "LSH/test-device/state",
          "LSH/test-device/events",
          "LSH/test-device/bridge",
        ],
        homie: ["homie/test-device/$state"],
        discovery: [
          "homie/+/$nodes",
          "homie/+/$mac",
          "homie/+/$fw/version",
          "homie/+/+/state/$datatype",
          "homie/+/+/state/$settable",
        ],
        all: expect.arrayContaining([
          "homie/test-device/$state",
          "homie/+/$nodes",
          "homie/+/$mac",
          "homie/+/$fw/version",
          "homie/+/+/state/$datatype",
          "homie/+/+/state/$settable",
          "LSH/test-device/conf",
          "LSH/test-device/state",
          "LSH/test-device/events",
          "LSH/test-device/bridge",
        ]),
      }),
    );

    expect(mockNodeInstance.send).toHaveBeenCalledWith([null, null, null, expect.any(Array), null]);
  });

  it("should export a detached node config snapshot to context", async () => {
    await initializeNode({
      ...defaultNodeConfig,
      exposeConfigContext: "global",
      exposeConfigKey: "lsh_config",
    });

    const firstExport = mockNodeInstance.__context.global.set.mock.calls.find(
      ([key]) => key === "lsh_config",
    )?.[1] as
      | {
          nodeConfig: typeof defaultNodeConfig;
        }
      | undefined;

    expect(firstExport).toBeDefined();
    firstExport!.nodeConfig.protocol = "msgpack";

    (nodeInstance as unknown as { updateExposedConfig: () => void }).updateExposedConfig();

    const lastExport = mockNodeInstance.__context.global.set.mock.calls.at(-1)?.[1] as {
      nodeConfig: typeof defaultNodeConfig;
    };

    expect(lastExport.nodeConfig.protocol).toBe("json");
  });

  it("should export only the unsubscribe message when no devices are configured", async () => {
    jest.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ devices: [] }));

    await initializeNode({
      ...defaultNodeConfig,
      exportTopics: "flow",
      exportTopicsKey: "empty_topics",
      haDiscovery: false,
    });

    expect(mockNodeInstance.send).toHaveBeenCalledWith([
      null,
      null,
      null,
      [{ action: "unsubscribe", topic: true }],
      null,
    ]);
    expect(mockNodeInstance.__context.flow.set).toHaveBeenCalledWith(
      "empty_topics",
      expect.objectContaining({
        lsh: [],
        homie: [],
        discovery: [],
        all: [],
      }),
    );
  });

  it("should register the node type and instantiate the wrapper through the module export", async () => {
    const nodeRedModule = require("../lsh-logic") as ((red: NodeAPI) => void) & {
      LshLogicNode: typeof LshLogicNode;
    };

    nodeRedModule(mockRED);

    expect(mockRED.nodes.registerType).toHaveBeenCalledWith("lsh-logic", expect.any(Function));

    const wrapper = (mockRED.nodes.registerType as jest.Mock).mock.calls[0][1] as (
      this: MockNodeInstance,
      config: typeof defaultNodeConfig,
    ) => void;

    wrapper.call(mockNodeInstance, defaultNodeConfig);
    await waitForInitialization();

    expect(mockRED.nodes.createNode).toHaveBeenCalledWith(mockNodeInstance, defaultNodeConfig);
    expect(mockNodeInstance.on).toHaveBeenCalledWith("input", expect.any(Function));
    expect(mockNodeInstance.on).toHaveBeenCalledWith("close", expect.any(Function));

    const done = jest.fn();
    getCloseHandler(mockNodeInstance)(done);
    await waitForInitialization();

    expect(done).toHaveBeenCalled();
  });
});
