/**
 * @file Unit and integration tests for the LshLogicService class.
 */
import { ValidateFunction } from "ajv";
import { LshLogicService } from "../LshLogicService";
import { ClickType, LongClickConfig, LshProtocol, Output } from "../types";

// --- MOCK HELPERS ---

/**
 * Creates a mock AJV ValidateFunction that satisfies TypeScript's type requirements.
 * This is more robust than a simple jest.fn().
 * @param initialReturnValue - The default boolean value for the mock validator to return.
 */
const createMockValidator = (initialReturnValue: boolean = true): jest.Mock & ValidateFunction => {
    const mockFn = jest.fn();
    mockFn.mockReturnValue(initialReturnValue);

    // Add the properties required by the ValidateFunction type to the mock
    const validatorMock = mockFn as jest.Mock & ValidateFunction;
    validatorMock.schema = {}; // or a more specific mock schema if needed
    validatorMock.errors = null; // Default state

    // Allow overwriting the 'errors' property for testing error messages
    Object.defineProperty(validatorMock, 'errors', {
        get: jest.fn(() => mockFn.mock.results[0]?.value === false ? [{ message: "mock error" }] : null),
        set: jest.fn(),
        configurable: true
    });

    return validatorMock;
};

// A mock context reader that can be controlled by tests.
const mockContextReader = {
    get: jest.fn(),
};

// Mock validator functions that can be controlled by tests.
const mockValidators = {
    validateDeviceDetails: createMockValidator(),
    validateActuatorStates: createMockValidator(),
    validateAnyMiscTopic: createMockValidator()
};

// A base configuration for the service used in tests.
const mockServiceConfig = {
    lshBasePath: "LSH/",
    serviceTopic: "LSH/Node-RED/SRV",
    otherDevicesPrefix: "other_devices",
    clickTimeout: 5,
    interrogateThreshold: 3,
    pingTimeout: 5,
};

// A base long-click configuration file for tests.
const mockLongClickConfig: LongClickConfig = {
    devices: [
        {
            name: "device-sender",
            longClickButtons: [
                {
                    id: "B1",
                    actors: [{ name: "actor1", allActuators: true, actuators: [] }],
                    otherActors: [],
                },
            ],
            superLongClickButtons: [],
        },
        {
            name: "actor1",
            longClickButtons: [],
            superLongClickButtons: [],
        },
    ],
};

describe("LshLogicService", () => {
    let service: LshLogicService;

    beforeEach(() => {
        // Reset mocks and create a fresh service instance for each test
        jest.clearAllMocks();

        // Reset validators to their default happy-path state
        mockValidators.validateDeviceDetails.mockReturnValue(true);
        mockValidators.validateActuatorStates.mockReturnValue(true);
        mockValidators.validateAnyMiscTopic.mockReturnValue(true);

        service = new LshLogicService(mockServiceConfig, mockContextReader, mockValidators);
    });

    describe("Payload Validation", () => {
        it.each([
            { topicSuffix: 'conf', payload: { p: LshProtocol.DEVICE_DETAILS }, validator: mockValidators.validateDeviceDetails, expectedWarning: "Invalid 'conf' payload" },
            { topicSuffix: 'state', payload: { p: LshProtocol.DEVICE_ACTUATORS_STATE }, validator: mockValidators.validateActuatorStates, expectedWarning: "Invalid 'state' payload" },
            { topicSuffix: 'misc', payload: { p: LshProtocol.NETWORK_CLICK }, validator: mockValidators.validateAnyMiscTopic, expectedWarning: "Invalid 'misc' payload" },
        ])('should return a warning for an invalid /$topicSuffix payload', ({ topicSuffix, payload, validator, expectedWarning }) => {
            // Arrange
            validator.mockReturnValue(false);
            service.updateLongClickConfig(mockLongClickConfig);

            // Act
            const result = service.processMessage(`LSH/any/${topicSuffix}`, payload);

            // Assert
            expect(result.warnings.some(w => w.includes(expectedWarning))).toBe(true);
            expect(result.messages).toEqual({});
        });
    });

    describe("Network Click Handling", () => {
        it("should return an ACK message for a valid new click request", () => {
            // Arrange
            service.updateLongClickConfig(mockLongClickConfig);
            service.processMessage("LSH/actor1/conf", { p: LshProtocol.DEVICE_DETAILS, dn: "actor1", ai: ["A1"], bi: [] });
            service.getDeviceRegistry()["actor1"].connected = true;
            const topic = "LSH/device-sender/misc";
            const payload = { p: LshProtocol.NETWORK_CLICK, bi: "B1", ct: ClickType.Long, c: false };

            // Act
            const result = service.processMessage(topic, payload);

            // Assert
            expect(result.messages[Output.Lsh]).toEqual({
                topic: "LSH/device-sender/IN",
                payload: { p: LshProtocol.NETWORK_CLICK_ACK, bi: "B1", ct: ClickType.Long },
            });
            expect(result.logs.some(log => log.includes("Validation OK"))).toBe(true);
        });

        it("should execute click logic upon receiving a valid confirmation", () => {
            // Arrange
            service.updateLongClickConfig(mockLongClickConfig);
            service.processMessage("LSH/actor1/conf", { p: LshProtocol.DEVICE_DETAILS, dn: "actor1", ai: ["A1"], bi: [] });
            service.getDeviceRegistry()["actor1"].connected = true;
            service.processMessage("LSH/device-sender/misc", { p: LshProtocol.NETWORK_CLICK, bi: "B1", ct: ClickType.Long, c: false });
            const topic = "LSH/device-sender/misc";
            const payload = { p: LshProtocol.NETWORK_CLICK, bi: "B1", ct: ClickType.Long, c: true };

            // Act
            const result = service.processMessage(topic, payload);

            // Assert
            expect(result.messages[Output.Lsh]).toEqual([
                {
                    topic: "LSH/actor1/IN",
                    payload: { p: "c_aas", as: [true] },
                },
            ]);
            expect(result.logs.some(log => log.includes("Click confirmed"))).toBe(true);
        });
    });

    describe("Watchdog", () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        it("should return a ServiceResult with pings for silent devices", () => {
            // Arrange
            service.updateLongClickConfig(mockLongClickConfig);
            service.processMessage("LSH/device-sender/state", { p: "d_as", as: [] });
            service.processMessage("LSH/actor1/conf", { p: LshProtocol.DEVICE_DETAILS, dn: "actor1", ai: ["A1"], bi: [] });
            const deviceRegistry = service.getDeviceRegistry();
            deviceRegistry["device-sender"].lastSeenTime = Date.now() - 4000;
            deviceRegistry["actor1"].lastSeenTime = Date.now() - 4000;

            // Act
            jest.advanceTimersByTime(4000); // Go past the 3s interrogate threshold
            const result = service.runWatchdogCheck();

            // Assert
            expect(result.messages[Output.Lsh]).toEqual({
                topic: mockServiceConfig.serviceTopic,
                payload: { p: 'd_p' }
            });
            expect(result.logs.some(log => log.includes("Preparing a single broadcast ping"))).toBe(true);
        });
    });
});