/**
 * @file Integration tests for the LshLogicNode adapter class.
 */
import { Node, NodeAPI } from "node-red";
import { LshLogicNode } from "../lsh-logic";
import { LshLogicNodeDef, ServiceResult, Output } from "../types";

jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

const fs = require("fs/promises");
const MOCK_CONFIG_CONTENT = JSON.stringify({
  devices: [{ name: "test-device" }],
});

const createMockNode = (): jest.Mocked<Node> => ({
  id: "test-node-id", type: "lsh-logic", z: "flow-id", name: "Test LSH Logic",
  on: jest.fn(), send: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), status: jest.fn(),
  context: jest.fn().mockReturnValue({
    flow: { get: jest.fn(), set: jest.fn() },
    global: { get: jest.fn(), set: jest.fn() },
  }),
} as any);

const mockRED: Partial<NodeAPI> = {
  nodes: { createNode: jest.fn() } as any,
  settings: { userDir: process.cwd() } as any,
};

const mockConfig: LshLogicNodeDef = {
  id: "test-node-id", type: "lsh-logic", name: "Test LSH Logic", z: "flow-id",
  homieBasePath: "homie/", lshBasePath: "LSH/", serviceTopic: "LSH/Node-RED/SRV",
  otherDevicesPrefix: "other_devices", otherActorsContext: "global",
  systemConfigPath: "configs/fake.json", clickTimeout: 15, clickCleanupInterval: 30,
  watchdogInterval: 120, interrogateThreshold: 3, pingTimeout: 15, initialStateTimeout: 0.01,
  exposeStateContext: "none", exposeStateKey: "lsh_state",
  exportTopics: "none", exportTopicsKey: "lsh_topics",
  exposeConfigContext: "none", exposeConfigKey: "lsh_config",
  protocol: "json", haDiscovery: false, haDiscoveryPrefix: "homeassistant",
};

// Helper to wait for the async initialization to complete
const awaitInitialization = async () => {
  jest.runOnlyPendingTimers();
  await Promise.resolve();
  jest.runOnlyPendingTimers();
  await Promise.resolve();
};

describe("LshLogicNode Adapter", () => {
  let mockNodeInstance: jest.Mocked<Node>;
  let nodeInstance: LshLogicNode;

  beforeEach(() => {
    jest.useFakeTimers();
    fs.readFile.mockResolvedValue(MOCK_CONFIG_CONTENT);
    mockNodeInstance = createMockNode();
  });

  afterEach(async () => {
    if ((nodeInstance as any)?.cleanupInterval) {
      await (nodeInstance as any)._cleanupResources();
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("should initialize correctly", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();

    expect(mockNodeInstance.status).toHaveBeenCalledWith({ fill: "blue", shape: "dot", text: "Initializing..." });
    expect(fs.readFile).toHaveBeenCalled();
    expect(mockNodeInstance.status).toHaveBeenCalledWith({ fill: "green", shape: "dot", text: "Ready" });
  });

  it("should handle file read error during initialization", async () => {
    const fileError = new Error("File not found");
    fs.readFile.mockRejectedValue(fileError);
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();

    expect(mockNodeInstance.error).toHaveBeenCalledWith(`Critical error during initialization: ${fileError.message}`);
    expect(mockNodeInstance.status).toHaveBeenCalledWith({ fill: "red", shape: "ring", text: "Config Error" });
  });

  it("should handle errors from the service during message processing", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();
    mockNodeInstance.send.mockClear();

    const testError = new Error("Service layer explosion!");
    const serviceInNode = (nodeInstance as any).service;
    jest.spyOn(serviceInNode, 'processMessage').mockImplementation(() => { throw testError; });

    const inputCallback = mockNodeInstance.on.mock.calls.find((call: any[]) => call[0] === "input")?.[1];
    const mockDone = jest.fn();

    if (inputCallback) {
      await (inputCallback as any)({ topic: "t", payload: "p" }, jest.fn(), mockDone);
    }

    expect(mockNodeInstance.error).toHaveBeenCalledWith("Error processing message: Service layer explosion!");
    expect(mockDone).toHaveBeenCalledWith(testError);
    expect(mockNodeInstance.send).not.toHaveBeenCalled();
  });

  it("should suppress 'device recovered' alerts during the warm-up period", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();
    mockNodeInstance.send.mockClear();

    (nodeInstance as any).isWarmingUp = true;
    const serviceResult: ServiceResult = {
      messages: { [Output.Alerts]: { payload: "✅ System Health Recovery..." } },
      logs: [], warnings: [], errors: [], stateChanged: false
    };

    await nodeInstance.processServiceResult(serviceResult);

    expect(mockNodeInstance.send).not.toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith("Suppressing 'device recovered' alert during warm-up period.");
  });

  it("should send LSH messages in a staggered sequence", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();
    mockNodeInstance.send.mockClear();

    const sleepMock = jest.spyOn(require("../utils"), "sleep").mockResolvedValue(undefined);
    const lshMsg1 = { topic: "LSH/dev1/IN", payload: "p1" };
    const lshMsg2 = { topic: "LSH/dev2/IN", payload: "p2" };
    const otherMsg = { payload: "other" };

    const serviceResult: ServiceResult = {
      messages: { [Output.Lsh]: [lshMsg1, lshMsg2], [Output.OtherActors]: otherMsg },
      logs: [], warnings: [], errors: [], stateChanged: false,
      staggerLshMessages: true
    };

    await nodeInstance.processServiceResult(serviceResult);

    expect(mockNodeInstance.send).toHaveBeenCalledTimes(3);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(1, [lshMsg1, null, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(2, [lshMsg2, null, null, null, null]);
    expect(mockNodeInstance.send).toHaveBeenNthCalledWith(3, [null, otherMsg, null, null, null]);
  });

  it("should update the exposed state in the context", async () => {
    const config: LshLogicNodeDef = { ...mockConfig, exposeStateContext: "flow", exposeStateKey: "my_state" };
    nodeInstance = new LshLogicNode(mockNodeInstance, config, mockRED as NodeAPI);
    await awaitInitialization();
    (mockNodeInstance.context().flow.set as jest.Mock).mockClear();

    const serviceInNode = (nodeInstance as any).service;
    const MOCK_REGISTRY = { "device-1": { name: "device-1" } };
    jest.spyOn(serviceInNode, 'getDeviceRegistry').mockReturnValue(MOCK_REGISTRY as any);

    const serviceResult: ServiceResult = { messages: {}, logs: [], warnings: [], errors: [], stateChanged: true };
    await nodeInstance.processServiceResult(serviceResult);

    const flowContext = mockNodeInstance.context().flow;
    expect(flowContext.set).toHaveBeenCalledWith("my_state", expect.objectContaining({
      devices: MOCK_REGISTRY
    }));
  });

  it("should log a message when the cleanup timer finds expired clicks", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();

    const serviceInNode = (nodeInstance as any).service;
    const cleanupSpy = jest.spyOn(serviceInNode, 'cleanupPendingClicks').mockReturnValue("Cleaned up 2 clicks.");

    jest.advanceTimersByTime(mockConfig.clickCleanupInterval * 1000);
    await Promise.resolve();

    expect(cleanupSpy).toHaveBeenCalled();
    expect(mockNodeInstance.log).toHaveBeenCalledWith("Cleaned up 2 clicks.");
  });

  it("should run the watchdog check periodically", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();

    const serviceInNode = (nodeInstance as any).service;
    const watchdogSpy = jest.spyOn(serviceInNode, 'runWatchdogCheck').mockReturnValue({
      messages: {}, logs: [], warnings: [], errors: [], stateChanged: false
    });
    const processResultSpy = jest.spyOn(nodeInstance, 'processServiceResult');

    jest.advanceTimersByTime(mockConfig.watchdogInterval * 1000);
    await Promise.resolve();

    expect(watchdogSpy).toHaveBeenCalled();
    expect(processResultSpy).toHaveBeenCalled();
  });

  it("should handle non-Error exceptions during message processing", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();
    mockNodeInstance.send.mockClear();

    const nonError = "A simple string error"; // Not an instance of Error
    const serviceInNode = (nodeInstance as any).service;
    jest.spyOn(serviceInNode, 'processMessage').mockImplementation(() => { throw nonError; });

    const inputCallback = mockNodeInstance.on.mock.calls.find((call: any[]) => call[0] === "input")?.[1];
    const mockDone = jest.fn();

    if (inputCallback) {
      await (inputCallback as any)({ topic: "t", payload: "p" }, jest.fn(), mockDone);
    }

    // Assert that the error message uses the string
    expect(mockNodeInstance.error).toHaveBeenCalledWith(`Error processing message: ${nonError}`);
    // Assert that done() is called with a new Error object
    expect(mockDone).toHaveBeenCalledWith(new Error(nonError));
  });

  it("should handle input messages with no topic", async () => {
    nodeInstance = new LshLogicNode(mockNodeInstance, mockConfig, mockRED as NodeAPI);
    await awaitInitialization();

    const serviceInNode = (nodeInstance as any).service;
    const processMessageSpy = jest.spyOn(serviceInNode, 'processMessage').mockReturnValue({
      messages: {}, logs: [], warnings: [], errors: [], stateChanged: false
    });

    const inputCallback = mockNodeInstance.on.mock.calls.find((call: any[]) => call[0] === "input")?.[1];
    const mockDone = jest.fn();

    // Message without 'topic'
    const msgWithoutTopic = { payload: "some_payload" };

    if (inputCallback) {
      await (inputCallback as any)(msgWithoutTopic, jest.fn(), mockDone);
    }

    // Assert that processMessage is called with an empty string as topic
    expect(processMessageSpy).toHaveBeenCalledWith("", "some_payload");
    // Called without errors
    expect(mockDone).toHaveBeenCalledWith();
  });
});