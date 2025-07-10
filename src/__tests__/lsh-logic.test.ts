/**
 * @file Integration tests for the LshLogicNode orchestrator class.
 * These tests verify that the node correctly delegates tasks to its managers
 * and sends the appropriate messages based on inputs and internal logic.
 */
import { Node, NodeAPI, NodeMessage } from "node-red";

import { LshLogicNode } from "../lsh-logic";
import { LshLogicNodeDef, LshProtocol, Output, OutputMessages } from "../types";
import { ClickTransactionManager } from "../ClickTransactionManager";

// --- MOCK SETUP ---
jest.mock("fs/promises");
jest.mock("chokidar", () => ({
  watch: jest.fn().mockReturnValue({ on: jest.fn(), close: jest.fn() }),
}));
jest.mock("../ClickTransactionManager");

const fs = require("fs/promises");

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

// --- TESTS ---
describe("LshLogicNode Orchestrator", () => {
  let instance: LshLogicNode;
  const MockedClickManager = ClickTransactionManager as jest.MockedClass<
    typeof ClickTransactionManager
  >;

  /**
   * Test Helper: Creates the full output array for a `node.send` call.
   * This makes tests robust against changes in the number of outputs.
   * @param messages - An object mapping an Output enum member to the expected message.
   * @returns A full output array with `null` for unspecified outputs.
   */
  const createExpectedOutput = (messages: OutputMessages): (NodeMessage | null)[] => {
    const numOutputs = Object.keys(Output).length / 2;
    const outputArray: (NodeMessage | null)[] = new Array(numOutputs).fill(null);
    for (const key in messages) {
      if (messages.hasOwnProperty(key)) {
        const keyNum = Number(key);
        if (!isNaN(keyNum)) {
          outputArray[keyNum] = messages[keyNum as Output] || null;
        }
      }
    }
    return outputArray;
  };

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
    const registerDetailsSpy = jest.spyOn(manager, "registerDeviceDetails");
    const payload = { p: LshProtocol.DEVICE_DETAILS, dn: "test-device", ai: ["A1"], bi: [] };
    simulateInput("LSH/test-device/conf", payload);
    expect(registerDetailsSpy).toHaveBeenCalledWith("test-device", payload);
  });

  describe("Network Click Handling", () => {
    it("should send an ACK when a valid new click request is received", async () => {
      await new Promise(process.nextTick);

      // Setup
      const mockDeviceConfig = {
        name: "device-sender",
        longClickButtons: [{ id: "B1", actors: [{ name: "actor1", allActuators: true, actuators: [] }], otherActors: [] }],
        superLongClickButtons: [],
      };
      (instance as any).deviceConfigMap.set("device-sender", mockDeviceConfig);
      const deviceManager = (instance as any).deviceManager;
      deviceManager.registerDeviceDetails("actor1", { p: LshProtocol.DEVICE_DETAILS, dn: "actor1", ai: ["A1"], bi: [] });
      deviceManager.updateConnectionState("actor1", "ready");
      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: false };
      const topic = "LSH/device-sender/misc";

      // Action
      simulateInput(topic, payload);

      // Verify
      expect(mockNode.send).toHaveBeenCalledTimes(2);
      expect(mockNode.send).toHaveBeenCalledWith(
        createExpectedOutput({
          [Output.Lsh]: { topic: "LSH/device-sender/IN", payload: { p: "d_nca", bi: "B1", ct: "lc" } },
        })
      );
      expect(mockNode.send).toHaveBeenCalledWith(
        createExpectedOutput({
          [Output.Debug]: { topic, payload },
        })
      );
    });

    it("should execute click logic when a valid confirmation is received", async () => {
      await new Promise(process.nextTick);

      const managerInstance = MockedClickManager.mock.instances[0];
      const mockTransaction = { actors: [{ name: "actor1", allActuators: true, actuators: [] }], otherActors: [] };
      (managerInstance.consumeTransaction as jest.Mock).mockReturnValue(mockTransaction);

      const deviceManager = (instance as any).deviceManager;
      deviceManager.registerDeviceDetails("actor1", { p: LshProtocol.DEVICE_DETAILS, dn: "actor1", ai: ["A1"], bi: [] });
      deviceManager.registerActuatorStates("actor1", [false]);
      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: true };
      const topic = "LSH/device-sender/misc";

      // Action
      simulateInput(topic, payload);

      // Verify
      expect(managerInstance.consumeTransaction).toHaveBeenCalledWith("device-sender.B1.lc");
      expect(mockNode.send).toHaveBeenCalledTimes(2);
      expect(mockNode.send).toHaveBeenCalledWith(
        createExpectedOutput({
          [Output.Lsh]: { topic: "LSH/actor1/IN", payload: { p: "c_aas", as: [true] } },
        })
      );
      expect(mockNode.send).toHaveBeenCalledWith(
        createExpectedOutput({
          [Output.Debug]: { topic, payload },
        })
      );
    });

    it("should warn if a confirmation for an unknown transaction is received", async () => {
      await new Promise(process.nextTick);

      const managerInstance = MockedClickManager.mock.instances[0];
      (managerInstance.consumeTransaction as jest.Mock).mockReturnValue(null);
      const payload = { p: "c_nc", bi: "B1", ct: "lc", c: true };
      const topic = "LSH/device-sender/misc";

      // Action
      simulateInput(topic, payload);

      // Verify
      expect(mockNode.warn).toHaveBeenCalledWith(expect.stringContaining("expired or unknown click"));
      expect(mockNode.send).toHaveBeenCalledTimes(1);
      expect(mockNode.send).toHaveBeenCalledWith(
        createExpectedOutput({
          [Output.Debug]: { topic, payload },
        })
      );
    });
  });
});