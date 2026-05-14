import type { Node, NodeAPI, NodeMessage } from "node-red";

import { createMockNode, createMockRed, getRegisteredHandler } from "./helpers/nodeRedTestUtils";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";

type InputHandler = (
  msg: NodeMessage,
  send: (msg: NodeMessage | Array<NodeMessage | NodeMessage[] | null>) => void,
  done: (err?: Error) => void,
) => void;
type NodeRedRegister = (RED: NodeAPI) => void;
type ExternalStateConfig = {
  id: string;
  type: string;
  name: string;
  z: string;
  storeContext: "flow" | "global";
  prefixSource: "config" | "manual";
  prefix: string;
  configContext: "flow" | "global";
  configKey: string;
  actorNameSource: "msg" | "config";
  actorName: string;
  actorNameProperty: string;
  stateProperty: string;
  trueValues: string;
  falseValues: string;
  caseSensitive: boolean | string;
  invert: boolean | string;
  acceptRetained: boolean | string;
  storeOnlyChanges: boolean | string;
  storeMetadata: boolean | string;
  configWaitTimeoutMs?: number | string;
};
type NodeRedWrapper = (this: Node, config: ExternalStateConfig) => void;

const defaultExternalStateConfig: ExternalStateConfig = {
  id: "external-state-node-id",
  type: "lsh-external-state",
  name: "Test LSH External State",
  z: "flow-id",
  storeContext: "global",
  prefixSource: "config",
  prefix: "other_devices",
  configContext: "global",
  configKey: "lsh_config",
  actorNameSource: "msg",
  actorName: "",
  actorNameProperty: "topic",
  stateProperty: "payload",
  trueValues: "1,true,on,yes,open,active",
  falseValues: "0,false,off,no,closed,inactive",
  caseSensitive: false,
  invert: false,
  acceptRetained: true,
  storeOnlyChanges: true,
  storeMetadata: true,
  configWaitTimeoutMs: 5000,
};

const registerExternalStateNode = (
  node: MockNodeInstance,
  config: ExternalStateConfig = defaultExternalStateConfig,
): void => {
  const register: NodeRedRegister = jest.requireActual("../lsh-external-state");
  const red = createMockRed();

  register(red);

  expect(red.nodes.registerType).toHaveBeenCalledWith("lsh-external-state", expect.any(Function));
  const wrapper = (red.nodes.registerType as jest.Mock).mock.calls[0][1] as NodeRedWrapper;
  wrapper.call(node as unknown as Node, config);
};

const useContextMap = (
  node: MockNodeInstance,
  contextName: "flow" | "global",
  initialValues: Record<string, unknown> = {},
): Map<string, unknown> => {
  const values = new Map(Object.entries(initialValues));
  const context = node.__context[contextName];
  context.get.mockImplementation((key: string) => values.get(key));
  context.set.mockImplementation((key: string, value: unknown) => {
    values.set(key, value);
  });
  return values;
};

const sendInput = (node: MockNodeInstance, msg: NodeMessage): jest.Mock => {
  const handler = getRegisteredHandler<InputHandler>(node, "input");
  const send = jest.fn();
  const done = jest.fn();

  handler(msg, send, done);

  expect(done).toHaveBeenCalledWith();
  return send;
};

const expectInvalidConfig = (config: ExternalStateConfig, message: string): void => {
  const node = createMockNode();
  registerExternalStateNode(node, config);

  expect(node.error).toHaveBeenCalledWith(`Invalid node configuration: ${message}`);
  expect(node.status).toHaveBeenCalledWith({
    fill: "red",
    shape: "ring",
    text: "Node Config Error",
  });
};

describe("LshExternalStateNode wrapper", () => {
  it("stores retained external state using the exported lsh_config prefix", () => {
    const node = createMockNode();
    const values = useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
    });
    registerExternalStateNode(node);

    const send = sendInput(node, {
      topic: "xiaomiBagno",
      payload: "ON",
      retain: true,
    });

    expect(values.get("other_devices.xiaomiBagno.state")).toBe(true);
    expect(values.get("other_devices.xiaomiBagno.sourceTopic")).toBe("xiaomiBagno");
    expect(values.get("other_devices.xiaomiBagno.rawState")).toBe("ON");
    expect(values.get("other_devices.xiaomiBagno.retain")).toBe(true);
    expect(values.get("other_devices.xiaomiBagno.updatedAt")).toEqual(expect.any(Number));
    expect(send).toHaveBeenCalledWith({
      topic: "xiaomiBagno",
      payload: true,
      lshExternalState: {
        actorName: "xiaomiBagno",
        state: true,
        previousState: undefined,
        context: "global",
        key: "other_devices.xiaomiBagno.state",
        prefix: "other_devices",
        sourceTopic: "xiaomiBagno",
        retained: true,
        rawState: "ON",
        storedAt: expect.any(Number),
      },
    });
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "green",
      shape: "dot",
      text: "xiaomiBagno: on",
    });
  });

  it("supports fixed actors, manual prefixes and nested state properties", () => {
    const node = createMockNode();
    const values = useContextMap(node, "flow");
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      storeContext: "flow",
      prefixSource: "manual",
      prefix: "external",
      actorNameSource: "config",
      actorName: "shellyKitchen",
      stateProperty: "payload.ison",
      storeMetadata: false,
    });

    const send = sendInput(node, {
      topic: "shellies/kitchen/white/0/status",
      payload: { ison: false },
    });

    expect(values.get("external.shellyKitchen.state")).toBe(false);
    expect(values.has("external.shellyKitchen.updatedAt")).toBe(false);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "shellyKitchen",
        payload: false,
        lshExternalState: expect.objectContaining({
          key: "external.shellyKitchen.state",
          sourceTopic: "shellies/kitchen/white/0/status",
        }),
      }),
    );
  });

  it("normalizes common text, numeric and custom states without turning invalid values false", () => {
    const node = createMockNode();
    const values = useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
    });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      trueValues: "enabled,available,open",
      falseValues: "disabled,unavailable,closed",
      storeOnlyChanges: false,
    });

    sendInput(node, { topic: "numeric", payload: 1 });
    sendInput(node, { topic: "openState", payload: "open" });
    sendInput(node, { topic: "custom", payload: "available" });
    const invalidSend = sendInput(node, { topic: "bad", payload: "maybe" });

    expect(values.get("other_devices.numeric.state")).toBe(true);
    expect(values.get("other_devices.openState.state")).toBe(true);
    expect(values.get("other_devices.custom.state")).toBe(true);
    expect(values.has("other_devices.bad.state")).toBe(false);
    expect(invalidSend).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenLastCalledWith(
      "State property 'payload' must be boolean, 1/0, or one of the configured true/false text values.",
    );
  });

  it("can invert normalized values", () => {
    const node = createMockNode();
    const values = useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
    });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      invert: true,
    });

    sendInput(node, { topic: "invertedRelay", payload: "ON" });

    expect(values.get("other_devices.invertedRelay.state")).toBe(false);
  });

  it("supports case-sensitive string parsing and numeric false values", () => {
    const node = createMockNode();
    const values = useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
    });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      trueValues: "ON",
      falseValues: "OFF",
      caseSensitive: "true",
      storeOnlyChanges: false,
    });

    sendInput(node, { topic: "strictOff", payload: "OFF" });
    sendInput(node, { topic: "numericOff", payload: 0 });
    const lowerCaseSend = sendInput(node, { topic: "strictLower", payload: "off" });

    expect(values.get("other_devices.strictOff.state")).toBe(false);
    expect(values.get("other_devices.numericOff.state")).toBe(false);
    expect(values.has("other_devices.strictLower.state")).toBe(false);
    expect(lowerCaseSend).not.toHaveBeenCalled();
  });

  it("drops messages without an actor name or valid state", () => {
    const node = createMockNode();
    useContextMap(node, "global", { lsh_config: { otherDevicesPrefix: "other_devices" } });
    registerExternalStateNode(node);

    const missingActorSend = sendInput(node, { payload: true });
    const invalidStateSend = sendInput(node, { topic: "lamp", payload: { state: "ON" } });

    expect(missingActorSend).not.toHaveBeenCalled();
    expect(invalidStateSend).not.toHaveBeenCalled();
    expect(node.__context.global.set).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith("Message must include a non-empty external actor name.");
    expect(node.warn).toHaveBeenCalledWith(
      "State property 'payload' must be boolean, 1/0, or one of the configured true/false text values.",
    );
  });

  it("skips duplicate writes by default", () => {
    const node = createMockNode();
    useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
      "other_devices.lamp.state": true,
    });
    registerExternalStateNode(node);

    const send = sendInput(node, { topic: "lamp", payload: true });

    expect(send).not.toHaveBeenCalled();
    expect(node.__context.global.set).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "blue",
      shape: "dot",
      text: "lamp already on",
    });
  });

  it("can store duplicate states when metadata refresh is desired", () => {
    const node = createMockNode();
    const values = useContextMap(node, "global", {
      lsh_config: { otherDevicesPrefix: "other_devices" },
      "other_devices.lamp.state": true,
    });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      storeOnlyChanges: false,
    });

    const send = sendInput(node, { topic: "lamp", payload: true });

    expect(values.get("other_devices.lamp.state")).toBe(true);
    expect(values.get("other_devices.lamp.updatedAt")).toEqual(expect.any(Number));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        lshExternalState: expect.objectContaining({ previousState: true }),
      }),
    );
  });

  it("can reject retained messages for integrations whose retained state is unsafe", () => {
    const node = createMockNode();
    useContextMap(node, "global", { lsh_config: { otherDevicesPrefix: "other_devices" } });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      acceptRetained: false,
    });

    const send = sendInput(node, { topic: "lamp", payload: "OFF", retain: true });

    expect(send).not.toHaveBeenCalled();
    expect(node.__context.global.set).not.toHaveBeenCalled();
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "grey",
      shape: "ring",
      text: "Retained ignored",
    });
  });

  it("defers startup messages until the exported config prefix is available", () => {
    jest.useFakeTimers();
    try {
      const node = createMockNode();
      const values = useContextMap(node, "global");
      registerExternalStateNode(node);

      const send = sendInput(node, { topic: "lamp", payload: "ON", retain: true });

      expect(send).not.toHaveBeenCalled();
      expect(node.status).toHaveBeenLastCalledWith({
        fill: "blue",
        shape: "ring",
        text: "lamp waiting config",
      });

      values.set("lsh_config", { otherDevicesPrefix: "other_devices" });
      jest.advanceTimersByTime(250);

      expect(values.get("other_devices.lamp.state")).toBe(true);
      expect(node.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "lamp",
          payload: true,
          lshExternalState: expect.objectContaining({
            key: "other_devices.lamp.state",
            retained: true,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("reports config readiness failures when waiting is disabled", () => {
    const node = createMockNode();
    useContextMap(node, "global");
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      configWaitTimeoutMs: 0,
    });

    const send = sendInput(node, { topic: "lamp", payload: true });

    expect(send).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith(
      "Effective LSH config export is missing or does not include otherDevicesPrefix.",
    );
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "yellow",
      shape: "ring",
      text: "Missing config",
    });
  });

  it("treats malformed exported config as missing config", () => {
    const node = createMockNode();
    useContextMap(node, "global", { lsh_config: { otherDevicesPrefix: "   " } });
    registerExternalStateNode(node, {
      ...defaultExternalStateConfig,
      configWaitTimeoutMs: 0,
    });

    const send = sendInput(node, { topic: "lamp", payload: true });

    expect(send).not.toHaveBeenCalled();
    expect(node.warn).toHaveBeenCalledWith(
      "Effective LSH config export is missing or does not include otherDevicesPrefix.",
    );
  });

  it("reports context write failures through done and node status", () => {
    const node = createMockNode();
    node.__context.global.get.mockImplementation((key: string) =>
      key === "lsh_config" ? { otherDevicesPrefix: "other_devices" } : undefined,
    );
    node.__context.global.set.mockImplementation(() => {
      throw new Error("context unavailable");
    });
    registerExternalStateNode(node);

    const handler = getRegisteredHandler<InputHandler>(node, "input");
    const send = jest.fn();
    const done = jest.fn();
    handler({ topic: "lamp", payload: true }, send, done);

    expect(send).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(node.error).toHaveBeenCalledWith(
      "Error storing external actor state: context unavailable",
      { topic: "lamp", payload: true },
    );
    expect(node.status).toHaveBeenLastCalledWith({
      fill: "red",
      shape: "ring",
      text: "Store error",
    });
  });

  it("keeps only the latest pending state while waiting for config", () => {
    jest.useFakeTimers();
    try {
      const node = createMockNode();
      const values = useContextMap(node, "global");
      registerExternalStateNode(node, {
        ...defaultExternalStateConfig,
        configWaitTimeoutMs: 1000,
      });

      sendInput(node, { topic: "lamp", payload: "ON" });
      sendInput(node, { topic: "lamp", payload: "OFF" });
      jest.advanceTimersByTime(250);
      expect(node.warn).not.toHaveBeenCalled();

      values.set("lsh_config", { otherDevicesPrefix: "other_devices" });
      jest.advanceTimersByTime(250);

      expect(values.get("other_devices.lamp.state")).toBe(false);
      expect(node.send).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: "lamp",
          payload: false,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("times out pending states when config never becomes available", () => {
    jest.useFakeTimers();
    try {
      const node = createMockNode();
      useContextMap(node, "global");
      registerExternalStateNode(node, {
        ...defaultExternalStateConfig,
        configWaitTimeoutMs: 250,
      });

      sendInput(node, { topic: "lamp", payload: "ON" });
      jest.advanceTimersByTime(250);

      expect(node.send).not.toHaveBeenCalled();
      expect(node.warn).toHaveBeenCalledWith(
        "Effective LSH config export is missing or does not include otherDevicesPrefix.",
      );
      expect(node.status).toHaveBeenLastCalledWith({
        fill: "yellow",
        shape: "ring",
        text: "Missing config",
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it("clears pending timers on close", () => {
    jest.useFakeTimers();
    try {
      const node = createMockNode();
      useContextMap(node, "global");
      registerExternalStateNode(node);

      sendInput(node, { topic: "lamp", payload: "ON" });
      const closeHandler = getRegisteredHandler<(done: () => void) => void>(node, "close");
      const done = jest.fn();
      closeHandler(done);
      jest.advanceTimersByTime(5000);

      expect(done).toHaveBeenCalledWith();
      expect(node.warn).not.toHaveBeenCalled();
      expect(node.send).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects ambiguous parser values at configuration time", () => {
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        trueValues: "on,enabled",
        falseValues: "off,enabled",
      },
      "State value 'enabled' cannot be both true and false.",
    );
  });

  it("rejects invalid configuration values early", () => {
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        storeContext: "none" as "global",
      },
      "Store Context must be flow or global.",
    );
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        prefixSource: "bad" as "config",
      },
      "Prefix Source must be config or manual.",
    );
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        actorNameSource: "bad" as "msg",
      },
      "Actor Name Source must be msg or config.",
    );
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        prefixSource: "manual",
        prefix: "   ",
      },
      "External State Prefix cannot be empty.",
    );
    expectInvalidConfig(
      {
        ...defaultExternalStateConfig,
        configWaitTimeoutMs: -1,
      },
      "Config Ready Wait must be a non-negative number.",
    );
  });
});
