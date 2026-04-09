import * as chokidar from "chokidar";
import * as fs from "fs/promises";
import { ValidateFunction } from "ajv";
import { Node, NodeAPI, NodeMessage } from "node-red";
import { LshLogicNode } from "../../lsh-logic";
import { LshLogicNodeDef, ServiceResult } from "../../types";
import {
  createMockNode,
  createMockRed,
  defaultNodeConfig,
  flushMicrotasks,
  getRegisteredHandler,
  MockNodeInstance,
} from "./nodeRedTestUtils";
import { createMockValidator } from "./serviceTestUtils";

export type MockWatcher = {
  on: jest.Mock;
  close: jest.Mock<Promise<void>, []>;
};

export type AdapterHarness = {
  mockNodeInstance: MockNodeInstance;
  mockRED: NodeAPI;
  mockWatcher: MockWatcher;
  initializeNode: (config?: LshLogicNodeDef, red?: NodeAPI) => Promise<LshLogicNode>;
  cleanupNode: () => Promise<void>;
};

export type InputHandler = (
  msg: NodeMessage,
  send: (msg: NodeMessage) => void,
  done: (err?: Error) => void
) => unknown;

export type CloseHandler = (done: () => void) => unknown;

export const MOCK_CONFIG_CONTENT = JSON.stringify({
  devices: [{ name: "test-device" }],
});

export const warmupNodeConfig = {
  ...defaultNodeConfig,
  initialStateTimeout: 10,
  pingTimeout: 15,
};

export const createMockWatcher = (): MockWatcher => ({
  on: jest.fn().mockReturnThis(),
  close: jest.fn().mockResolvedValue(undefined),
});

export const createAdapterHarness = (): AdapterHarness => {
  const mockWatcher = createMockWatcher();
  jest.mocked(chokidar.watch).mockReturnValue(
    mockWatcher as unknown as ReturnType<typeof chokidar.watch>
  );

  jest.mocked(fs.readFile).mockResolvedValue(MOCK_CONFIG_CONTENT);

  const mockNodeInstance = createMockNode();
  const mockRED = createMockRed();
  let nodeInstance: LshLogicNode | undefined;

  return {
    mockNodeInstance,
    mockRED,
    mockWatcher,
    initializeNode: async (config = defaultNodeConfig, red = mockRED) => {
      nodeInstance = new LshLogicNode(
        mockNodeInstance as unknown as Node,
        config,
        red
      );
      await waitForInitialization();
      return nodeInstance;
    },
    cleanupNode: async () => {
      if (nodeInstance) {
        await nodeInstance._cleanupResources();
      }
    },
  };
};

export const createValidator = (
  isValid = true
): jest.Mock & ValidateFunction => {
  const validator = createMockValidator() as jest.Mock & ValidateFunction;
  validator.mockReturnValue(isValid);
  return validator;
};

export const createServiceResult = (
  overrides: Partial<ServiceResult> = {}
): ServiceResult => ({
  messages: {},
  logs: [],
  warnings: [],
  errors: [],
  stateChanged: false,
  ...overrides,
});

export const waitForInitialization = async (): Promise<void> => {
  await flushMicrotasks(6);
};

export const getInputHandler = (
  node: MockNodeInstance
): InputHandler => getRegisteredHandler<InputHandler>(node, "input");

export const getCloseHandler = (
  node: MockNodeInstance
): CloseHandler => getRegisteredHandler<CloseHandler>(node, "close");
