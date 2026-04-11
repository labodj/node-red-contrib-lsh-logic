import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LshCodec } from "../LshCodec";
import {
  ClickType,
  LSH_PROTOCOL_KEYS,
  LSH_PROTOCOL_SPEC_REVISION,
  LSH_WIRE_PROTOCOL_MAJOR,
  LshProtocol,
} from "../types";

type ProtocolSpec = {
  meta: { specRevision: number; wireProtocolMajor: number };
  keys: Record<string, string>;
  commands: Array<{
    name: string;
    value: number;
    cppName?: string;
    tsName?: string;
  }>;
  clickTypes: Array<{ tsName: string; value: number }>;
  tsAliases?: Record<string, string>;
  staticPayloads: Array<{
    name: string;
    command: string;
    cppName?: string;
    symbolName?: string;
    targets: Array<"core" | "esp">;
  }>;
};

type GoldenPayloads = {
  payloads: Record<string, Record<string, unknown>>;
};

const NODE_RED_ROOT = resolve(__dirname, "../..");
const WORKSPACE_ROOT = resolve(NODE_RED_ROOT, "..");
const SPEC_PATH = resolve(NODE_RED_ROOT, "vendor/lsh-protocol/shared/lsh_protocol.json");
const GOLDEN_PATH = resolve(
  NODE_RED_ROOT,
  "vendor/lsh-protocol/shared/lsh_protocol_golden_payloads.json",
);
const CORE_PROTOCOL_PATH = resolve(
  WORKSPACE_ROOT,
  "lsh-core/src/communication/constants/protocol.hpp",
);
const CORE_STATIC_PAYLOADS_PATH = resolve(
  WORKSPACE_ROOT,
  "lsh-core/src/communication/constants/static_payloads.hpp",
);
const ESP_PROTOCOL_PATH = resolve(
  WORKSPACE_ROOT,
  "lsh-esp_bak/src/constants/communicationprotocol.hpp",
);
const ESP_STATIC_PAYLOADS_PATH = resolve(WORKSPACE_ROOT, "lsh-esp_bak/src/constants/payloads.hpp");

const hasCrossRepoWorkspace = [
  SPEC_PATH,
  GOLDEN_PATH,
  CORE_PROTOCOL_PATH,
  CORE_STATIC_PAYLOADS_PATH,
  ESP_PROTOCOL_PATH,
  ESP_STATIC_PAYLOADS_PATH,
].every(existsSync);

const describeContract = hasCrossRepoWorkspace ? describe : describe.skip;

const spec = hasCrossRepoWorkspace
  ? (JSON.parse(readFileSync(SPEC_PATH, "utf8")) as ProtocolSpec)
  : null;
const golden = hasCrossRepoWorkspace
  ? (JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenPayloads)
  : null;

const toJsonByteLiteral = (value: number): string =>
  Array.from(JSON.stringify({ p: value }) + "\n")
    .map((char) => (char === "\n" ? "'\\n'" : `'${char}'`))
    .join(", ");

const toFramedMsgPackByteLiteral = (value: number): string => {
  const payloadBytes = value <= 0x7f ? [0x81, 0xa1, 0x70, value] : [0x81, 0xa1, 0x70, 0xcc, value];
  const frameBytes = [payloadBytes.length & 0xff, (payloadBytes.length >> 8) & 0xff, ...payloadBytes];
  return frameBytes
    .map((byte) => `0x${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join(", ");
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tsCommandName = (command: ProtocolSpec["commands"][number]): string =>
  command.tsName ?? command.name;

const cppCommandName = (command: ProtocolSpec["commands"][number]): string =>
  command.cppName ?? command.name;

const payloadSymbolName = (payload: ProtocolSpec["staticPayloads"][number]): string =>
  payload.symbolName ?? payload.name;

const payloadCppName = (payload: ProtocolSpec["staticPayloads"][number]): string =>
  payload.cppName ?? payload.name;

describeContract("LSH protocol contract", () => {
  it("keeps generated TypeScript constants aligned with the shared spec", () => {
    expect(spec).not.toBeNull();
    expect(LSH_PROTOCOL_SPEC_REVISION).toBe(spec!.meta.specRevision);
    expect(LSH_WIRE_PROTOCOL_MAJOR).toBe(spec!.meta.wireProtocolMajor);
    expect(LSH_PROTOCOL_KEYS).toEqual({
      PAYLOAD: spec!.keys.KEY_PAYLOAD,
      PROTOCOL_MAJOR: spec!.keys.KEY_PROTOCOL_MAJOR,
      NAME: spec!.keys.KEY_NAME,
      ACTUATORS_ARRAY: spec!.keys.KEY_ACTUATORS_ARRAY,
      BUTTONS_ARRAY: spec!.keys.KEY_BUTTONS_ARRAY,
      CORRELATION_ID: spec!.keys.KEY_CORRELATION_ID,
      ID: spec!.keys.KEY_ID,
      STATE: spec!.keys.KEY_STATE,
      TYPE: spec!.keys.KEY_TYPE,
    });

    for (const command of spec!.commands) {
      expect(LshProtocol[tsCommandName(command) as keyof typeof LshProtocol]).toBe(command.value);
    }

    const renamedCommands = spec!.commands.filter(
      (command) => command.tsName && command.tsName !== command.name,
    );
    for (const command of renamedCommands) {
      expect((LshProtocol as Record<string, unknown>)[command.name]).toBeUndefined();
    }

    for (const clickType of spec!.clickTypes) {
      expect(ClickType[clickType.tsName as keyof typeof ClickType]).toBe(clickType.value);
    }

    for (const [alias, target] of Object.entries(spec!.tsAliases ?? {})) {
      expect(LshProtocol[alias as keyof typeof LshProtocol]).toBe(
        LshProtocol[
          tsCommandName(
            spec!.commands.find((command) => command.name === target)!,
          ) as keyof typeof LshProtocol
        ],
      );
    }
  });

  it("round-trips all golden payloads via JSON and MsgPack codecs", () => {
    const codec = new LshCodec();

    for (const payload of Object.values(golden!.payloads)) {
      expect(codec.decode(codec.encode(payload, "json"), "json")).toEqual(payload);

      const encoded = codec.encode(payload, "msgpack");
      expect(Buffer.isBuffer(encoded)).toBe(true);
      expect(codec.decode(encoded, "msgpack")).toEqual(payload);
    }
  });

  it("keeps generated C++ protocol headers aligned with the shared spec", () => {
    const coreHeader = readFileSync(CORE_PROTOCOL_PATH, "utf8");
    const espHeader = readFileSync(ESP_PROTOCOL_PATH, "utf8");

    for (const header of [coreHeader, espHeader]) {
      expect(header).toContain(`SPEC_REVISION = ${spec!.meta.specRevision}U`);
      expect(header).toContain(`WIRE_PROTOCOL_MAJOR = ${spec!.meta.wireProtocolMajor}U`);

      for (const [keyName, keyValue] of Object.entries(spec!.keys)) {
        expect(header).toMatch(
          new RegExp(`\\b${escapeRegExp(keyName)}(?:\\[\\])?\\s*=\\s*"${escapeRegExp(keyValue)}"`),
        );
      }

      for (const command of spec!.commands) {
        expect(header).toMatch(
          new RegExp(`\\b${escapeRegExp(cppCommandName(command))}\\s*=\\s*${command.value}\\b`),
        );
      }
    }
  });

  it("keeps generated static payload headers aligned with the shared spec", () => {
    const headersByTarget = {
      core: readFileSync(CORE_STATIC_PAYLOADS_PATH, "utf8"),
      esp: readFileSync(ESP_STATIC_PAYLOADS_PATH, "utf8"),
    };
    const commandsByName = new Map(spec!.commands.map((command) => [command.name, command.value]));

    for (const payload of spec!.staticPayloads) {
      const commandValue = commandsByName.get(payload.command);
      expect(commandValue).toBeDefined();

      const symbol = payloadSymbolName(payload);
      const enumName = payloadCppName(payload);

      for (const target of payload.targets) {
        const header = headersByTarget[target];
        expect(header).toMatch(new RegExp(`\\b${escapeRegExp(enumName)}\\b`));
        expect(header).toContain(`JSON_${symbol}_BYTES = {${toJsonByteLiteral(commandValue!)}}`);
        expect(header).toContain(
          `MSGPACK_${symbol}_BYTES = {${toFramedMsgPackByteLiteral(commandValue!)}}`,
        );
      }

      const unsupportedTargets = (["core", "esp"] as const).filter(
        (candidate) => !payload.targets.includes(candidate),
      );
      for (const target of unsupportedTargets) {
        const header = headersByTarget[target];
        expect(header).not.toMatch(new RegExp(`\\b${escapeRegExp(enumName)}\\b`));
        expect(header).not.toContain(`JSON_${symbol}_BYTES`);
        expect(header).not.toContain(`MSGPACK_${symbol}_BYTES`);
      }
    }
  });
});
