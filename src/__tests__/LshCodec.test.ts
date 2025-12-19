import { LshCodec } from "../LshCodec";
import { encode } from "@msgpack/msgpack";

describe("LshCodec", () => {
    let codec: LshCodec;

    beforeEach(() => {
        codec = new LshCodec();
    });

    describe("decode", () => {
        it("should decode a MsgPack buffer", () => {
            const data = { p: 1, n: "device1" };
            const buffer = Buffer.from(encode(data));
            const decoded = codec.decode(buffer);
            expect(decoded).toEqual(data);
        });

        it("should return object if it is already an object", () => {
            const data = { foo: "bar" };
            const decoded = codec.decode(data);
            expect(decoded).toBe(data);
        });

        it("should parse JSON string", () => {
            const data = { foo: "bar" };
            const json = JSON.stringify(data);
            const decoded = codec.decode(json);
            expect(decoded).toEqual(data);
        });

        it("should return string as-is if not valid JSON", () => {
            const str = "hello world";
            const decoded = codec.decode(str);
            expect(decoded).toBe(str);
        });
    });

    describe("encode", () => {
        it("should encode object to Buffer when protocol is msgpack", () => {
            const data = { p: 1, n: "test" };
            const result = codec.encode(data, "msgpack");
            expect(Buffer.isBuffer(result)).toBe(true);
            const decodedBack = codec.decode(result);
            expect(decodedBack).toEqual(data);
        });

        it("should return object as-is when protocol is json", () => {
            const data = { p: 1, n: "test" };
            const result = codec.encode(data, "json");
            expect(result).toBe(data);
        });
    });
});
