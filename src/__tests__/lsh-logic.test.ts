/**
 * @file Integration tests for the LshLogicNode orchestrator class.
 * These tests verify that the node correctly delegates tasks to its managers
 * and sends the appropriate messages based on inputs and internal logic.
 */
import { Node, NodeAPI } from "node-red";

import { LshLogicNode } from "../lsh-logic";
import { LshLogicNodeDef, Output } from "../types";
import { ClickTransactionManager } from "../ClickTransactionManager";

// --- MOCK SETUP ---
jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn().mockReturnValue({ on: jest.fn(), close: jest.fn() }),
}));
// Mock the entire ClickTransactionManager class
jest.mock("../ClickTransactionManager");

const fs = require("fs/promises");

/**
 * Mocks the Node-RED Node object.
 * Jest spies (`jest.fn()`) are used to track calls to node methods
 * like `on`, `send`, `log`, `status`, etc.
 */
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

/**
 * Mocks the Node-RED runtime API object.
 * Only the `settings.userDir` property is needed for the tests.
 */
const mockRED: Partial<NodeAPI> = {
  settings: { userDir: process.cwd() } as any,
};

/**
 * Mocks the node's user-defined configuration (`LshLogicNodeDef`).
 * Provides a default set of configuration properties for the node instance
 * under test.
 */
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

// --- TESTS ---
describe("LshLogicNode Orchestrator", () => {
  let instance: LshLogicNode;
  // Hold a reference to the mocked class constructor
  const MockedClickTransactionManager =
    ClickTransactionManager as jest.MockedClass<typeof ClickTransactionManager>;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFile.mockResolvedValue(JSON.stringify({ devices: [] }));
    instance = new LshLogicNode(
      mockNode as Node,
      mockConfig,
      mockRED as NodeAPI
    );
  });

  afterEach(() => {
    instance.testCleanup();
  });

  /**
   * Test helper to simulate an 'input' event on the mock node.
   * It retrieves the input callback registered in `beforeEach` and invokes it
   * with a mock message object.
   * @param topic - The topic of the simulated message.
   * @param payload - The payload of the simulated message.
   */
  const simulateInput = (topic: string, payload: any) => {
    const inputCallback = (mockNode.on as jest.Mock).mock.calls.find(
      (call) => call[0] === "input"
    )?.[1];
    if (inputCallback) {
      inputCallback({ topic, payload }, mockNode.send, jest.fn());
    }
  };

  it("should delegate storing device details to its manager", async () => {
    await new Promise(process.nextTick);

    const manager = (instance as any).deviceManager;
    const storeDetailsSpy = jest.spyOn(manager, "storeDeviceDetails");

    const payload = { dn: "test-device", ai: ["A1"], bi: [] };
    simulateInput("LSH/test-device/conf", payload);

    expect(storeDetailsSpy).toHaveBeenCalledWith("test-device", payload);
    expect(mockNode.log).toHaveBeenCalledWith(
      expect.stringContaining("Stored/Updated details for device 'test-device'")
    );
  });

  /**
   * Tests delegation of click handling to the ClickTransactionManager.
   */
  describe("Network Click Delegation", () => {
    // Hold a reference to the mocked class constructor
    const MockedClickManager = ClickTransactionManager as jest.MockedClass<
      typeof ClickTransactionManager
    >;

    // We don't need a beforeEach here anymore, we'll setup inside each test.

    it("should delegate starting a transaction on a valid click request", async () => {
      await new Promise(process.nextTick);

      // Setup
      const mockDeviceConfig = {
        name: "device-sender",
        longClickButtons: [
          {
            id: "B1",
            actors: [{ name: "actor1", allActuators: true, actuators: [] }],
            otherActors: [],
          },
        ],
        superLongClickButtons: [],
      };
      (instance as any).deviceConfigMap.set("device-sender", mockDeviceConfig);
      const deviceManager = (instance as any).deviceManager;
      deviceManager.storeDeviceDetails("actor1", {
        dn: "actor1",
        ai: ["A1"],
        bi: [],
      });

      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: false };
      simulateInput("LSH/device-sender/misc", payload);

      const managerInstance = MockedClickManager.mock.instances[0];

      // Verify delegation
      expect(managerInstance.startTransaction).toHaveBeenCalledTimes(1);

      // Get all arguments with which `send` was called
      const sendCalls = (mockNode.send as jest.Mock).mock.calls;

      // Find the specific call that contains the ACK message
      const ackCall = sendCalls.find(
        (call) =>
          call[0] && // The argument exists
          call[0][Output.Lsh] && // The LSH output is not null
          call[0][Output.Lsh].payload.p === "d_nca" // It's an ACK
      );

      // Assert that we found such a call
      expect(ackCall).toBeDefined();

      // Optionally, be more specific about the found call
      expect(ackCall[0]).toEqual([
        // The first element of the array must be an object that contains AT LEAST these properties
        expect.objectContaining({
          topic: "LSH/device-sender/IN",
          payload: { p: "d_nca", bi: "B1", ct: "lc" },
        }),
        // The rest must be null
        null,
        null,
        null,
      ]);
    });

    it("should delegate consuming a transaction on a click confirmation", async () => {
      await new Promise(process.nextTick);

      // Get the manager instance created by the LshLogicNode constructor
      const managerInstance = MockedClickManager.mock.instances[0];

      // Mock the manager to return a valid transaction for this specific test
      const mockTransaction = { actors: [], otherActors: [] };
      (managerInstance.consumeTransaction as jest.Mock).mockReturnValue(
        mockTransaction
      );

      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: true };
      simulateInput("LSH/device-sender/misc", payload);

      // Verify delegation
      expect(managerInstance.consumeTransaction).toHaveBeenCalledTimes(1);
      expect(managerInstance.consumeTransaction).toHaveBeenCalledWith(
        "device-sender.B1.lc"
      );

      // Verify the node tries to execute logic as a side-effect
      expect(mockNode.log).toHaveBeenCalledWith(
        expect.stringContaining("Click confirmed")
      );
    });

    it("should warn if a confirmation for a non-existent transaction is received", async () => {
      await new Promise(process.nextTick);

      const managerInstance = MockedClickManager.mock.instances[0];

      // Mock the manager to return null, as if the transaction expired
      (managerInstance.consumeTransaction as jest.Mock).mockReturnValue(null);

      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: true };
      simulateInput("LSH/device-sender/misc", payload);

      expect(managerInstance.consumeTransaction).toHaveBeenCalledTimes(1);
      expect(mockNode.warn).toHaveBeenCalledWith(
        expect.stringContaining("expired or unknown click")
      );
    });
  });
});
