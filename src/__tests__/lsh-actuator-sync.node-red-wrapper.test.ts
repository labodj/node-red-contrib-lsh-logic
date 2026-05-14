import type { Node, NodeAPI, NodeMessage } from "node-red";

import { createMockNode, createMockRed, getRegisteredHandler } from "./helpers/nodeRedTestUtils";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";

type InputHandler = (
  msg: NodeMessage,
  send: (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void,
  done: (err?: Error) => void,
) => void;
type NodeRedRegister = (RED: NodeAPI) => void;
type SyncConfig = {
  id: string;
  type: string;
  name: string;
  z: string;
  stateContext: "flow" | "global";
  stateKey: string;
  configContext: "flow" | "global";
  configKey: string;
  desiredStateProperty: string;
  deviceIdProperty: string;
  actuatorIdProperty: string;
  qos: string | number;
  allowedDirection?: "both" | "on-only" | "off-only";
  ignoreRetained: boolean | string;
  requireKnownState: boolean | string;
  commandCooldownMs: number | string;
  stateWaitTimeoutMs?: number | string;
};
type NodeRedWrapper = (this: Node, config: SyncConfig) => void;

const defaultSyncConfig: SyncConfig = {
  id: "sync-node-id",
  type: "lsh-actuator-sync",
  name: "Test LSH Actuator Sync",
  z: "flow-id",
  stateContext: "global",
  stateKey: "lsh_state",
  configContext: "global",
  configKey: "lsh_config",
  desiredStateProperty: "payload.ison",
  deviceIdProperty: "deviceId",
  actuatorIdProperty: "actuatorId",
  qos: "2",
  allowedDirection: "both",
  ignoreRetained: true,
  requireKnownState: true,
  commandCooldownMs: 0,
  stateWaitTimeoutMs: 5000,
};

const defaultStateExport = {
  devices: {
    j1: {
      lastStateTime: 100,
      actuatorIndexes: { 7: 0 },
      actuatorStates: [false],
    },
    j2: {
      lastStateTime: 100,
      actuatorIndexes: { 10: 0 },
      actuatorStates: [true],
    },
  },
};

const defaultConfigExport = {
  homieBasePath: "homie/5/",
};

const registerSyncNode = (node: MockNodeInstance, config: SyncConfig = defaultSyncConfig): void => {
  const register: NodeRedRegister = jest.requireActual("../lsh-actuator-sync");
  const red = createMockRed();

  register(red);

  expect(red.nodes.registerType).toHaveBeenCalledWith("lsh-actuator-sync", expect.any(Function));
  const wrapper = (red.nodes.registerType as jest.Mock).mock.calls[0][1] as NodeRedWrapper;
  wrapper.call(node as unknown as Node, config);
};

const setContextExports = (
  node: MockNodeInstance,
  {
    state = defaultStateExport,
    config = defaultConfigExport,
    context = "global",
  }: { state?: unknown; config?: unknown; context?: "flow" | "global" } = {},
): void => {
  node.__context[context].get.mockImplementation((key: string) => {
    if (key === "lsh_state") {
      return state;
    }
    if (key === "lsh_config") {
      return config;
    }
    return undefined;
  });
};

const sendInput = (node: MockNodeInstance, msg: NodeMessage): jest.Mock => {
  const handler = getRegisteredHandler<InputHandler>(node, "input");
  const send = jest.fn();
  const done = jest.fn();

  handler(msg, send, done);

  expect(done).toHaveBeenCalledWith();
  return send;
};

const expectInvalidConfig = (config: SyncConfig, message: string): void => {
  const node = createMockNode();
  registerSyncNode(node, config);

  expect(node.error).toHaveBeenCalledWith(`Invalid node configuration: ${message}`);
  expect(node.status).toHaveBeenCalledWith({
    fill: "red",
    shape: "ring",
    text: "Node Config Error",
  });
};

describe("LshActuatorSyncNode wrapper", () => {
  it("emits an LSH Homie state/set command when downstream state differs", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node);

    const send = sendInput(node, {
      topic: "shellies/camera/white/0/status",
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).toHaveBeenCalledWith({
      topic: "homie/5/j1/7/state/set",
      payload: true,
      qos: 2,
      retain: false,
      lshSync: {
        deviceId: "j1",
        actuatorId: "7",
        desiredState: true,
        previousState: false,
        sourceTopic: "shellies/camera/white/0/status",
      },
    });
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "green",
      shape: "dot",
      text: "j1/7 -> on",
    });
  });

  it("uses per-message targets so one helper can handle several downstream devices", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node);

    const firstSend = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: 7,
    });
    const secondSend = sendInput(node, {
      payload: { ison: false },
      deviceId: "j2",
      actuatorId: 10,
    });

    expect(firstSend).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "homie/5/j1/7/state/set", payload: true }),
    );
    expect(secondSend).toHaveBeenCalledWith(
      expect.objectContaining({ topic: "homie/5/j2/10/state/set", payload: false }),
    );
  });

  it("skips output when the exported LSH actuator state is already aligned", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node);

    const send = sendInput(node, {
      payload: { ison: false },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "blue",
      shape: "dot",
      text: "j1/7 already off",
    });
  });

  it("ignores retained external-state messages by default", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node);

    const send = sendInput(node, {
      retain: true,
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "grey",
      shape: "ring",
      text: "Retained ignored",
    });
  });

  it("can publish without known LSH state when explicitly configured to do so", () => {
    const node = createMockNode();
    setContextExports(node, { state: { devices: {} } });
    registerSyncNode(node, {
      ...defaultSyncConfig,
      requireKnownState: false,
    });

    const send = sendInput(node, {
      payload: { ison: true },
      deviceId: "j9",
      actuatorId: "3",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "homie/5/j9/3/state/set",
        payload: true,
        lshSync: expect.objectContaining({
          previousState: undefined,
        }),
      }),
    );
  });

  it("does not treat stale exported state as aligned when known state is optional", () => {
    const node = createMockNode();
    setContextExports(node, {
      state: {
        devices: {
          j1: {
            lastStateTime: 0,
            actuatorIndexes: { 7: 0 },
            actuatorStates: [true],
          },
        },
      },
    });
    registerSyncNode(node, {
      ...defaultSyncConfig,
      requireKnownState: false,
    });

    const send = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "homie/5/j1/7/state/set",
        payload: true,
        lshSync: expect.objectContaining({ previousState: undefined }),
      }),
    );
  });

  it("normalizes common external state strings and config string values", () => {
    const node = createMockNode();
    setContextExports(node, { state: { devices: {} }, context: "flow" });
    registerSyncNode(node, {
      ...defaultSyncConfig,
      stateContext: "flow",
      configContext: "flow",
      qos: 1,
      ignoreRetained: "false",
      requireKnownState: "false",
      commandCooldownMs: "0",
    });

    const send = sendInput(node, {
      retain: true,
      payload: { ison: "ON" },
      deviceId: "j9",
      actuatorId: "3",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "homie/5/j9/3/state/set",
        payload: true,
        qos: 1,
      }),
    );
  });

  it("normalizes numeric off state values", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node, {
      ...defaultSyncConfig,
      desiredStateProperty: "payload",
    });

    const send = sendInput(node, {
      payload: 0,
      deviceId: "j2",
      actuatorId: "10",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "homie/5/j2/10/state/set",
        payload: false,
        lshSync: expect.objectContaining({ previousState: true }),
      }),
    );
  });

  it("can ignore ON states for downstream devices that should only sync OFF", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node, {
      ...defaultSyncConfig,
      allowedDirection: "off-only",
    });

    const send = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "grey",
      shape: "ring",
      text: "j1/7 on ignored",
    });
  });

  it("still allows OFF states when direction is OFF only", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node, {
      ...defaultSyncConfig,
      allowedDirection: "off-only",
    });

    const send = sendInput(node, {
      payload: { ison: false },
      deviceId: "j2",
      actuatorId: "10",
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "homie/5/j2/10/state/set",
        payload: false,
      }),
    );
  });

  it("can ignore OFF states for flows that should only sync ON", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node, {
      ...defaultSyncConfig,
      allowedDirection: "on-only",
    });

    const send = sendInput(node, {
      payload: { ison: false },
      deviceId: "j2",
      actuatorId: "10",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "grey",
      shape: "ring",
      text: "j2/10 off ignored",
    });
  });

  it("skips malformed input messages without throwing", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node);

    const invalidStateSend = sendInput(node, {
      payload: { ison: "maybe" },
      deviceId: "j1",
      actuatorId: "7",
    });
    const missingTargetSend = sendInput(node, {
      payload: { ison: true },
      deviceId: "",
    });

    expect(invalidStateSend).not.toHaveBeenCalled();
    expect(missingTargetSend).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith(
      "Desired state must be boolean, 1/0, true/false, on/off or yes/no.",
    );
    expect(node.warn).toHaveBeenCalledWith(
      "Message must include target LSH deviceId and actuatorId.",
    );
  });

  it("skips commands when known LSH state is required but unavailable", () => {
    const node = createMockNode();
    setContextExports(node, {
      state: {
        devices: {
          j1: {
            lastStateTime: 0,
            actuatorIndexes: { 7: 0 },
            actuatorStates: [false],
          },
        },
      },
    });
    registerSyncNode(node, {
      ...defaultSyncConfig,
      stateWaitTimeoutMs: 0,
    });

    const send = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith("No authoritative LSH state for j1/7.");
  });

  it("defers startup messages until LSH state becomes authoritative", () => {
    jest.useFakeTimers();
    try {
      const node = createMockNode();
      let state = {
        devices: {
          j1: {
            lastStateTime: 0,
            actuatorIndexes: { 7: 0 },
            actuatorStates: [false],
          },
        },
      };
      node.__context.global.get.mockImplementation((key: string) => {
        if (key === "lsh_state") {
          return state;
        }
        if (key === "lsh_config") {
          return defaultConfigExport;
        }
        return undefined;
      });
      registerSyncNode(node);

      const send = sendInput(node, {
        payload: { ison: true },
        deviceId: "j1",
        actuatorId: "7",
      });

      expect(send).not.toHaveBeenCalled();
      expect(node.status).toHaveBeenLastCalledWith({
        fill: "blue",
        shape: "ring",
        text: "j1/7 waiting LSH",
      });

      state = {
        devices: {
          j1: {
            lastStateTime: 100,
            actuatorIndexes: { 7: 0 },
            actuatorStates: [false],
          },
        },
      };
      jest.advanceTimersByTime(250);

      expect(node.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "homie/5/j1/7/state/set",
          payload: true,
          lshSync: expect.objectContaining({ previousState: false }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("applies per-actuator cooldowns", () => {
    const node = createMockNode();
    setContextExports(node);
    registerSyncNode(node, {
      ...defaultSyncConfig,
      commandCooldownMs: 1000,
    });

    const firstSend = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });
    const secondSend = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(firstSend).toHaveBeenCalled();
    expect(secondSend).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "yellow",
      shape: "ring",
      text: "j1/7 cooldown",
    });
  });

  it("reports missing context exports without sending a command", () => {
    const node = createMockNode();
    setContextExports(node, { config: null });
    registerSyncNode(node, {
      ...defaultSyncConfig,
      stateWaitTimeoutMs: 0,
    });

    const send = sendInput(node, {
      payload: { ison: true },
      deviceId: "j1",
      actuatorId: "7",
    });

    expect(send).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith("Effective LSH config export is missing or invalid.");
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "yellow",
      shape: "ring",
      text: "Missing config",
    });
  });

  it("reports synchronous configuration errors during Node-RED registration", () => {
    expectInvalidConfig(
      {
        ...defaultSyncConfig,
        stateKey: " ",
      },
      "State Context Key cannot be empty.",
    );
    expectInvalidConfig(
      {
        ...defaultSyncConfig,
        stateContext: "node" as "flow",
      },
      "State Context must be flow or global.",
    );
    expectInvalidConfig(
      {
        ...defaultSyncConfig,
        qos: "3",
      },
      "Command QoS must be 0, 1 or 2.",
    );
    expectInvalidConfig(
      {
        ...defaultSyncConfig,
        commandCooldownMs: "-1",
      },
      "Command Cooldown must be a non-negative number.",
    );
    expectInvalidConfig(
      {
        ...defaultSyncConfig,
        allowedDirection: "bad" as "both",
      },
      "Allowed Direction must be both, on-only or off-only.",
    );
  });
});
