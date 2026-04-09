import { Node, NodeAPI } from "node-red";
import { LshLogicNodeDef } from "../../types";

type MockContextStore = {
  get: jest.Mock;
  set: jest.Mock;
};

export type MockNodeInstance = jest.Mocked<
  Pick<Node, "on" | "send" | "log" | "warn" | "error" | "status" | "context">
> & {
  id: string;
  type: string;
  z: string;
  name: string;
  __context: {
    flow: MockContextStore;
    global: MockContextStore;
  };
};

export const defaultNodeConfig: LshLogicNodeDef = {
  id: "test-node-id",
  type: "lsh-logic",
  name: "Test LSH Logic",
  z: "flow-id",
  homieBasePath: "homie/",
  lshBasePath: "LSH/",
  serviceTopic: "LSH/Node-RED/SRV",
  otherDevicesPrefix: "other_devices",
  otherActorsContext: "global",
  systemConfigPath: "configs/fake.json",
  clickTimeout: 15,
  clickCleanupInterval: 30,
  watchdogInterval: 120,
  interrogateThreshold: 3,
  pingTimeout: 15,
  initialStateTimeout: 1,
  exposeStateContext: "none",
  exposeStateKey: "lsh_state",
  exportTopics: "none",
  exportTopicsKey: "lsh_topics",
  exposeConfigContext: "none",
  exposeConfigKey: "lsh_config",
  protocol: "json",
  haDiscovery: false,
  haDiscoveryPrefix: "homeassistant",
};

export function createMockNode(): MockNodeInstance {
  const flow = { get: jest.fn(), set: jest.fn() };
  const global = { get: jest.fn(), set: jest.fn() };

  return {
    id: "test-node-id",
    type: "lsh-logic",
    z: "flow-id",
    name: "Test LSH Logic",
    on: jest.fn(),
    send: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    status: jest.fn(),
    context: jest.fn().mockReturnValue({ flow, global }),
    __context: { flow, global },
  };
}

export function createMockRed(userDir = process.cwd()): NodeAPI {
  return {
    nodes: { createNode: jest.fn(), registerType: jest.fn() },
    settings: { userDir },
  } as unknown as NodeAPI;
}

export function getRegisteredHandler<THandler>(
  node: MockNodeInstance,
  eventName: string
): THandler {
  const registration = node.on.mock.calls.find(([event]) => event === eventName);
  if (!registration) {
    throw new Error(`Missing handler registration for '${eventName}'.`);
  }
  return registration[1] as THandler;
}

export async function flushMicrotasks(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
