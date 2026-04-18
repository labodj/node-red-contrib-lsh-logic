import type { LshLogicService } from "../LshLogicService";
import { LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "../types";
import type { ServiceHarness } from "./helpers/serviceTestUtils";
import {
  createAjvError,
  getAlertPayload,
  createLoadedServiceHarness,
  createServiceHarness,
  createSystemConfig,
  defaultServiceConfig,
  defaultSystemConfig,
  getOutputMessages,
} from "./helpers/serviceTestUtils";

describe("LshLogicService - Core & Config", () => {
  let service: LshLogicService;
  let validators: ServiceHarness["validators"];
  let loadConfig: ServiceHarness["loadConfig"];
  let setDeviceOnline: ServiceHarness["setDeviceOnline"];
  let sendLshState: ServiceHarness["sendLshState"];

  beforeEach(() => {
    ({ service, validators, loadConfig, setDeviceOnline, sendLshState } = createServiceHarness());
  });

  describe("General and Configuration", () => {
    it("should ignore messages if config is not loaded", () => {
      const result = service.processMessage("any/topic", {});

      expect(result.warnings).toContain("Configuration not loaded, ignoring message.");
    });

    it("should warn if verifyInitialDeviceStates is called without config", () => {
      const result = service.verifyInitialDeviceStates();

      expect(result.warnings).toContain(
        "Cannot run initial state verification: config not loaded.",
      );
    });

    it("should warn if getStartupCommands is called without config", () => {
      const result = service.getStartupCommands();

      expect(result.warnings).toContain("Cannot generate startup commands: config not loaded.");
    });

    it("should return a cloned system configuration", () => {
      loadConfig(createSystemConfig("dev1"));

      const systemConfig = service.getSystemConfig();
      systemConfig!.devices[0].name = "changed";

      expect(service.getSystemConfig()?.devices[0].name).toBe("dev1");
    });

    it("should ignore messages on unhandled topics", () => {
      loadConfig();

      const result = service.processMessage("unhandled/topic/1", {});

      expect(result.logs).toContain("Message on unhandled topic: unhandled/topic/1");
    });

    it("should treat malformed Homie and LSH topics under valid prefixes as unhandled", () => {
      loadConfig();

      const homieResult = service.processMessage("homie/device-only", "ready");
      const lshResult = service.processMessage("LSH/device-only", {});

      expect(homieResult.logs).toContain("Message on unhandled topic: homie/device-only");
      expect(lshResult.logs).toContain("Message on unhandled topic: LSH/device-only");
    });

    it("should treat unsupported subtopics under valid prefixes as unhandled", () => {
      loadConfig();

      const homieResult = service.processMessage("homie/device-1/$localip", "192.168.1.5");
      const lshResult = service.processMessage("LSH/device-1/telemetry", {});

      expect(homieResult.logs).toContain("Message on unhandled topic: homie/device-1/$localip");
      expect(lshResult.logs).toContain("Message on unhandled topic: LSH/device-1/telemetry");
    });

    it("should prune devices from the registry when config is updated", () => {
      loadConfig();
      setDeviceOnline("device-sender");

      expect(service.getDeviceRegistry()["device-sender"]).toBeDefined();

      const nextSystemConfig = createSystemConfig("actor1");
      const logMessage = service.updateSystemConfig(nextSystemConfig);

      expect(service.getDeviceRegistry()["device-sender"]).toBeUndefined();
      expect(logMessage).toContain("Pruned stale devices from registry");
    });

    it("should discard pending click transactions when config is updated", () => {
      loadConfig({
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: 1,
                actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      });
      setDeviceOnline("device-sender");
      setDeviceOnline("actor1");

      service.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK_REQUEST,
        c: 9,
        i: 1,
        t: 1,
      });

      const logMessage = service.updateSystemConfig(createSystemConfig("actor1"));
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK_CONFIRM,
        c: 9,
        i: 1,
        t: 1,
      });

      expect(logMessage).toContain("Cleared 1 pending click transaction(s).");
      expect(confirmResult.warnings).toContain(
        "Received confirmation for an expired or unknown click: device-sender.1.1.9.",
      );
    });

    it("should clear pending click transactions even when the config reload is identical", () => {
      const initialConfig = {
        devices: [
          {
            name: "device-sender",
            longClickButtons: [
              {
                id: 1,
                actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                otherActors: [],
              },
            ],
          },
          { name: "actor1" },
        ],
      };

      loadConfig(initialConfig);
      setDeviceOnline("device-sender");
      setDeviceOnline("actor1");

      service.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK_REQUEST,
        c: 9,
        i: 1,
        t: 1,
      });

      const logMessage = service.updateSystemConfig(structuredClone(initialConfig));
      const confirmResult = service.processMessage("LSH/device-sender/misc", {
        p: LshProtocol.NETWORK_CLICK_CONFIRM,
        c: 9,
        i: 1,
        t: 1,
      });

      expect(logMessage).toContain("Cleared 1 pending click transaction(s).");
      expect(confirmResult.warnings).toContain(
        "Received confirmation for an expired or unknown click: device-sender.1.1.9.",
      );
    });

    it("should regenerate HA discovery payloads when discovery overrides change", () => {
      loadConfig({
        devices: [{ name: "c1" }],
      });

      service.processMessage("homie/c1/$mac", "AA:BB:CC:DD:EE:FF");
      service.processMessage("homie/c1/$fw/version", "1.0.0");
      service.processMessage("homie/c1/$nodes", "1");

      service.updateSystemConfig({
        devices: [
          {
            name: "c1",
            haDiscovery: {
              deviceName: "Kitchen Board",
              nodes: {
                "1": {
                  platform: "switch",
                  name: "Kitchen Light",
                  defaultEntityId: "switch.kitchen_light",
                },
              },
            },
          },
        ],
      });

      const syncResult = service.syncDiscoveryConfig();
      const discoveryMessages = getOutputMessages(syncResult, Output.Lsh);
      const deviceMessages = discoveryMessages.filter(
        (message) => message.topic === "homeassistant/device/lsh_c1/config",
      );
      const finalPayload = deviceMessages[1]?.payload as {
        device: { name: string };
        components: Record<string, { platform: string; name?: string; default_entity_id?: string }>;
      };

      expect(deviceMessages).toHaveLength(2);
      expect(finalPayload.device.name).toBe("Kitchen Board");
      expect(finalPayload.components.lsh_c1_1).toEqual(
        expect.objectContaining({
          platform: "switch",
          name: "Kitchen Light",
          default_entity_id: "switch.kitchen_light",
        }),
      );
    });

    it("should clear the loaded system config", () => {
      loadConfig();

      service.clearSystemConfig();

      expect(service.getConfiguredDeviceNames()).toBeNull();
      expect(service.getSystemConfig()).toBeNull();
    });
  });

  describe("Startup Verification", () => {
    beforeEach(() => {
      loadConfig();
    });

    it("should ping only the configured devices that are still silent", () => {
      setDeviceOnline("device-sender");

      const result = service.verifyInitialDeviceStates();

      expect(getOutputMessages(result, Output.Lsh).map((message) => message.topic)).toEqual([
        "LSH/actor1/IN",
        "LSH/device-silent/IN",
      ]);
      expect(result.logs).toContain(
        "Initial state verification: 2 device(s) are still unreachable. Pinging them directly.",
      );
    });

    it("should request only the missing snapshot data for a reachable but incomplete device", () => {
      loadConfig(createSystemConfig("dev1"));
      service.processMessage("homie/dev1/$state", "ready");

      const result = service.verifyInitialDeviceStates();

      expect(getOutputMessages(result, Output.Lsh).map((message) => message.payload)).toEqual([
        { p: LshProtocol.REQUEST_DETAILS },
        { p: LshProtocol.REQUEST_STATE },
      ]);
      expect(result.logs).toContain(
        "Initial state verification: 1 reachable device(s) still need authoritative snapshot recovery.",
      );
    });

    it("should combine snapshot repair and direct pings when only a subset of devices is offline", () => {
      loadConfig(createSystemConfig("dev1", "dev2"));
      service.processMessage("homie/dev1/$state", "ready");

      const result = service.verifyInitialDeviceStates();

      expect(getOutputMessages(result, Output.Lsh)).toEqual([
        expect.objectContaining({
          topic: "LSH/dev1/IN",
          payload: { p: LshProtocol.REQUEST_DETAILS },
        }),
        expect.objectContaining({
          topic: "LSH/dev1/IN",
          payload: { p: LshProtocol.REQUEST_STATE },
        }),
        expect.objectContaining({
          topic: "LSH/dev2/IN",
          payload: { p: LshProtocol.PING },
        }),
      ]);
      expect(result.logs).toContain(
        "Initial state verification: 1 reachable device(s) still need authoritative snapshot recovery.",
      );
      expect(result.logs).toContain(
        "Initial state verification: 1 device(s) are still unreachable. Pinging them directly.",
      );
    });

    it("should ping retained-only devices that still are not live", () => {
      loadConfig(createSystemConfig("dev1", "dev2"));
      service.processMessage(
        "LSH/dev1/conf",
        {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "dev1",
          a: [1],
          b: [],
        },
        { retained: true },
      );
      service.processMessage(
        "LSH/dev1/state",
        {
          p: LshProtocol.ACTUATORS_STATE,
          s: [0],
        },
        { retained: true },
      );

      const result = service.verifyInitialDeviceStates();

      expect(getOutputMessages(result, Output.Lsh)).toEqual([
        expect.objectContaining({
          topic: "LSH/dev1/IN",
          payload: { p: LshProtocol.PING },
        }),
        expect.objectContaining({
          topic: "LSH/dev2/IN",
          payload: { p: LshProtocol.PING },
        }),
      ]);
    });

    it("should log success when all configured devices are reachable with authoritative snapshots", () => {
      setDeviceOnline("device-sender");
      setDeviceOnline("actor1");
      setDeviceOnline("device-silent");

      const result = service.verifyInitialDeviceStates();

      expect(result.logs).toContain(
        "Initial state verification: all configured devices are reachable and already have authoritative snapshots.",
      );
    });

    it("should return startup logs after configuration is loaded", () => {
      const result = service.getStartupCommands();

      expect(result.logs).toContain(
        "Requesting a single bridge-local BOOT resync from all devices.",
      );
      expect(getOutputMessages(result, Output.Lsh)).toEqual([
        expect.objectContaining({
          topic: defaultServiceConfig.serviceTopic,
          payload: { p: LshProtocol.BOOT },
        }),
      ]);
    });

    it("should request a startup BOOT replay when any configured device lacks a full snapshot", () => {
      loadConfig(createSystemConfig("dev1", "dev2"));
      service.processMessage(
        "LSH/dev1/conf",
        {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "dev1",
          a: [1],
          b: [],
        },
        { retained: true },
      );

      expect(service.needsStartupBootReplay()).toBe(true);
    });

    it("should skip a startup BOOT replay when every configured device already has details and state snapshots", () => {
      loadConfig(createSystemConfig("dev1", "dev2"));
      for (const deviceName of ["dev1", "dev2"]) {
        service.processMessage(
          `LSH/${deviceName}/conf`,
          {
            p: LshProtocol.DEVICE_DETAILS,
            v: LSH_WIRE_PROTOCOL_MAJOR,
            n: deviceName,
            a: [1],
            b: [],
          },
          { retained: true },
        );
        service.processMessage(
          `LSH/${deviceName}/state`,
          {
            p: LshProtocol.ACTUATORS_STATE,
            s: [0],
          },
          { retained: true },
        );
      }

      expect(service.needsStartupBootReplay()).toBe(false);
    });

    it("should warn when startup commands are requested for an empty configuration", () => {
      loadConfig(createSystemConfig());

      const result = service.getStartupCommands();

      expect(result.warnings).toContain("Cannot generate startup commands: config not loaded.");
    });
  });

  describe("Error Handling & Robustness", () => {
    beforeEach(() => {
      loadConfig();
    });

    it("should carry validation errors for invalid conf payloads", () => {
      validators.validateDeviceDetails.mockReturnValue(false);
      validators.validateDeviceDetails.errors = [createAjvError("invalid format")];

      const result = service.processMessage("LSH/device-1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
      });

      expect(result.warnings).toEqual(["Invalid 'conf' payload from device-1: invalid format"]);
    });

    it("should carry validation errors for invalid state payloads", () => {
      validators.validateActuatorStates.mockReturnValue(false);
      validators.validateActuatorStates.errors = [createAjvError("mock state error")];

      const result = service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
      });

      expect(result.warnings).toContain("Invalid 'state' payload from actor1: mock state error");
    });

    it("should carry validation errors for invalid misc payloads", () => {
      validators.validateAnyMiscTopic.mockReturnValue(false);
      validators.validateAnyMiscTopic.errors = [createAjvError("mock misc error")];

      const result = service.processMessage("LSH/actor1/misc", {
        p: LshProtocol.PING,
      });

      expect(result.warnings).toContain("Invalid 'misc' payload from actor1: mock misc error");
    });

    it("should report actuator state length mismatches gracefully", () => {
      setDeviceOnline("actor1");

      const result = sendLshState("actor1", [1, 0]);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("State mismatch for actor1: expected 1 bytes");
    });

    it("should surface unexpected exceptions raised while handling state payloads", () => {
      const result = service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
      });

      expect(result.errors).toHaveLength(1);
    });

    it("should request details when a new device sends state before configuration", () => {
      const result = service.processMessage("LSH/unknown-dev/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [0],
      });

      expect(result.logs).toContain(
        "Received state for a new device: unknown-dev. Creating partial entry.",
      );
      expect(result.warnings).toContain(
        "Device 'unknown-dev' sent state but its configuration is unknown. Requesting details.",
      );
      expect(getOutputMessages(result, Output.Lsh)[0].topic).toBe("LSH/unknown-dev/IN");
    });

    it("should request details when a known device shell sends state before details", () => {
      service.processMessage("homie/actor1/$state", "ready");

      const result = service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [0],
      });

      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain(
        "Device 'actor1' sent state but its configuration is unknown. Requesting details.",
      );
      expect(getOutputMessages(result, Output.Lsh)[0].topic).toBe("LSH/actor1/IN");
    });

    it("should promote live LSH details and state to connected even without Homie ready", () => {
      service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });
      service.processMessage("LSH/actor1/state", {
        p: LshProtocol.ACTUATORS_STATE,
        s: [0],
      });

      expect(service.getDeviceRegistry().actor1.connected).toBe(true);
      expect(service.getDeviceRegistry().actor1.isHealthy).toBe(true);
    });

    it("should not promote retained LSH snapshots to connected without live traffic", () => {
      service.processMessage(
        "LSH/actor1/conf",
        {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "actor1",
          a: [1, 2],
          b: [],
        },
        { retained: true },
      );
      service.processMessage(
        "LSH/actor1/state",
        {
          p: LshProtocol.ACTUATORS_STATE,
          s: [0],
        },
        { retained: true },
      );

      expect(service.getDeviceRegistry().actor1.connected).toBe(false);
      expect(service.getDeviceRegistry().actor1.isHealthy).toBe(false);
    });

    it("should keep retained Homie ready as a silent baseline for devices known only from retained LSH snapshots", () => {
      service.processMessage(
        "LSH/actor1/conf",
        {
          p: LshProtocol.DEVICE_DETAILS,
          v: LSH_WIRE_PROTOCOL_MAJOR,
          n: "actor1",
          a: [1, 2],
          b: [],
        },
        { retained: true },
      );
      service.processMessage(
        "LSH/actor1/state",
        {
          p: LshProtocol.ACTUATORS_STATE,
          s: [0],
        },
        { retained: true },
      );

      const result = service.processMessage("homie/actor1/$state", "ready", { retained: true });
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(device).toBeDefined();
      expect(device.connected).toBe(false);
      expect(device.lastSeenTime).toBe(0);
      expect(device.lastHomieState).toBe("ready");
    });

    it("should keep retained Homie ready as a silent baseline for configured devices until live traffic arrives", () => {
      const result = service.processMessage("homie/actor1/$state", "ready", { retained: true });
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(device).toBeDefined();
      expect(device.connected).toBe(false);
      expect(device.lastSeenTime).toBe(0);
      expect(device.lastHomieState).toBe("ready");
    });

    it("should still ignore retained Homie ready for devices outside the loaded system config", () => {
      const result = service.processMessage("homie/unknown-device/$state", "ready", {
        retained: true,
      });

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(service.getDeviceRegistry()["unknown-device"]).toBeUndefined();
    });

    it("should record a live Homie init state as diagnostics without alerting or resyncing", () => {
      const result = service.processMessage("homie/actor1/$state", "init");
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(true);
      expect(result.messages).toEqual({});
      expect(result.logs).toContain(
        "Device 'actor1' reported Homie lifecycle state 'init'. Ignoring it for alerts and resync.",
      );
      expect(device.connected).toBe(false);
      expect(device.isHealthy).toBe(false);
      expect(device.lastHomieState).toBe("init");
      expect(device.lastSeenTime).toBeGreaterThan(0);
    });

    it("should treat Homie sleeping as diagnostic unavailability without alerting", () => {
      setDeviceOnline("actor1");

      const result = service.processMessage("homie/actor1/$state", "sleeping");
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(true);
      expect(result.messages).toEqual({});
      expect(result.logs).toContain(
        "Device 'actor1' reported Homie lifecycle state 'sleeping'. Ignoring it for alerts and resync.",
      );
      expect(device.connected).toBe(false);
      expect(device.lastHomieState).toBe("sleeping");
    });

    it("should return a no-op when receiving the same diagnostic Homie state twice", () => {
      service.processMessage("homie/actor1/$state", "sleeping");

      const result = service.processMessage("homie/actor1/$state", "sleeping");

      expect(result.stateChanged).toBe(false);
      expect(result.logs).toEqual([]);
      expect(result.messages).toEqual({});
    });

    it("should ignore retained Homie offline transitions for reachability after live traffic established the session", () => {
      setDeviceOnline("actor1");

      const result = service.processMessage("homie/actor1/$state", "lost", { retained: true });
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(true);
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect(result.logs).toContain(
        "Device 'actor1' reported retained Homie runtime transition 'ready -> lost'. Emitting an offline alert without changing reachability state.",
      );
      expect(device.connected).toBe(true);
      expect(device.lastHomieState).toBe("lost");
    });

    it("should ignore retained Homie recovery transitions for reachability after live traffic established the session", () => {
      setDeviceOnline("actor1");
      service.processMessage("homie/actor1/$state", "lost", { retained: true });

      const result = service.processMessage("homie/actor1/$state", "ready", { retained: true });
      const device = service.getDeviceRegistry().actor1;

      expect(result.stateChanged).toBe(true);
      expect(result.messages[Output.Alerts]).toBeDefined();
      expect(result.logs).toContain(
        "Device 'actor1' reported retained Homie runtime transition 'lost -> ready'. Emitting a recovery alert without changing reachability state.",
      );
      expect(device.connected).toBe(true);
      expect(device.lastHomieState).toBe("ready");
    });

    it("should tag recovery alerts triggered by live details as live telemetry", () => {
      service.processMessage("homie/actor1/$state", "lost");

      const result = service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });

      expect(getAlertPayload(result).event_type).toBe("device_recovered");
      expect(getAlertPayload(result).event_source).toBe("live_telemetry");
      expect(getAlertPayload(result).message).toContain("live details");
    });

    it("should tag recovery alerts triggered by live actuator state as live telemetry", () => {
      service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });
      sendLshState("actor1", [0]);
      service.processMessage("homie/actor1/$state", "lost");

      const result = sendLshState("actor1", [0]);

      expect(getAlertPayload(result).event_type).toBe("device_recovered");
      expect(getAlertPayload(result).event_source).toBe("live_telemetry");
      expect(getAlertPayload(result).message).toContain("live state");
    });

    it("should return a no-op when receiving the same Homie ready state twice", () => {
      setDeviceOnline("actor1");

      const result = service.processMessage("homie/actor1/$state", "ready");

      expect(result.stateChanged).toBe(false);
      expect(result.logs).toEqual([]);
      expect(result.messages).toEqual({});
    });

    it("should not report a state change when device details are unchanged", () => {
      const first = service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });
      const second = service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });

      expect(first.stateChanged).toBe(true);
      expect(second.stateChanged).toBe(false);
      expect(second.logs).toEqual([]);
    });

    it("should invalidate authoritative state when actuator IDs change", () => {
      setDeviceOnline("actor1", { a: [1, 2] });
      sendLshState("actor1", [0b01]);

      const result = service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [3, 4],
        b: [],
      });

      expect(result.logs).toContain("Stored/Updated details for device 'actor1'.");
      expect(result.messages[Output.Lsh]).toBeUndefined();
      expect(service.getDeviceRegistry().actor1.lastStateTime).toBe(0);
      expect(service.getDeviceRegistry().actor1.actuatorStates).toEqual([]);
    });

    it("should not report a state change when the actuator state is unchanged", () => {
      service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR,
        n: "actor1",
        a: [1, 2],
        b: [],
      });

      const first = sendLshState("actor1", [0b01]);
      const second = sendLshState("actor1", [0b01]);

      expect(first.stateChanged).toBe(true);
      expect(second.stateChanged).toBe(false);
      expect(second.logs).toEqual([]);
    });

    it("should ignore unknown misc protocol payloads gracefully", () => {
      const result = service.processMessage("LSH/actor1/misc", { p: 999 });

      expect(result.messages).toEqual({});
      expect(result.logs).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it("should accept bridge-local diagnostics on misc without treating them as device traffic", () => {
      const result = service.processMessage("LSH/actor1/misc", {
        bridge_diagnostic: "actuator_command_storm_dropped",
        pending_ms: 1000,
        mutation_count: 32,
      });

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.logs).toContain(
        "Bridge diagnostic from 'actor1': actuator_command_storm_dropped. Ignoring it for reachability and click logic.",
      );
      expect(service.getDeviceRegistry().actor1).toBeUndefined();
    });

    it("should ignore device details with an incompatible protocol major", () => {
      const result = service.processMessage("LSH/actor1/conf", {
        p: LshProtocol.DEVICE_DETAILS,
        v: LSH_WIRE_PROTOCOL_MAJOR + 1,
        n: "actor1",
        a: [1, 2],
        b: [],
      });

      expect(result.stateChanged).toBe(false);
      expect(result.warnings).toContain(
        `Protocol major mismatch for actor1: received ${LSH_WIRE_PROTOCOL_MAJOR + 1}, expected ${LSH_WIRE_PROTOCOL_MAJOR}. Ignoring details payload.`,
      );
      expect(service.getDeviceRegistry().actor1).toBeUndefined();
    });

    it("should return null when there are no expired click transactions to clean up", () => {
      expect(service.cleanupPendingClicks()).toBeNull();
    });
  });

  describe("Homie Discovery Integration", () => {
    beforeEach(() => {
      loadConfig(defaultSystemConfig);
    });

    it("should process Homie discovery attributes when enabled", () => {
      const deviceId = "new-homie-device";

      service.processMessage(`homie/${deviceId}/$mac`, "AA:BB:CC");
      service.processMessage(`homie/${deviceId}/$fw/version`, "1.0.0");
      const result = service.processMessage(`homie/${deviceId}/$nodes`, "lamp");

      const messages = getOutputMessages(result, Output.Lsh);
      const deviceMessage = messages.find(
        (message) => message.topic === "homeassistant/device/lsh_new-homie-device/config",
      );
      const homieStateMessage = messages.find(
        (message) =>
          message.topic === "homeassistant/sensor/lsh_new-homie-device_homie_state/config",
      );

      expect(messages).toHaveLength(2);
      expect(deviceMessage).toBeDefined();
      expect(homieStateMessage).toBeDefined();
      expect(deviceMessage!.payload).not.toHaveProperty("~");
      expect((deviceMessage!.payload as { availability_topic: string }).availability_topic).toBe(
        "homie/new-homie-device/$state",
      );
      expect(
        (
          deviceMessage!.payload as {
            components: Record<
              string,
              {
                platform: string;
                unique_id?: string;
                state_topic?: string;
                command_topic?: string;
              }
            >;
          }
        ).components["lsh_new-homie-device_lamp"],
      ).toEqual(
        expect.objectContaining({
          platform: "light",
          unique_id: "lsh_new-homie-device_lamp",
          state_topic: "homie/new-homie-device/lamp/state",
          command_topic: "homie/new-homie-device/lamp/state/set",
        }),
      );
      expect(
        homieStateMessage!.payload as {
          unique_id: string;
          default_entity_id: string;
          state_topic: string;
        },
      ).toEqual(
        expect.objectContaining({
          unique_id: "lsh_new-homie-device_homie_state",
          default_entity_id: "sensor.lsh_new-homie-device_homie_state",
          state_topic: "homie/new-homie-device/$state",
        }),
      );
      expect(homieStateMessage!.payload).not.toHaveProperty("availability_topic");
    });

    it("should emit a removal update before the final device discovery payload when a Homie node disappears", () => {
      const deviceId = "new-homie-device";

      service.processMessage(`homie/${deviceId}/$mac`, "AA:BB:CC");
      service.processMessage(`homie/${deviceId}/$fw/version`, "1.0.0");
      service.processMessage(`homie/${deviceId}/$nodes`, "lamp,relay");

      const result = service.processMessage(`homie/${deviceId}/$nodes`, "lamp");
      const messages = getOutputMessages(result, Output.Lsh);
      const deviceMessages = messages.filter(
        (message) => message.topic === "homeassistant/device/lsh_new-homie-device/config",
      );

      expect(messages).toHaveLength(3);
      expect(deviceMessages).toHaveLength(2);
      expect(
        (
          deviceMessages[0].payload as {
            components: Record<string, { platform: string; unique_id?: string }>;
          }
        ).components["lsh_new-homie-device_relay"],
      ).toEqual({ platform: "light" });
      expect(
        (
          deviceMessages[1].payload as {
            components: Record<string, { platform: string; unique_id?: string }>;
          }
        ).components,
      ).not.toHaveProperty("lsh_new-homie-device_relay");
      expect(messages).toContainEqual(
        expect.objectContaining({
          topic: "homeassistant/sensor/lsh_new-homie-device_homie_state/config",
        }),
      );
    });

    it("should ignore Homie discovery attributes when disabled", () => {
      const disabledHarness = createLoadedServiceHarness({
        config: { haDiscovery: false },
      });

      const result = disabledHarness.service.processMessage("homie/dev1/$nodes", "foo");

      expect(result.messages[Output.Lsh]).toBeUndefined();
    });
  });

  describe("Codec Integration", () => {
    it("should encode output commands as MsgPack when configured", () => {
      const msgpackHarness = createLoadedServiceHarness({
        config: { protocol: "msgpack" },
      });

      const result = msgpackHarness.sendHomieState("device-sender", "ready");
      const messages = getOutputMessages(result, Output.Lsh);

      expect(messages).toHaveLength(2);
      expect(messages.every((message) => Buffer.isBuffer(message.payload))).toBe(true);
    });

    it("should preserve the default service topic in the test harness", () => {
      expect(defaultServiceConfig.serviceTopic).toBe("LSH/Node-RED/SRV");
    });
  });
});
