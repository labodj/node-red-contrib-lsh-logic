/**
 * @file Node-RED adapter for `labo-smart-home-coordinator`.
 *
 * The package no longer embeds a private copy of the LSH orchestration logic.
 * This file only translates between Node-RED concepts (node status, outputs,
 * context stores and `mqtt in` control messages) and the standalone coordinator
 * library. Keeping the wrapper thin makes CLI, library and Node-RED behavior
 * converge by construction.
 */

import type { Node, NodeAPI, NodeMessage } from "node-red";

import {
  LaboSmartHomeCoordinator,
  buildNodeRedSubscriptionMessages,
} from "labo-smart-home-coordinator";
import type {
  CoordinatorStatus,
  DeviceRegistrySnapshot,
  SystemConfig,
} from "labo-smart-home-coordinator";

import { normalizeNodeConfig, parseSystemConfigJson } from "./lsh-logic.config";
import { NodeOutput } from "./types";
import type { LshLogicNodeDef } from "./types";

type ContextStore = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
};

type StatusShape = {
  fill: "red" | "green" | "yellow" | "blue" | "grey";
  shape: "dot" | "ring";
  text: string;
};

type OutputMap = Partial<Record<NodeOutput, NodeMessage | NodeMessage[]>>;

const NODE_OUTPUT_COUNT = 5;

const Output = {
  Lsh: NodeOutput.LshCommands,
  OtherActors: NodeOutput.OtherActorCommands,
  Alerts: NodeOutput.Alerts,
  Configuration: NodeOutput.Configuration,
  Debug: NodeOutput.Debug,
} as const;

const STATUS_BY_COORDINATOR_STATUS: Record<CoordinatorStatus, StatusShape> = {
  stopped: { fill: "grey", shape: "ring", text: "Stopped" },
  starting: { fill: "blue", shape: "dot", text: "Starting" },
  ready: { fill: "green", shape: "dot", text: "Ready" },
  warming_up: { fill: "blue", shape: "ring", text: "Warming up" },
  config_error: { fill: "red", shape: "ring", text: "Config Error" },
  closing: { fill: "grey", shape: "ring", text: "Closing" },
};

/**
 * Runtime class attached to a single Node-RED node instance.
 */
export class LshLogicNode {
  private readonly node: Node;
  private readonly config: LshLogicNodeDef;
  private readonly coordinator: LaboSmartHomeCoordinator;
  private readonly initPromise: Promise<void>;
  private isClosing = false;
  private lastSubscriptionSignature: string | null = null;
  private coordinatorStatus: CoordinatorStatus = "stopped";
  private registrySnapshot: DeviceRegistrySnapshot = {};
  private configuredDeviceCount = 0;

  public constructor(node: Node, config: LshLogicNodeDef) {
    this.node = node;
    this.config = normalizeNodeConfig(config);
    this.coordinator = new LaboSmartHomeCoordinator({
      ...this.config,
      systemConfig: parseSystemConfigJson(this.config.systemConfigJson),
      otherActorStateReader: this.getContext(this.config.otherActorsContext),
    });

    this.wireCoordinatorEvents();
    this.registerNodeEventHandlers();
    this.initPromise = this.initialize();
  }

  /**
   * Exposes the shared coordinator for tests and advanced host integrations.
   */
  public getCoordinator(): LaboSmartHomeCoordinator {
    return this.coordinator;
  }

  /**
   * Waits for all coordinator work currently queued by the wrapper.
   */
  public async flush(): Promise<void> {
    await this.initPromise;
    await this.coordinator.flush();
  }

  private async initialize(): Promise<void> {
    try {
      this.node.status({ fill: "blue", shape: "dot", text: "Initializing" });
      await this.coordinator.start();
      this.node.log("Node initialized and inline configuration loaded.");
    } catch (error) {
      this.node.error(`Critical error during initialization: ${this.toErrorMessage(error)}`);
      this.node.status({ fill: "red", shape: "ring", text: "Config Error" });
      throw error;
    }
  }

  private registerNodeEventHandlers(): void {
    this.node.on("input", (msg, _send, done?: (err?: Error) => void) => {
      void this.handleInput(msg, done);
    });

    this.node.on("close", (done: () => void) => {
      void (async () => {
        try {
          await this.handleClose();
        } catch (error) {
          this.node.error(`Error during node close: ${this.toErrorMessage(error)}`);
        } finally {
          done();
        }
      })();
    });
  }

  private wireCoordinatorEvents(): void {
    this.coordinator.on("status", (status) => {
      this.coordinatorStatus = status;
      this.refreshNodeStatus();
    });

    this.coordinator.on("log", (message) => this.node.log(message));
    this.coordinator.on("warning", (message) => this.node.warn(message));
    this.coordinator.on("error", (message) => this.node.error(message));

    this.coordinator.on("mqtt", (message) => {
      this.send({ [NodeOutput.LshCommands]: message });
    });

    this.coordinator.on("otherActors", (payload) => {
      this.send({ [NodeOutput.OtherActorCommands]: { payload } });
    });

    this.coordinator.on("alert", (payload) => {
      this.send({ [NodeOutput.Alerts]: { payload } });
    });

    this.coordinator.on("debug", (message) => {
      this.send({ [NodeOutput.Debug]: message });
    });

    this.coordinator.on("state", ({ devices, lastUpdated }) => {
      this.registrySnapshot = devices;
      this.refreshNodeStatus();
      this.exportState(devices, lastUpdated);
    });

    this.coordinator.on("config", (systemConfig) => {
      this.configuredDeviceCount = systemConfig.devices.length;
      this.refreshNodeStatus();
      this.exportConfig(systemConfig);
      this.emitSubscriptionMessages();
    });
  }

  private async handleInput(
    msg: NodeMessage,
    done: ((err?: Error) => void) | undefined,
  ): Promise<void> {
    if (this.isClosing) {
      done?.();
      return;
    }

    try {
      await this.initPromise;
      await this.coordinator.processMqttMessage(msg);
      done?.();
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(this.toErrorMessage(error));
      this.node.error(`Error processing message: ${wrappedError.message}`);
      done?.(wrappedError);
    }
  }

  private async handleClose(): Promise<void> {
    this.isClosing = true;
    await this.initPromise.catch(() => undefined);
    await this.coordinator.stop();
  }

  private emitSubscriptionMessages(): void {
    const subscriptions = this.coordinator.getSubscriptions();
    const subscriptionMessages = buildNodeRedSubscriptionMessages(subscriptions);
    const signature = JSON.stringify(subscriptionMessages);

    if (signature !== this.lastSubscriptionSignature) {
      this.lastSubscriptionSignature = signature;
      this.node.log("MQTT topic set changed. Reconfiguring runtime subscriptions.");
      this.send({ [NodeOutput.Configuration]: subscriptionMessages as unknown as NodeMessage[] });
    } else {
      this.node.log("MQTT topic set unchanged. Skipping runtime subscription reconfiguration.");
    }

    this.exportTopics(Object.keys(subscriptions).sort());
  }

  private exportState(devices: DeviceRegistrySnapshot, lastUpdated: number): void {
    if (this.config.exposeStateContext === "none") {
      return;
    }

    this.getContext(this.config.exposeStateContext).set(this.config.exposeStateKey, {
      devices,
      lastUpdated,
    });
  }

  private exportConfig(systemConfig: SystemConfig): void {
    if (this.config.exposeConfigContext === "none") {
      return;
    }

    this.getContext(this.config.exposeConfigContext).set(this.config.exposeConfigKey, systemConfig);
  }

  private exportTopics(allTopics: string[]): void {
    if (this.config.exportTopics === "none") {
      return;
    }

    const lshTopics = allTopics.filter((topic) => topic.startsWith(this.config.lshBasePath));
    const homieTopics = allTopics.filter((topic) => topic.startsWith(this.config.homieBasePath));
    this.getContext(this.config.exportTopics).set(this.config.exportTopicsKey, {
      lsh: lshTopics,
      homie: homieTopics,
      all: allTopics,
      lastUpdated: Date.now(),
    });
  }

  private refreshNodeStatus(): void {
    const status = STATUS_BY_COORDINATOR_STATUS[this.coordinatorStatus];
    this.node.status({
      ...status,
      text: this.formatCompactStatusText(status.text),
    });
  }

  private formatCompactStatusText(baseText: string): string {
    const devices = Object.values(this.registrySnapshot);
    const deviceCount = Math.max(devices.length, this.configuredDeviceCount);
    if (deviceCount === 0) {
      return baseText;
    }

    const bridgeOnline = devices.filter((device) => device.bridgeConnected).length;
    const controllerOnline = devices.filter(
      (device) => device.controllerLinkConnected ?? device.connected,
    ).length;

    return `${baseText} d:${deviceCount} b:${bridgeOnline}/${deviceCount} c:${controllerOnline}/${deviceCount}`;
  }

  private getContext(contextName: "flow" | "global"): ContextStore {
    const context = this.node.context();
    return context[contextName];
  }

  private send(messages: OutputMap): void {
    if (this.isClosing) {
      return;
    }

    const outputs = new Array<NodeMessage | NodeMessage[] | null>(NODE_OUTPUT_COUNT).fill(null);
    for (const [outputIndex, message] of Object.entries(messages)) {
      outputs[Number(outputIndex)] = message ?? null;
    }

    if (outputs.some((output) => output !== null)) {
      this.node.send(outputs);
    }
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

const nodeRedModule = function (RED: NodeAPI) {
  function LshLogicNodeWrapper(this: Node, config: LshLogicNodeDef) {
    RED.nodes.createNode(this, config);
    try {
      new LshLogicNode(this, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(`Invalid node configuration: ${message}`);
      this.status({ fill: "red", shape: "ring", text: "Node Config Error" });
    }
  }

  RED.nodes.registerType("lsh-logic", LshLogicNodeWrapper);
};

module.exports = Object.assign(nodeRedModule, { LshLogicNode, NodeOutput, Output });
