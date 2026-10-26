/**
 * Portable scenarios recovered from the installation's manual MQTT harness.
 * Exercise the real wrapper and coordinator with synthetic Node-RED messages:
 * no broker address, socket, retained cleanup or physical device is involved.
 */
import {
  ClickType,
  LSH_WIRE_PROTOCOL_MAJOR,
  LshCodec,
  LshProtocol,
} from "labo-smart-home-coordinator";
import type { Node, NodeMessage } from "node-red";
import { LshLogicNode } from "../lsh-logic";
import { NodeOutput } from "../types";
import {
  createMockNode,
  defaultNodeConfig,
  getRegisteredHandler,
} from "./helpers/nodeRedTestUtils";
import type { MockNodeInstance } from "./helpers/nodeRedTestUtils";

type Input = (message: NodeMessage, send: unknown, done: (error?: Error) => void) => void;
const LSH = "tests/network-click/lsh/";
const HOMIE = "tests/network-click/homie/5/";
const codec = new LshCodec();

describe.each(["json", "msgpack"] as const)("isolated network clicks (%s)", (protocol) => {
  let node: MockNodeInstance;
  let instance: LshLogicNode;

  const input = async (topic: string, payload: unknown, retain = false): Promise<void> => {
    const handler = getRegisteredHandler<Input>(node, "input");
    await new Promise<void>((resolve, reject) => {
      handler({ topic, payload, retain }, jest.fn(), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    await instance.flush();
  };

  const send = (device: string, suffix: string, payload: unknown, retain = false): Promise<void> =>
    input(`${LSH}${device}/${suffix}`, codec.encode(payload, protocol), retain);

  const click = (
    p: LshProtocol,
    c = 10,
    t = ClickType.Long,
    i = 1,
    retain = false,
  ): Promise<void> => send("source", "events", { p, c, t, i }, retain);

  const commands = (): NodeMessage[] =>
    node.send.mock.calls
      .flatMap(([outputs]) => {
        const output = (outputs as unknown as Array<NodeMessage | NodeMessage[] | null>)[
          NodeOutput.LshCommands
        ];
        return output ? (Array.isArray(output) ? output : [output]) : [];
      })
      .map((message) => ({ ...message, payload: codec.decode(message.payload, protocol) }));

  const targetCommands = (): NodeMessage[] =>
    commands().filter((message) => message.topic === `${LSH}target/IN`);

  beforeEach(async () => {
    node = createMockNode();
    const action = {
      id: 1,
      actors: [{ name: "target", allActuators: true, actuators: [] }],
      otherActors: [],
    };
    instance = new LshLogicNode(node as unknown as Node, {
      ...defaultNodeConfig,
      protocol,
      lshBasePath: LSH,
      homieBasePath: HOMIE,
      serviceTopic: `${LSH}service`,
      systemConfigJson: JSON.stringify({
        devices: [
          { name: "source", longClickButtons: [action], superLongClickButtons: [action] },
          { name: "target" },
        ],
      }),
    });
    await instance.flush();
    for (const name of ["source", "target"]) {
      await send(name, "conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: name,
        a: [1, 2],
        b: [1],
      });
      await send(name, "state", { p: LshProtocol.ACTUATORS_STATE, s: [0] });
      await input(`${HOMIE}${name}/$state`, "ready");
    }
    node.send.mockClear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await instance.getCoordinator().stop();
  });

  it.each([ClickType.Long, ClickType.SuperLong])(
    "requires ACK/confirm and executes type %s only once",
    async (type) => {
      await click(LshProtocol.NETWORK_CLICK_REQUEST, 10, type);
      expect(commands()).toContainEqual(
        expect.objectContaining({
          topic: `${LSH}source/IN`,
          payload: { p: LshProtocol.NETWORK_CLICK_ACK, c: 10, t: type, i: 1 },
        }),
      );
      expect(targetCommands()).toHaveLength(0);
      await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, type);
      await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, type);
      expect(targetCommands()).toEqual([
        expect.objectContaining({
          payload: { p: LshProtocol.SET_STATE, s: [type === ClickType.Long ? 3 : 0] },
        }),
      ]);
      expect(commands().every((message) => String(message.topic).startsWith(LSH))).toBe(true);
    },
  );

  it("ignores retained requests and retained confirmations", async () => {
    await click(LshProtocol.NETWORK_CLICK_REQUEST, 9, ClickType.Long, 1, true);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 9);
    expect(commands()).toHaveLength(0);
    await click(LshProtocol.NETWORK_CLICK_REQUEST);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, ClickType.Long, 1, true);
    expect(targetCommands()).toHaveLength(0);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM);
    expect(targetCommands()).toHaveLength(1);
  });

  it("rejects unknown, mismatched, expired and replaced confirmations", async () => {
    await click(LshProtocol.NETWORK_CLICK_CONFIRM);
    await click(LshProtocol.NETWORK_CLICK_REQUEST);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, ClickType.SuperLong);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, ClickType.Long, 2);
    await click(LshProtocol.NETWORK_CLICK_REQUEST, 11);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10);
    expect(targetCommands()).toHaveLength(0);
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 3000);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 11);
    clock.mockRestore();
    expect(targetCommands()).toHaveLength(0);
    await click(LshProtocol.NETWORK_CLICK_REQUEST, 12);
    await click(LshProtocol.NETWORK_CLICK_CONFIRM, 12);
    expect(targetCommands()).toHaveLength(1);
  });

  it.each(["offline", "missing-state", "unknown-button"])(
    "fails over without actuation for %s",
    async (scenario) => {
      if (scenario === "offline") {
        await input(`${HOMIE}target/$state`, "lost");
      } else if (scenario === "missing-state") {
        await send("target", "conf", {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "target",
          a: [1, 2, 3],
          b: [1],
        });
      }
      node.send.mockClear();
      const button = scenario === "unknown-button" ? 99 : 1;
      await click(LshProtocol.NETWORK_CLICK_REQUEST, 10, ClickType.Long, button);
      expect(commands()).toContainEqual(
        expect.objectContaining({
          topic: `${LSH}source/IN`,
          payload: { p: LshProtocol.FAILOVER_CLICK, c: 10, t: ClickType.Long, i: button },
        }),
      );
      await click(LshProtocol.NETWORK_CLICK_CONFIRM, 10, ClickType.Long, button);
      expect(targetCommands()).toHaveLength(0);
    },
  );

  it("ignores the installation's default topic space", async () => {
    const request = { p: LshProtocol.NETWORK_CLICK_REQUEST, c: 10, t: ClickType.Long, i: 1 };
    await input("LSH/source/events", codec.encode(request, protocol));
    await click(LshProtocol.NETWORK_CLICK_CONFIRM);
    expect(commands()).toHaveLength(0);
  });
});
