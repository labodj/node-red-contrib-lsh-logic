/**
 * @file Integration tests for the LshLogicNode adapter class.
 * These tests verify that the node correctly interfaces with the LshLogicService
 * and the Node-RED runtime, delegating business logic and processing results.
 */
import { Node, NodeAPI } from "node-red";
import { LshLogicNode } from "../lsh-logic";
import { LshLogicNodeDef, Output, ServiceResult } from "../types";
import { LshLogicService } from "../LshLogicService";
import { sleep } from "../utils";

// --- MOCK SETUP ---
jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn().mockReturnValue({ on: jest.fn(), close: jest.fn() }),
}));
// Mock the entire service class
jest.mock("../LshLogicService");
// Mock the sleep utility to avoid actual delays in tests
jest.mock("../utils", () => ({
  ...jest.requireActual("../utils"), // keep original formatAlertMessage etc.
  sleep: jest.fn().mockResolvedValue(undefined),
}));

const fs = require("fs/promises");
const MockedLshLogicService = LshLogicService as jest.MockedClass<typeof LshLogicService>;

/** Mocks the Node-RED Node object. */
const mockNode: Partial<Node> = {
  id: "test-node-id",
  on: jest.fn(),
  send: jest.fn(),
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  status: jest.fn(),
  context: () =>
  ({
    flow: { get: jest.fn(), set: jest.fn() },
    global: { get: jest.fn(), set: jest.fn() },
  } as any),
};

/** Mocks the Node-RED runtime API object. */
const mockRED: Partial<NodeAPI> = {
  settings: { userDir: process.cwd() } as any,
};

/** Mocks the node's user-defined configuration. */
const mockConfig: LshLogicNodeDef = {
  id: "test-node-id",
  type: "lsh-logic",
  name: "Test LSH Logic",
  z: "flow-id",
  homieBasePath: "homie/",
  lshBasePath: "LSH/",
  serviceTopic: "LSH/Node-RED/SRV",
  otherDevicesPrefix: "other_devices",
  otherActorsContext: "global",
  longClickConfigPath: "configs/fake.json",
  clickTimeout: 15,
  clickCleanupInterval: 30,
  watchdogInterval: 2,
  interrogateThreshold: 3,
  pingTimeout: 150,
  exposeStateContext: "none",
  exposeStateKey: "",
  exportTopics: "none",
  exportTopicsKey: "",
  exposeConfigContext: "none",
  exposeConfigKey: "",
};

describe("LshLogicNode Adapter", () => {
  let instance: LshLogicNode;
  let mockService: jest.Mocked<LshLogicService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    MockedLshLogicService.mockClear();
    fs.readFile.mockResolvedValue(JSON.stringify({ devices: [] }));

    instance = new LshLogicNode(mockNode as Node, mockConfig, mockRED as NodeAPI);
    await new Promise(process.nextTick);

    mockService = MockedLshLogicService.mock.instances[0] as jest.Mocked<LshLogicService>;
  });

  afterEach(() => {
    instance.testCleanup();
  });

  const simulateInput = async (topic: string, payload: any) => {
    const inputCallback = (mockNode.on as jest.Mock).mock.calls.find(
      (call) => call[0] === "input"
    )?.[1];
    if (inputCallback) {
      const done = jest.fn();
      await inputCallback({ topic, payload }, mockNode.send, done);
      return done;
    }
  };

  it("should instantiate LshLogicService with correct dependencies", () => {
    expect(MockedLshLogicService).toHaveBeenCalledTimes(1);
    expect(MockedLshLogicService).toHaveBeenCalledWith(
      expect.any(Object), // config object
      expect.any(Object), // context reader
      expect.objectContaining({ // validators object
        validateDeviceDetails: expect.any(Function),
        validateActuatorStates: expect.any(Function),
        validateAnyMiscTopic: expect.any(Function),
      })
    );
  });

  it("should delegate message processing and handle the result", async () => {
    // Arrange
    const serviceResult: ServiceResult = {
      messages: { [Output.Lsh]: { topic: "test/lsh", payload: "test" } },
      logs: ["log message"],
      warnings: ["warning message"],
      errors: [],
      stateChanged: true
    };
    mockService.processMessage.mockReturnValue(serviceResult);
    const updateStateSpy = jest.spyOn(instance as any, 'updateExposedState').mockImplementation(() => { });

    // Act
    await simulateInput("any/topic", {});

    // Assert
    expect(mockService.processMessage).toHaveBeenCalledWith("any/topic", {});
    expect(mockNode.log).toHaveBeenCalledWith("log message");
    expect(mockNode.warn).toHaveBeenCalledWith("warning message");
    expect(updateStateSpy).toHaveBeenCalled();
    expect(mockNode.send).toHaveBeenCalledWith(expect.arrayContaining([serviceResult.messages[Output.Lsh]]));
  });

  it("should handle staggered sends correctly", async () => {
    // Arrange
    const staggeredMessages = [
      { topic: "dev1/IN", payload: "ping" },
      { topic: "dev2/IN", payload: "ping" },
    ];
    const serviceResult: ServiceResult = {
      messages: { [Output.Lsh]: staggeredMessages },
      logs: [], warnings: [], errors: [], stateChanged: false
    };
    mockService.processMessage.mockReturnValue(serviceResult);

    // Act
    await simulateInput("any/topic", {});

    // Assert
    expect(mockNode.send).toHaveBeenCalledTimes(2); // Called once for each message in the array
    expect(mockNode.send).toHaveBeenCalledWith(expect.arrayContaining([staggeredMessages[0]]));
    expect(mockNode.send).toHaveBeenCalledWith(expect.arrayContaining([staggeredMessages[1]]));
    expect(sleep).toHaveBeenCalledTimes(2); // Sleep is called for each message
  });
});