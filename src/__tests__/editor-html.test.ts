import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { LaboSmartHomeCoordinator } from "labo-smart-home-coordinator";
import type { SystemConfig } from "labo-smart-home-coordinator";

type EditorValidator = (this: Record<string, unknown>, value: unknown) => boolean;
type EditorDefinition = {
  defaults: Record<string, { validate?: EditorValidator }>;
};

const loadEditorDefinition = (filename: string) => {
  const source = readFileSync(join(__dirname, "..", filename), "utf8");
  const script = source.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/u)?.[1];
  if (!script) {
    throw new Error(`Missing editor script in ${filename}`);
  }

  const registrations = new Map<string, EditorDefinition>();
  const context = createContext({
    RED: {
      nodes: {
        registerType: (name: string, definition: EditorDefinition) => {
          registrations.set(name, definition);
        },
      },
    },
    $: () => ({ length: 0, val: () => undefined }),
  });
  runInContext(script, context);

  return { context, registrations, source };
};

const getValidator = (definition: EditorDefinition, property: string): EditorValidator => {
  const validator = definition.defaults[property]?.validate;
  if (!validator) {
    throw new Error(`Missing editor validator for ${property}`);
  }
  return validator;
};

describe("Node-RED editor HTML", () => {
  it.each([
    {
      name: "allows an omitted actuator list when all actuators are selected",
      config: {
        devices: [
          {
            name: "a",
            longClickButtons: [{ id: 1, actors: [{ name: "b", allActuators: true }] }],
          },
          { name: "b" },
        ],
      },
      expected: true,
    },
    {
      name: "accepts the maximum uint8 actuator id",
      config: {
        devices: [
          {
            name: "a",
            longClickButtons: [
              {
                id: 255,
                actors: [{ name: "b", allActuators: false, actuators: [255] }],
              },
            ],
          },
          { name: "b" },
        ],
      },
      expected: true,
    },
    {
      name: "rejects a button id outside uint8",
      config: {
        devices: [{ name: "a", longClickButtons: [{ id: 256, otherActors: ["lamp"] }] }],
      },
      expected: false,
    },
    {
      name: "rejects an actuator id outside uint8",
      config: {
        devices: [
          {
            name: "a",
            longClickButtons: [
              {
                id: 1,
                actors: [{ name: "b", allActuators: false, actuators: [256] }],
              },
            ],
          },
          { name: "b" },
        ],
      },
      expected: false,
    },
  ])("keeps system config validation in sync: $name", async ({ config, expected }) => {
    const { registrations } = loadEditorDefinition("lsh-logic.html");
    const editorDefinition = registrations.get("lsh-logic");
    if (!editorDefinition) {
      throw new Error("lsh-logic editor was not registered");
    }

    const editorAccepts = getValidator(editorDefinition, "systemConfigJson").call(
      {},
      JSON.stringify(config),
    );
    const coordinator = new LaboSmartHomeCoordinator({
      systemConfig: config as unknown as SystemConfig,
    });
    let runtimeAccepts = true;
    try {
      await coordinator.start();
      await coordinator.flush();
    } catch {
      runtimeAccepts = false;
    } finally {
      await coordinator.stop();
    }

    expect(editorAccepts).toBe(expected);
    expect(runtimeAccepts).toBe(expected);
  });

  it("keeps editor helpers scoped and the large forms collapsed", () => {
    const logic = loadEditorDefinition("lsh-logic.html");
    const actuatorSync = loadEditorDefinition("lsh-actuator-sync.html");
    const externalState = loadEditorDefinition("lsh-external-state.html");

    expect(runInContext("typeof validatePositiveNumber", logic.context)).toBe("undefined");
    expect(logic.source.match(/<details class="lsh-config-section"/gu)).toHaveLength(4);
    expect(logic.source.match(/<details class="lsh-config-section" open>/gu)).toHaveLength(1);
    expect(actuatorSync.source.match(/<details class="lsh-sync-section"/gu)).toHaveLength(3);
    expect(externalState.source.match(/<details class="lsh-external-section"/gu)).toHaveLength(4);
    expect(logic.source).toContain("node-text-editor lsh-system-config-editor");
    expect(logic.source).not.toContain("node-input-insertDevice");
    expect(logic.source).not.toContain("node-input-insertLongClick");
    expect(logic.source).not.toContain("additionalProperties=false");
  });

  it("validates only the active external-state mapping fields", () => {
    const { registrations } = loadEditorDefinition("lsh-external-state.html");
    const definition = registrations.get("lsh-external-state");
    if (!definition) {
      throw new Error("lsh-external-state editor was not registered");
    }

    const prefix = getValidator(definition, "prefix");
    const actorName = getValidator(definition, "actorName");
    const actorProperty = getValidator(definition, "actorNameProperty");

    expect(prefix.call({ prefixSource: "manual" }, "")).toBe(false);
    expect(prefix.call({ prefixSource: "config" }, "")).toBe(true);
    expect(actorName.call({ actorNameSource: "config" }, "")).toBe(false);
    expect(actorName.call({ actorNameSource: "msg" }, "")).toBe(true);
    expect(actorProperty.call({ actorNameSource: "msg" }, "")).toBe(false);
    expect(actorProperty.call({ actorNameSource: "config" }, "")).toBe(true);
  });
});
