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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("General and Configuration", () => {
    it("should guard service entry points when config is not loaded", () => {
      const cases = [
        {
          run: () => service.processMessage("any/topic", {}),
          warning: "Configuration not loaded, ignoring message.",
        },
        {
          run: () => service.verifyInitialDeviceStates(),
          warning: "Cannot run initial state verification: config not loaded.",
        },
        {
          run: () => service.getStartupCommands(),
          warning: "Cannot generate startup commands: config not loaded.",
        },
      ];

      for (const { run, warning } of cases) {
        const result = run();
        expect(result.warnings).toContain(warning);
      }
    });

    it("should return a cloned system configuration", () => {
      loadConfig(createSystemConfig("dev1"));

      const systemConfig = service.getSystemConfig();
      systemConfig!.devices[0].name = "changed";

      expect(service.getSystemConfig()?.devices[0].name).toBe("dev1");
    });

    it("should treat unsupported or malformed topics as unhandled", () => {
      loadConfig();

      const cases = [
        { topic: "unhandled/topic/1", payload: {} },
        { topic: "homie/device-only", payload: "ready" },
        { topic: "LSH/device-only", payload: {} },
        { topic: "homie//$state", payload: "ready" },
        {
          topic: "LSH//state",
          payload: {
            p: LshProtocol.ACTUATORS_STATE,
            s: [0],
          },
        },
        { topic: "homie/device-1/$localip", payload: "192.168.1.5" },
        { topic: "LSH/device-1/telemetry", payload: {} },
      ];

      for (const { topic, payload } of cases) {
        const result = service.processMessage(topic, payload);
        expect(result.logs).toContain(`Message on unhandled topic: ${topic}`);
      }

      expect(service.getDeviceRegistry()[""]).toBeUndefined();
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

    it("should reject runtime configs with invalid or case-colliding device names", () => {
      expect(() =>
        service.updateSystemConfig({
          devices: [{ name: "bad/name" }],
        }),
      ).toThrow(/valid single MQTT topic segments/);

      expect(() =>
        service.updateSystemConfig({
          devices: [{ name: "Foo" }, { name: "foo" }],
        }),
      ).toThrow(/collide after case-insensitive normalization/);
    });

    it("should reject runtime configs whose actors reference unknown devices", () => {
      expect(() =>
        service.updateSystemConfig({
          devices: [
            {
              name: "sender",
              longClickButtons: [
                {
                  id: 1,
                  actors: [{ name: "ghost", allActuators: true, actuators: [] }],
                },
              ],
            },
          ],
        }),
      ).toThrow(/Configured actor 'ghost'/);
    });

    it("should discard pending click transactions whenever the config is reloaded", () => {
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

      const nextConfigs = [createSystemConfig("actor1"), structuredClone(initialConfig)];

      for (const nextConfig of nextConfigs) {
        loadConfig(structuredClone(initialConfig));
        setDeviceOnline("device-sender");
        setDeviceOnline("actor1");

        service.processMessage("LSH/device-sender/events", {
          p: LshProtocol.NETWORK_CLICK_REQUEST,
          c: 9,
          i: 1,
          t: 1,
        });

        const logMessage = service.updateSystemConfig(nextConfig);
        const confirmResult = service.processMessage("LSH/device-sender/events", {
          p: LshProtocol.NETWORK_CLICK_CONFIRM,
          c: 9,
          i: 1,
          t: 1,
        });

        expect(logMessage).toContain("Cleared 1 pending click transaction(s).");
        expect(confirmResult.warnings).toContain(
          "Received confirmation for an expired or unknown click: device-sender.1.1.9.",
        );
      }
    });

    it("should clear pending watchdog probe bookkeeping for devices removed from config", () => {
      const nowSpy = jest.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_000);

      loadConfig(createSystemConfig("dev1", "dev2"));
      setDeviceOnline("dev1");
      setDeviceOnline("dev2");

      nowSpy.mockReturnValue(5_000);
      service.runWatchdogCheck();

      const logMessage = service.updateSystemConfig(createSystemConfig("dev1"));

      expect(logMessage).toContain("Cleared pending watchdog probe state for: dev2.");
    });

    it("should regenerate HA discovery payloads when discovery overrides change", () => {
      loadConfig({
        devices: [{ name: "c1" }],
      });

      service.processMessage("homie/c1/$mac", "AA:BB:CC:DD:EE:FF");
      service.processMessage("homie/c1/$fw/version", "1.0.0");
      service.processMessage("homie/c1/1/state/$datatype", "boolean");
      service.processMessage("homie/c1/1/state/$settable", "true");
      service.processMessage("homie/c1/$nodes", "1");
      service.syncDiscoveryConfig();

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

    it("should skip HA discovery regeneration when a reload leaves the discovery model unchanged", () => {
      loadConfig({
        devices: [{ name: "c1" }],
      });

      service.processMessage("homie/c1/$mac", "AA:BB:CC:DD:EE:FF");
      service.processMessage("homie/c1/$fw/version", "1.0.0");
      service.processMessage("homie/c1/1/state/$datatype", "boolean");
      service.processMessage("homie/c1/1/state/$settable", "true");
      service.processMessage("homie/c1/$nodes", "1");
      service.syncDiscoveryConfig();

      service.updateSystemConfig({
        devices: [
          {
            name: "c1",
            longClickButtons: [
              {
                id: 1,
                actors: [{ name: "other-device", allActuators: true, actuators: [] }],
                otherActors: [],
              },
            ],
          },
          { name: "other-device" },
        ],
      });

      const syncResult = service.syncDiscoveryConfig();

      expect(syncResult.messages[Output.Lsh]).toBeUndefined();
      expect(syncResult.logs).toEqual([]);
    });

    it("should clear config, registry and stale watchdog state together", () => {
      const nowSpy = jest.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_000);

      loadConfig(createSystemConfig("dev1"));
      setDeviceOnline("dev1");

      nowSpy.mockReturnValue(5_000);
      service.runWatchdogCheck();

      service.clearSystemConfig();
      expect(service.getConfiguredDeviceNames()).toBeNull();
      expect(service.getSystemConfig()).toBeNull();
      expect(service.getDeviceRegistry()).toEqual({});

      service.updateSystemConfig(createSystemConfig("dev1"));

      nowSpy.mockReturnValue(6_000);
      const result = service.runWatchdogCheck();

      expect(getOutputMessages(result, Output.Lsh)).toEqual([
        expect.objectContaining({
          topic: defaultServiceConfig.serviceTopic,
          payload: { p: LshProtocol.PING },
        }),
      ]);
    });

    it("should prune expired wildcard discovery state during watchdog cycles even when no devices are configured", () => {
      const nowSpy = jest.spyOn(Date, "now");
      nowSpy.mockReturnValue(0);

      const watchdogHarness = createServiceHarness();
      watchdogHarness.loadConfig(createSystemConfig());
      watchdogHarness.service.processMessage("homie/wildcard-device/$mac", "AA:BB:CC:DD:EE:FF");
      watchdogHarness.service.processMessage("homie/wildcard-device/$fw/version", "1.0.0");
      watchdogHarness.service.processMessage("homie/wildcard-device/$nodes", "relay");

      nowSpy.mockReturnValue(24 * 60 * 60 * 1000 + 1);
      const pruneResult = watchdogHarness.service.runWatchdogCheck();
      const cleanupMessages = getOutputMessages(pruneResult, Output.Lsh);

      expect(cleanupMessages).toEqual([
        expect.objectContaining({
          topic: "homeassistant/device/lsh_wildcard-device/config",
          payload: "",
          qos: 1,
          retain: true,
        }),
        expect.objectContaining({
          topic: "homeassistant/sensor/lsh_wildcard-device_homie_state/config",
          payload: "",
          qos: 1,
          retain: true,
        }),
      ]);

      const regenerated = watchdogHarness.service.syncDiscoveryConfig();
      expect(regenerated.messages[Output.Lsh]).toBeUndefined();
    });

    it("should publish retained cleanup messages when a discovered device is removed from config", () => {
      loadConfig(createSystemConfig("device-to-remove"));
      service.processMessage("homie/device-to-remove/$mac", "AA:BB:CC:DD:EE:FF");
      service.processMessage("homie/device-to-remove/$fw/version", "1.0.0");
      service.processMessage("homie/device-to-remove/$nodes", "relay");

      service.updateSystemConfig(createSystemConfig());
      const syncResult = service.syncDiscoveryConfig();

      expect(getOutputMessages(syncResult, Output.Lsh)).toEqual([
        expect.objectContaining({
          topic: "homeassistant/device/lsh_device-to-remove/config",
          payload: "",
          qos: 1,
          retain: true,
        }),
        expect.objectContaining({
          topic: "homeassistant/sensor/lsh_device-to-remove_homie_state/config",
          payload: "",
          qos: 1,
          retain: true,
        }),
      ]);
    });

    it("should sanitize malformed Homie $nodes payloads before generating discovery", () => {
      loadConfig(createSystemConfig("device-nodes"));
      service.processMessage("homie/device-nodes/$mac", "AA:BB:CC:DD:EE:FF");
      service.processMessage("homie/device-nodes/$fw/version", "1.0.0");
      service.processMessage("homie/device-nodes/relay/state/$datatype", "boolean");
      service.processMessage("homie/device-nodes/relay/state/$settable", "true");
      service.processMessage("homie/device-nodes/KitchenLight/state/$datatype", "boolean");
      service.processMessage("homie/device-nodes/KitchenLight/state/$settable", "true");
      service.processMessage("homie/device-nodes/valid_2/state/$datatype", "boolean");
      service.processMessage("homie/device-nodes/valid_2/state/$settable", "true");

      const result = service.processMessage(
        "homie/device-nodes/$nodes",
        " relay ,bad node,@oops,KitchenLight,valid_2,topic/evil ",
      );

      const messages = getOutputMessages(result, Output.Lsh);
      const deviceMessage = messages.find(
        (message) => message.topic === "homeassistant/device/lsh_device-nodes/config",
      ) as
        | {
            payload: {
              components: Record<
                string,
                {
                  state_topic?: string;
                  command_topic?: string;
                }
              >;
            };
          }
        | undefined;

      expect(result.warnings).toContain(
        "Ignored invalid Homie node id(s) for 'device-nodes': bad node, @oops, topic/evil.",
      );
      expect(deviceMessage).toBeDefined();
      expect(deviceMessage!.payload.components).toHaveProperty("lsh_device-nodes_relay");
      expect(deviceMessage!.payload.components).toHaveProperty("lsh_device-nodes_kitchenlight");
      expect(deviceMessage!.payload.components).toHaveProperty("lsh_device-nodes_valid_2");
      expect(deviceMessage!.payload.components).not.toHaveProperty("lsh_device-nodes_bad node");
      expect(deviceMessage!.payload.components).not.toHaveProperty("lsh_device-nodes_topic/evil");
      expect(deviceMessage!.payload.components["lsh_device-nodes_relay"]).toEqual(
        expect.objectContaining({
          state_topic: "homie/device-nodes/relay/state",
          command_topic: "homie/device-nodes/relay/state/set",
        }),
      );
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

    it("should not send direct controller recovery commands when the bridge says controller_connected=false", () => {
      loadConfig(createSystemConfig("dev1"));
      service.processMessage("homie/dev1/$state", "ready");
      service.processMessage("LSH/dev1/bridge", {
        event: "service_ping_reply",
        controller_connected: false,
        runtime_synchronized: false,
        bootstrap_phase: "waiting_details",
      });

      const result = service.verifyInitialDeviceStates();

      expect(result.messages[Output.Lsh]).toBeUndefined();
      expect(result.logs).toContain(
        "Initial state verification: 1 device(s) have a reachable bridge but the downstream controller link is still down. Skipping direct controller recovery commands.",
      );
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

    it("should decide startup BOOT replay based on authoritative snapshot completeness", () => {
      const cases = [
        {
          setup: () => {
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
          },
          expected: true,
        },
        {
          setup: () => {
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
          },
          expected: false,
        },
      ];

      for (const { setup, expected } of cases) {
        service.clearSystemConfig();
        loadConfig(createSystemConfig("dev1", "dev2"));
        setup();
        expect(service.needsStartupBootReplay()).toBe(expected);
      }
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

    it("should carry validation errors for invalid LSH payloads", () => {
      const cases = [
        {
          mock: () => {
            validators.validateDeviceDetails.mockReturnValue(false);
            validators.validateDeviceDetails.errors = [createAjvError("invalid format")];
          },
          topic: "LSH/device-1/conf",
          payload: { p: LshProtocol.DEVICE_DETAILS },
          expectedWarning: "Invalid 'conf' payload from device-1: invalid format",
        },
        {
          mock: () => {
            validators.validateActuatorStates.mockReturnValue(false);
            validators.validateActuatorStates.errors = [createAjvError("mock state error")];
          },
          topic: "LSH/actor1/state",
          payload: { p: LshProtocol.ACTUATORS_STATE },
          expectedWarning: "Invalid 'state' payload from actor1: mock state error",
        },
        {
          mock: () => {
            validators.validateAnyEventsTopic.mockReturnValue(false);
            validators.validateAnyEventsTopic.errors = [createAjvError("mock events error")];
          },
          topic: "LSH/actor1/events",
          payload: { p: LshProtocol.PING },
          expectedWarning: "Invalid 'events' payload from actor1: mock events error",
        },
      ];

      for (const { mock, topic, payload, expectedWarning } of cases) {
        jest.clearAllMocks();
        mock();
        const result = service.processMessage(topic, payload);
        expect(result.warnings).toContain(expectedWarning);
      }
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

    it("should request details when state arrives before device details are known", () => {
      const cases = [
        {
          setup: () => {},
          topic: "LSH/unknown-dev/state",
          expectedLog: "Received state for a new device: unknown-dev. Creating partial entry.",
          expectedWarning:
            "Device 'unknown-dev' sent state but its configuration is unknown. Requesting details.",
          expectedReplyTopic: "LSH/unknown-dev/IN",
        },
        {
          setup: () => {
            service.processMessage("homie/actor1/$state", "ready");
          },
          topic: "LSH/actor1/state",
          expectedWarning:
            "Device 'actor1' sent state but its configuration is unknown. Requesting details.",
          expectedReplyTopic: "LSH/actor1/IN",
        },
      ];

      for (const { setup, topic, expectedLog, expectedWarning, expectedReplyTopic } of cases) {
        service.clearSystemConfig();
        loadConfig();
        setup();

        const result = service.processMessage(topic, {
          p: LshProtocol.ACTUATORS_STATE,
          s: [0],
        });

        if (expectedLog) {
          expect(result.logs).toContain(expectedLog);
        }
        expect(result.errors).toEqual([]);
        expect(result.warnings).toContain(expectedWarning);
        expect(getOutputMessages(result, Output.Lsh)[0].topic).toBe(expectedReplyTopic);
      }
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

    it("should ignore retained runtime payloads for reachability and recovery", () => {
      const cases = [
        {
          topic: "LSH/actor1/events",
          payload: { p: LshProtocol.PING },
          expectedLog:
            "Ignoring retained 'events' payload from 'actor1' because only live runtime traffic can affect reachability, clicks or bridge health.",
          assertDevice: () => {
            const device = service.getDeviceRegistry().actor1;
            expect(device.connected).toBe(false);
            expect(device.isHealthy).toBe(false);
          },
        },
        {
          topic: "LSH/actor1/bridge",
          payload: {
            event: "service_ping_reply",
            controller_connected: true,
            runtime_synchronized: true,
            bootstrap_phase: "runtime_ready",
          },
          expectedLog:
            "Ignoring retained 'bridge' payload from 'actor1' because only live runtime traffic can affect reachability, clicks or bridge health.",
          assertDevice: () => {
            const device = service.getDeviceRegistry().actor1;
            expect(device.bridgeConnected).toBe(false);
            expect(device.connected).toBe(false);
          },
        },
      ];

      for (const { topic, payload, expectedLog, assertDevice } of cases) {
        service.clearSystemConfig();
        loadConfig();
        setDeviceOnline("actor1");
        service.processMessage("homie/actor1/$state", "lost");

        const result = service.processMessage(topic, payload, { retained: true });

        expect(result.stateChanged).toBe(false);
        expect(result.messages).toEqual({});
        expect(result.logs).toContain(expectedLog);
        assertDevice();
      }
    });

    it("should keep retained Homie ready as a silent baseline until live traffic arrives", () => {
      const setups = [
        () => {
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
        },
        () => {},
      ];

      for (const setup of setups) {
        setup();

        const result = service.processMessage("homie/actor1/$state", "ready", { retained: true });
        const device = service.getDeviceRegistry().actor1;

        expect(result.stateChanged).toBe(false);
        expect(result.messages).toEqual({});
        expect(device).toBeDefined();
        expect(device.connected).toBe(false);
        expect(device.lastSeenTime).toBe(0);
        expect(device.lastHomieState).toBe("ready");

        service.clearSystemConfig();
        loadConfig();
      }
    });

    it("should still ignore retained Homie ready for devices outside the loaded system config", () => {
      const result = service.processMessage("homie/unknown-device/$state", "ready", {
        retained: true,
      });

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(service.getDeviceRegistry()["unknown-device"]).toBeUndefined();
    });

    it("should treat non-ready Homie lifecycle states as diagnostics and ignore repeats", () => {
      const cases = [
        {
          state: "init",
          setup: () => {},
          assertDevice: () => {
            const device = service.getDeviceRegistry().actor1;
            expect(device.connected).toBe(false);
            expect(device.isHealthy).toBe(false);
            expect(device.lastHomieState).toBe("init");
            expect(device.bridgeLastSeenTime).toBeGreaterThan(0);
          },
        },
        {
          state: "sleeping",
          setup: () => {
            setDeviceOnline("actor1");
          },
          assertDevice: () => {
            const device = service.getDeviceRegistry().actor1;
            expect(device.bridgeConnected).toBe(true);
            expect(device.connected).toBe(true);
            expect(device.isHealthy).toBe(true);
            expect(device.lastHomieState).toBe("sleeping");
          },
          verifyRepeatNoop: true,
        },
      ];

      for (const { state, setup, assertDevice, verifyRepeatNoop } of cases) {
        service.clearSystemConfig();
        loadConfig();
        setup();

        const result = service.processMessage("homie/actor1/$state", state);

        expect(result.stateChanged).toBe(true);
        expect(result.messages).toEqual({});
        expect(result.logs).toContain(
          `Device 'actor1' reported Homie lifecycle state '${state}'. Ignoring it for reachability, alerts and resync.`,
        );
        assertDevice();

        if (verifyRepeatNoop) {
          const repeated = service.processMessage("homie/actor1/$state", state);
          expect(repeated.stateChanged).toBe(false);
          expect(repeated.logs).toEqual([]);
          expect(repeated.messages).toEqual({});
        }
      }
    });

    it("should emit retained Homie transition alerts without changing live reachability", () => {
      const cases = [
        {
          setup: () => setDeviceOnline("actor1"),
          nextState: "lost",
          expectedLog:
            "Device 'actor1' reported retained Homie runtime transition 'ready -> lost'. Emitting an offline alert without changing reachability state.",
          expectedHomieState: "lost",
        },
        {
          setup: () => {
            setDeviceOnline("actor1");
            service.processMessage("homie/actor1/$state", "lost", { retained: true });
          },
          nextState: "ready",
          expectedLog:
            "Device 'actor1' reported retained Homie runtime transition 'lost -> ready'. Emitting a recovery alert without changing reachability state.",
          expectedHomieState: "ready",
        },
      ];

      for (const { setup, nextState, expectedLog, expectedHomieState } of cases) {
        service.clearSystemConfig();
        loadConfig();
        setup();

        const result = service.processMessage("homie/actor1/$state", nextState, {
          retained: true,
        });
        const device = service.getDeviceRegistry().actor1;

        expect(result.stateChanged).toBe(true);
        expect(result.messages[Output.Alerts]).toBeDefined();
        expect(result.logs).toContain(expectedLog);
        expect(device.connected).toBe(true);
        expect(device.lastHomieState).toBe(expectedHomieState);
      }
    });

    it("should tag recovery alerts triggered by live telemetry as live telemetry", () => {
      const cases = [
        {
          setup: () => {},
          trigger: () =>
            service.processMessage("LSH/actor1/conf", {
              p: LshProtocol.DEVICE_DETAILS,
              v: LSH_WIRE_PROTOCOL_MAJOR,
              n: "actor1",
              a: [1, 2],
              b: [],
            }),
          expectedMessage: "live details",
        },
        {
          setup: () => {
            service.processMessage("LSH/actor1/conf", {
              p: LshProtocol.DEVICE_DETAILS,
              v: LSH_WIRE_PROTOCOL_MAJOR,
              n: "actor1",
              a: [1, 2],
              b: [],
            });
            sendLshState("actor1", [0]);
          },
          trigger: () => sendLshState("actor1", [0]),
          expectedMessage: "live state",
        },
      ];

      for (const { setup, trigger, expectedMessage } of cases) {
        setup();
        service.processMessage("homie/actor1/$state", "lost");

        const result = trigger();

        expect(getAlertPayload(result).event_type).toBe("device_recovered");
        expect(getAlertPayload(result).event_source).toBe("live_telemetry");
        expect(getAlertPayload(result).message).toContain(expectedMessage);

        service.clearSystemConfig();
        loadConfig();
      }
    });

    it("should return a no-op when receiving the same Homie ready state twice", () => {
      setDeviceOnline("actor1");

      const result = service.processMessage("homie/actor1/$state", "ready");

      expect(result.stateChanged).toBe(false);
      expect(result.logs).toEqual([]);
      expect(result.messages).toEqual({});
    });

    it("should treat identical details and state updates as no-ops", () => {
      const cases = [
        {
          setup: () => {},
          first: () =>
            service.processMessage("LSH/actor1/conf", {
              p: LshProtocol.DEVICE_DETAILS,
              v: LSH_WIRE_PROTOCOL_MAJOR,
              n: "actor1",
              a: [1, 2],
              b: [],
            }),
          second: () =>
            service.processMessage("LSH/actor1/conf", {
              p: LshProtocol.DEVICE_DETAILS,
              v: LSH_WIRE_PROTOCOL_MAJOR,
              n: "actor1",
              a: [1, 2],
              b: [],
            }),
        },
        {
          setup: () => {
            service.processMessage("LSH/actor1/conf", {
              p: LshProtocol.DEVICE_DETAILS,
              v: LSH_WIRE_PROTOCOL_MAJOR,
              n: "actor1",
              a: [1, 2],
              b: [],
            });
          },
          first: () => sendLshState("actor1", [0b01]),
          second: () => sendLshState("actor1", [0b01]),
        },
      ];

      for (const { setup, first, second } of cases) {
        service.clearSystemConfig();
        loadConfig();
        setup();

        const firstResult = first();
        const secondResult = second();

        expect(firstResult.stateChanged).toBe(true);
        expect(secondResult.stateChanged).toBe(false);
        expect(secondResult.logs).toEqual([]);
      }
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

    it("should ignore unknown events protocol payloads gracefully", () => {
      const result = service.processMessage("LSH/actor1/events", { p: 999 });

      expect(result.messages).toEqual({});
      expect(result.logs).toEqual([]);
      expect(result.warnings).toEqual([
        "Unhandled 'events' payload from actor1: protocol id '999'.",
      ]);
      expect(result.errors).toEqual([]);
    });

    it("should accept bridge-local diagnostics on bridge without treating them as controller traffic", () => {
      const result = service.processMessage("LSH/actor1/bridge", {
        event: "diagnostic",
        kind: "actuator_command_storm_dropped",
        pending_ms: 1000,
        mutation_count: 32,
      });

      expect(result.stateChanged).toBe(false);
      expect(result.messages).toEqual({});
      expect(result.warnings).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.logs).toContain(
        "Bridge diagnostic from 'actor1': actuator_command_storm_dropped. Ignoring it for controller reachability and click logic.",
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
      service.processMessage(`homie/${deviceId}/lamp/state/$datatype`, "boolean");
      service.processMessage(`homie/${deviceId}/lamp/state/$settable`, "true");
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
      service.processMessage(`homie/${deviceId}/lamp/state/$datatype`, "boolean");
      service.processMessage(`homie/${deviceId}/lamp/state/$settable`, "true");
      service.processMessage(`homie/${deviceId}/relay/state/$datatype`, "boolean");
      service.processMessage(`homie/${deviceId}/relay/state/$settable`, "true");
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
