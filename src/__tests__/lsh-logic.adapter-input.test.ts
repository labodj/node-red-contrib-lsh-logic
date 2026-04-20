import * as chokidar from "chokidar";
import * as fs from "fs/promises";
import type { NodeAPI } from "node-red";
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
  waitForInitialization,
} from "./helpers/lshLogicAdapterTestUtils";

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

  it("should fall back to process.cwd and stringify non-Error initialization failures", async () => {
    jest.mocked(fs.readFile).mockRejectedValue("missing config");
    mockRED = {
      nodes: { createNode: jest.fn(), registerType: jest.fn() },
      settings: {},
    } as unknown as NodeAPI;

    await initializeNode(defaultNodeConfig, mockRED);

    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringContaining(defaultNodeConfig.systemConfigPath),
      "utf-8",
    );
    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Critical error during initialization: missing config",
    );
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

    await getInputHandler(mockNodeInstance)(message, jest.fn(), done);

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

    const done = jest.fn();
    const payload = new LshCodec().encode({ p: 6, i: 1, t: 1 }, "msgpack");

    await getInputHandler(mockNodeInstance)(
      {
        topic: "LSH/device-1/events",
        payload,
      },
      jest.fn(),
      done,
    );

    expect(mockNodeInstance.log).toHaveBeenCalledWith(
      "Decoded MsgPack payload from topic: LSH/device-1/events",
    );
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

  it("should handle non-Error exceptions during message processing", async () => {
    jest.spyOn(LshLogicService.prototype, "processMessage").mockImplementation(() => {
      throw "A simple string error";
    });

    await initializeNode();

    const done = jest.fn();

    await getInputHandler(mockNodeInstance)({ topic: "t", payload: "p" }, jest.fn(), done);

    expect(mockNodeInstance.error).toHaveBeenCalledWith(
      "Error processing message: A simple string error",
    );
    expect(done).toHaveBeenCalledWith(new Error("A simple string error"));
  });

  it("should handle input messages with no topic", async () => {
    const processMessageSpy = jest
      .spyOn(LshLogicService.prototype, "processMessage")
      .mockReturnValue(createServiceResult());

    await initializeNode();

    const done = jest.fn();

    await getInputHandler(mockNodeInstance)({ payload: "some_payload" }, jest.fn(), done);

    expect(processMessageSpy).toHaveBeenCalledWith("", "some_payload", { retained: false });
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
      }),
    );

    expect(mockNodeInstance.send).toHaveBeenCalledWith([null, null, null, expect.any(Array), null]);
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
