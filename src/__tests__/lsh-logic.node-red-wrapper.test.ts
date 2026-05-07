import { ClickType, LSH_WIRE_PROTOCOL_MAJOR, LshProtocol } from "labo-smart-home-coordinator";
import type { SystemConfig } from "labo-smart-home-coordinator";

import { LshLogicNode } from "../lsh-logic";
import { normalizeNodeConfig } from "../lsh-logic.config";
import { NodeOutput } from "../types";
import {
  createMockNode,
  createMockRed,
  defaultNodeConfig,
  getRegisteredHandler,
} from "./helpers/nodeRedTestUtils";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";
import type { Node, NodeAPI, NodeMessage } from "node-red";
import type { LshLogicNodeDef } from "../types";

type InputHandler = (msg: NodeMessage, send: unknown, done: (err?: Error) => void) => void;
type CloseHandler = (done: () => void) => void;
type NodeRedRegister = ((RED: NodeAPI) => void) & {
  Output: { Lsh: NodeOutput };
};
type NodeRedWrapper = (this: Node, config: LshLogicNodeDef) => void;

const sendInput = async (node: MockNodeInstance, msg: NodeMessage): Promise<void> => {
  const handler = getRegisteredHandler<InputHandler>(node, "input");
  await new Promise<void>((resolve, reject) => {
    handler(msg, jest.fn(), (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const getOutputFrames = (node: MockNodeInstance, output: NodeOutput): NodeMessage[] =>
  node.send.mock.calls.flatMap(([outputs]) => {
    const outputArray = outputs as unknown as Array<NodeMessage | NodeMessage[] | null>;
    const value = outputArray[output];
    if (!value) {
      return [];
    }
    return Array.isArray(value) ? value : [value];
  });

const activeInstances: LshLogicNode[] = [];

const createInstance = (node: MockNodeInstance, config = defaultNodeConfig): LshLogicNode => {
  const instance = new LshLogicNode(node as unknown as Node, config);
  activeInstances.push(instance);
  return instance;
};

describe("LshLogicNode wrapper", () => {
  afterEach(async () => {
    await Promise.allSettled(
      activeInstances.splice(0).map(async (instance) => {
        await instance.getCoordinator().stop();
      }),
    );
  });

  it("starts the standalone coordinator and emits Node-RED subscription control messages", async () => {
    const node = createMockNode();
    const instance = createInstance(node, {
      ...defaultNodeConfig,
      exposeConfigContext: "global",
      exposeStateContext: "global",
      exportTopics: "flow",
    });

    await instance.flush();

    expect(node.status).toHaveBeenLastCalledWith({
      fill: "green",
      shape: "dot",
      text: expect.stringMatching(/^Ready d:2 b:\d\/2 c:\d\/2$/),
    });
    expect(getOutputFrames(node, NodeOutput.Configuration)).toEqual(
      expect.arrayContaining([
        {
          action: "subscribe",
          qos: 1,
          topic: ["homie/5/source/$state", "homie/5/target/$state"],
        },
        {
          action: "subscribe",
          qos: 2,
          topic: [
            "LSH/source/bridge",
            "LSH/source/conf",
            "LSH/source/events",
            "LSH/source/state",
            "LSH/target/bridge",
            "LSH/target/conf",
            "LSH/target/events",
            "LSH/target/state",
          ],
        },
      ]),
    );
    expect(node.__context.flow.set).toHaveBeenCalledWith(
      "lsh_topics",
      expect.objectContaining({
        all: expect.arrayContaining(["LSH/source/conf", "homie/5/source/$state"]),
      }),
    );
    expect(node.__context.global.set).toHaveBeenCalledWith(
      "lsh_config",
      expect.objectContaining({ devices: expect.any(Array) }),
    );
    expect(node.__context.global.set).toHaveBeenCalledWith(
      "lsh_state",
      expect.objectContaining({ devices: expect.any(Object), lastUpdated: expect.any(Number) }),
    );
  });

  it("accepts mqtt-in auto-detected payloads and routes coordinator outputs", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();

    await sendInput(node, {
      topic: "LSH/source/conf",
      payload: {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "source",
        a: [1],
        b: [1],
      },
    });
    await sendInput(node, {
      topic: "LSH/source/state",
      payload: Buffer.from(JSON.stringify({ p: LshProtocol.ACTUATORS_STATE, s: [0] })),
    });
    await sendInput(node, {
      topic: "homie/5/source/$state",
      payload: "ready",
    });
    await sendInput(node, {
      topic: "LSH/target/conf",
      payload: {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "target",
        a: [1],
        b: [],
      },
    });
    await sendInput(node, {
      topic: "LSH/target/state",
      payload: { p: LshProtocol.ACTUATORS_STATE, s: [0] },
    });
    await sendInput(node, {
      topic: "homie/5/target/$state",
      payload: "ready",
    });
    await sendInput(node, {
      topic: "LSH/source/events",
      payload: {
        p: LshProtocol.NETWORK_CLICK_REQUEST,
        c: 10,
        i: 1,
        t: ClickType.Long,
      },
    });
    await sendInput(node, {
      topic: "LSH/source/events",
      payload: {
        p: LshProtocol.NETWORK_CLICK_CONFIRM,
        c: 10,
        i: 1,
        t: ClickType.Long,
      },
    });
    await instance.flush();

    expect(getOutputFrames(node, NodeOutput.LshCommands)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          topic: "LSH/source/IN",
          payload: {
            p: LshProtocol.NETWORK_CLICK_ACK,
            c: 10,
            i: 1,
            t: ClickType.Long,
          },
        }),
        expect.objectContaining({
          topic: "LSH/target/IN",
          payload: { p: LshProtocol.SET_STATE, s: [1] },
        }),
      ]),
    );
    expect(getOutputFrames(node, NodeOutput.Debug)).toEqual(
      expect.arrayContaining([expect.objectContaining({ topic: "LSH/source/events" })]),
    );
  });

  it("maps coordinator semantic events to the expected Node-RED outputs", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();

    instance.getCoordinator().emit("otherActors", {
      otherActors: ["zigbee_table_lamp"],
      stateToSet: true,
    });
    instance.getCoordinator().emit("alert", {
      message: "source is offline",
      status: "unhealthy",
      event_type: "device_unreachable",
      event_source: "watchdog",
      devices: [{ name: "source", reason: "timeout" }],
    });

    expect(getOutputFrames(node, NodeOutput.OtherActorCommands)).toContainEqual({
      payload: { otherActors: ["zigbee_table_lamp"], stateToSet: true },
    });
    expect(getOutputFrames(node, NodeOutput.Alerts)).toContainEqual({
      payload: expect.objectContaining({ message: "source is offline" }),
    });
  });

  it("keeps Node-RED status compact while registry health changes", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();

    instance.getCoordinator().emit("state", {
      lastUpdated: Date.now(),
      devices: {
        source: {
          name: "source",
          connected: true,
          controllerLinkConnected: true,
          isHealthy: true,
          isStale: false,
          lastSeenTime: 1,
          bridgeConnected: true,
          bridgeLastSeenTime: 1,
          lastHomieState: "ready",
          lastHomieStateTime: 1,
          lastDetailsTime: 1,
          lastStateTime: 1,
          actuatorsIDs: [1],
          buttonsIDs: [1],
          actuatorStates: [false],
          actuatorIndexes: { 1: 0 },
          alertSent: false,
        },
        target: {
          name: "target",
          connected: false,
          controllerLinkConnected: false,
          isHealthy: false,
          isStale: true,
          lastSeenTime: 0,
          bridgeConnected: true,
          bridgeLastSeenTime: 1,
          lastHomieState: "ready",
          lastHomieStateTime: 1,
          lastDetailsTime: 0,
          lastStateTime: 0,
          actuatorsIDs: [],
          buttonsIDs: [],
          actuatorStates: [],
          actuatorIndexes: {},
          alertSent: true,
        },
      },
    });

    expect(node.status).toHaveBeenLastCalledWith({
      fill: "green",
      shape: "dot",
      text: "Ready d:2 b:2/2 c:1/2",
    });
  });

  it("fails fast on invalid inline JSON", () => {
    const node = createMockNode();

    expect(() =>
      createInstance(node, {
        ...defaultNodeConfig,
        systemConfigJson: "{ broken json",
      }),
    ).toThrow("System Config JSON is not valid JSON");
  });

  it("surfaces invalid inline system configs during startup", async () => {
    const node = createMockNode();
    const instance = createInstance(node, {
      ...defaultNodeConfig,
      systemConfigJson: "{}",
    });

    await expect(instance.flush()).rejects.toThrow("Invalid coordinator config");
    expect(node.error).toHaveBeenCalledWith(
      expect.stringContaining("Critical error during initialization"),
    );
    expect(node.status).toHaveBeenCalledWith({ fill: "red", shape: "ring", text: "Config Error" });
  });

  it("validates Node-RED-only config fields before the coordinator starts", () => {
    expect(() =>
      normalizeNodeConfig({
        ...defaultNodeConfig,
        systemConfigJson: "   ",
      }),
    ).toThrow("System Config JSON cannot be empty");

    expect(() =>
      normalizeNodeConfig({
        ...defaultNodeConfig,
        exposeStateContext: "flow",
        exposeStateKey: " ",
      }),
    ).toThrow("State Context Key cannot be empty");
  });

  it("reports inbound processing errors through Node-RED done and error APIs", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();
    jest.spyOn(instance.getCoordinator(), "processMqttMessage").mockRejectedValueOnce("bad frame");

    await expect(sendInput(node, { topic: "LSH/source/conf", payload: {} })).rejects.toThrow(
      "bad frame",
    );
    expect(node.error).toHaveBeenCalledWith("Error processing message: bad frame");
  });

  it("handles close events and ignores later input/output", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();

    const closeHandler = getRegisteredHandler<CloseHandler>(node, "close");
    await new Promise<void>((resolve) => closeHandler(resolve));

    await sendInput(node, { topic: "homie/5/source/$state", payload: "ready" });
    const sendCount = node.send.mock.calls.length;
    instance.getCoordinator().emit("mqtt", { topic: "LSH/source/IN", payload: { p: 1 } });

    expect(node.send).toHaveBeenCalledTimes(sendCount);
  });

  it("logs close errors without blocking the Node-RED close callback", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();
    jest
      .spyOn(instance.getCoordinator(), "stop")
      .mockRejectedValueOnce(new Error("synthetic close failure"));

    const closeHandler = getRegisteredHandler<CloseHandler>(node, "close");
    await new Promise<void>((resolve) => closeHandler(resolve));

    expect(node.error).toHaveBeenCalledWith("Error during node close: synthetic close failure");
  });

  it("skips duplicate subscription output when the effective config is unchanged", async () => {
    const node = createMockNode();
    const instance = createInstance(node);
    await instance.flush();
    const sendCount = getOutputFrames(node, NodeOutput.Configuration).length;

    const systemConfig = JSON.parse(defaultNodeConfig.systemConfigJson) as SystemConfig;
    instance.getCoordinator().emit("config", systemConfig);

    expect(getOutputFrames(node, NodeOutput.Configuration)).toHaveLength(sendCount);
    expect(node.debug).toHaveBeenCalledWith(
      "MQTT topic set unchanged. Skipping runtime subscription reconfiguration.",
    );
  });

  it("registers the Node-RED type and reports synchronous config errors", () => {
    const register: NodeRedRegister = jest.requireActual("../lsh-logic");
    const red = createMockRed();
    const node = createMockNode();

    register(red);

    expect(red.nodes.registerType).toHaveBeenCalledWith("lsh-logic", expect.any(Function));
    expect(register.Output.Lsh).toBe(NodeOutput.LshCommands);

    const wrapper = (red.nodes.registerType as jest.Mock).mock.calls[0][1] as NodeRedWrapper;
    wrapper.call(node as unknown as Node, {
      ...defaultNodeConfig,
      systemConfigJson: "{ broken json",
    });

    expect(red.nodes.createNode).toHaveBeenCalledWith(node, expect.any(Object));
    expect(node.error).toHaveBeenCalledWith(expect.stringContaining("Invalid node configuration"));
    expect(node.status).toHaveBeenCalledWith({
      fill: "red",
      shape: "ring",
      text: "Node Config Error",
    });
  });
});
