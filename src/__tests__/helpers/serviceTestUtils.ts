import { ErrorObject, ValidateFunction } from "ajv";
import { NodeMessage } from "node-red";
import { LshLogicService } from "../../LshLogicService";
import {
  AlertPayload,
  AnyMiscTopicPayload,
  DeviceDetailsPayload,
  LshProtocol,
  OtherActorsCommandPayload,
  Output,
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
  validateAnyMiscTopic: createMockValidator(),
});

export const defaultServiceConfig = {
  lshBasePath: "LSH/",
  homieBasePath: "homie/",
  serviceTopic: "LSH/Node-RED/SRV",
  protocol: "json" as const,
  otherDevicesPrefix: "other_devices",
  clickTimeout: 5,
  interrogateThreshold: 3,
  pingTimeout: 5,
  haDiscovery: true,
  haDiscoveryPrefix: "homeassistant",
};

export const defaultSystemConfig: SystemConfig = {
  devices: [
    { name: "device-sender" },
    { name: "actor1" },
    { name: "device-silent" },
  ],
};

export type ServiceHarnessOptions = {
  config?: Partial<typeof defaultServiceConfig>;
  systemConfig?: SystemConfig;
};

export const createSystemConfig = (...deviceNames: string[]): SystemConfig => ({
  devices: deviceNames.map((name) => ({ name })),
});

export function createServiceHarness(options: ServiceHarnessOptions = {}) {
  const validators = createMockValidators();

  const contextReader = { get: jest.fn<unknown, [string]>() };
  const config = { ...defaultServiceConfig, ...options.config };
  const service = new LshLogicService(config, contextReader, validators);

  const loadConfig = (systemConfig: SystemConfig = options.systemConfig ?? defaultSystemConfig): SystemConfig => {
    service.updateSystemConfig(systemConfig);
    return systemConfig;
  };

  const sendDeviceDetails = (
    deviceName: string,
    details: Partial<Omit<DeviceDetailsPayload, "p" | "n">> = {}
  ): ServiceResult =>
    service.processMessage(`${config.lshBasePath}${deviceName}/conf`, {
      p: LshProtocol.DEVICE_DETAILS,
      n: deviceName,
      a: details.a ?? [1],
      b: details.b ?? [],
    });

  const sendHomieState = (deviceName: string, state: string): ServiceResult =>
    service.processMessage(`${config.homieBasePath}${deviceName}/$state`, state);

  const setDeviceOnline = (
    deviceName: string,
    details: Partial<Omit<DeviceDetailsPayload, "p" | "n">> = {}
  ): void => {
    sendDeviceDetails(deviceName, details);
    sendHomieState(deviceName, "ready");
  };

  const sendLshState = (deviceName: string, packedState: number[]): ServiceResult =>
    service.processMessage(`${config.lshBasePath}${deviceName}/state`, {
      p: LshProtocol.ACTUATORS_STATE,
      s: packedState,
    });

  const sendMisc = (deviceName: string, payload: AnyMiscTopicPayload): ServiceResult =>
    service.processMessage(`${config.lshBasePath}${deviceName}/misc`, payload);

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
    sendMisc,
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
  output: Output
): NodeMessage[] {
  const message = result.messages[output];
  if (!message) {
    throw new Error(`Expected output ${output} to contain at least one message.`);
  }
  return Array.isArray(message) ? message : [message];
}

export function getSingleOutputMessage<TPayload = unknown>(
  result: Pick<ServiceResult, "messages">,
  output: Output
): NodeMessage & { payload: TPayload } {
  const messages = getOutputMessages(result, output);
  if (messages.length !== 1) {
    throw new Error(`Expected output ${output} to contain exactly one message, got ${messages.length}.`);
  }
  return messages[0] as NodeMessage & { payload: TPayload };
}

export function getAlertPayload(
  result: Pick<ServiceResult, "messages">
): AlertPayload {
  return getSingleOutputMessage<AlertPayload>(result, Output.Alerts).payload;
}

export function getOtherActorsPayload(
  result: Pick<ServiceResult, "messages">
): OtherActorsCommandPayload {
  return getSingleOutputMessage<OtherActorsCommandPayload>(
    result,
    Output.OtherActors
  ).payload;
}
