import type { ErrorObject, ValidateFunction } from "ajv";
import type { NodeMessage } from "node-red";
import { LshLogicService } from "../../LshLogicService";
import { LSH_WIRE_PROTOCOL_MAJOR, LshProtocol, Output } from "../../types";
import type {
  AlertPayload,
  AnyBridgeTopicPayload,
  AnyEventsTopicPayload,
  DeviceDetailsPayload,
  OtherActorsCommandPayload,
  ServiceResult,
  SystemConfig,
} from "../../types";

export type ValidatorMock = jest.Mock & ValidateFunction;

export const createMockValidator = (): ValidatorMock => {
  const mockFn = jest.fn().mockReturnValue(true) as ValidatorMock;
  mockFn.errors = null;
  return mockFn;
};

export const createMockValidators = () => ({
  validateDeviceDetails: createMockValidator(),
  validateActuatorStates: createMockValidator(),
  validateAnyEventsTopic: createMockValidator(),
  validateAnyBridgeTopic: createMockValidator(),
});

type ServiceConfig = {
  lshBasePath: string;
  homieBasePath: string;
  serviceTopic: string;
  protocol: "json" | "msgpack";
  otherDevicesPrefix: string;
  clickTimeout: number;
  interrogateThreshold: number;
  pingTimeout: number;
  haDiscovery: boolean;
  haDiscoveryPrefix: string;
};

export const defaultServiceConfig: ServiceConfig = {
  lshBasePath: "LSH/",
  homieBasePath: "homie/",
  serviceTopic: "LSH/Node-RED/SRV",
  protocol: "json",
  otherDevicesPrefix: "other_devices",
  clickTimeout: 2,
  interrogateThreshold: 3,
  pingTimeout: 5,
  haDiscovery: true,
  haDiscoveryPrefix: "homeassistant",
};

export const defaultSystemConfig: SystemConfig = {
  devices: [{ name: "device-sender" }, { name: "actor1" }, { name: "device-silent" }],
};

export type ServiceHarnessOptions = {
  config?: Partial<ServiceConfig>;
  systemConfig?: SystemConfig;
};

type MessageOptions = {
  retained?: boolean;
};

export const createSystemConfig = (...deviceNames: string[]): SystemConfig => ({
  devices: deviceNames.map((name) => ({ name })),
});

export function createServiceHarness(options: ServiceHarnessOptions = {}) {
  const validators = createMockValidators();

  const contextReader = { get: jest.fn<unknown, [string]>() };
  const config = { ...defaultServiceConfig, ...options.config };
  const service = new LshLogicService(config, contextReader, validators);

  const loadConfig = (
    systemConfig: SystemConfig = options.systemConfig ?? defaultSystemConfig,
  ): SystemConfig => {
    service.updateSystemConfig(systemConfig);
    return systemConfig;
  };

  const sendDeviceDetails = (
    deviceName: string,
    details: Partial<Omit<DeviceDetailsPayload, "p" | "n">> = {},
    options: MessageOptions = {},
  ): ServiceResult =>
    service.processMessage(
      `${config.lshBasePath}${deviceName}/conf`,
      {
        p: LshProtocol.DEVICE_DETAILS,
        v: details.v ?? LSH_WIRE_PROTOCOL_MAJOR,
        n: deviceName,
        a: details.a ?? [1],
        b: details.b ?? [],
      },
      options,
    );

  const sendHomieState = (
    deviceName: string,
    state: string,
    options: MessageOptions = {},
  ): ServiceResult =>
    service.processMessage(`${config.homieBasePath}${deviceName}/$state`, state, options);

  const setDeviceOnline = (
    deviceName: string,
    details: Partial<Omit<DeviceDetailsPayload, "p" | "n">> = {},
  ): void => {
    const actuatorIds = details.a ?? [1];
    sendDeviceDetails(deviceName, details);
    sendLshState(deviceName, new Array<number>(Math.ceil(actuatorIds.length / 8)).fill(0));
    sendHomieState(deviceName, "ready");
  };

  const sendLshState = (
    deviceName: string,
    packedState: number[],
    options: MessageOptions = {},
  ): ServiceResult =>
    service.processMessage(
      `${config.lshBasePath}${deviceName}/state`,
      {
        p: LshProtocol.ACTUATORS_STATE,
        s: packedState,
      },
      options,
    );

  const sendEvents = (
    deviceName: string,
    payload: AnyEventsTopicPayload,
    options: MessageOptions = {},
  ): ServiceResult =>
    service.processMessage(`${config.lshBasePath}${deviceName}/events`, payload, options);

  const sendBridge = (
    deviceName: string,
    payload: AnyBridgeTopicPayload,
    options: MessageOptions = {},
  ): ServiceResult =>
    service.processMessage(`${config.lshBasePath}${deviceName}/bridge`, payload, options);

  return {
    service,
    config,
    validators,
    contextReader,
    loadConfig,
    sendDeviceDetails,
    sendHomieState,
    setDeviceOnline,
    sendLshState,
    sendEvents,
    sendBridge,
  };
}

export type ServiceHarness = ReturnType<typeof createServiceHarness>;

export function createLoadedServiceHarness(options: ServiceHarnessOptions = {}) {
  const harness = createServiceHarness(options);
  harness.loadConfig();
  return harness;
}

export function createAjvError(message: string): ErrorObject {
  return {
    instancePath: "",
    schemaPath: "#/mock",
    keyword: "mock",
    params: {},
    message,
  };
}

export function getOutputMessages(
  result: Pick<ServiceResult, "messages">,
  output: Output,
): NodeMessage[] {
  const message = result.messages[output];
  if (!message) {
    throw new Error(`Expected output ${output} to contain at least one message.`);
  }
  return (Array.isArray(message) ? message : [message]) as NodeMessage[];
}

export function getSingleOutputMessage<TPayload = unknown>(
  result: Pick<ServiceResult, "messages">,
  output: Output,
): NodeMessage & { payload: TPayload } {
  const messages = getOutputMessages(result, output);
  if (messages.length !== 1) {
    throw new Error(
      `Expected output ${output} to contain exactly one message, got ${messages.length}.`,
    );
  }
  return messages[0] as NodeMessage & { payload: TPayload };
}

export function getAlertPayload(result: Pick<ServiceResult, "messages">): AlertPayload {
  const alertPayloads = getAlertPayloads(result);
  if (alertPayloads.length !== 1) {
    throw new Error(`Expected exactly one alert payload, got ${alertPayloads.length}.`);
  }

  return alertPayloads[0];
}

export function getAlertPayloads(result: Pick<ServiceResult, "messages">): AlertPayload[] {
  return getOutputMessages(result, Output.Alerts).map((message) => message.payload as AlertPayload);
}

export function getOtherActorsPayload(
  result: Pick<ServiceResult, "messages">,
): OtherActorsCommandPayload {
  return getSingleOutputMessage<OtherActorsCommandPayload>(result, Output.OtherActors).payload;
}
