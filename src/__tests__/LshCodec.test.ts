import { LshCodec } from "../LshCodec";
import { encode } from "@msgpack/msgpack";

describe("LshCodec", () => {
  const codec = new LshCodec();

  describe("decode", () => {
    it("decodes a MsgPack buffer in auto mode", () => {
      const data = { p: 1, n: "device1" };
      const buffer = Buffer.from(encode(data));

      expect(codec.decode(buffer)).toEqual(data);
    });

    it("decodes a JSON buffer when explicitly treated as text", () => {
      expect(codec.decode(Buffer.from('{"foo":"bar"}'), "text")).toEqual({
        foo: "bar",
      });
    });

    it("falls back to text decoding when MsgPack decoding fails on a JSON buffer", () => {
      expect(codec.decode(Buffer.from('{"p":5}'), "msgpack")).toEqual({ p: 5 });
    });

    it("throws when a non-text buffer cannot be decoded as MsgPack", () => {
      expect(() => codec.decode(Buffer.from([0xc1]), "msgpack")).toThrow();
    });

    it("returns an object payload by reference", () => {
      const data = { foo: "bar" };

      expect(codec.decode(data)).toBe(data);
    });

    it("parses a JSON string", () => {
      expect(codec.decode('{"foo":"bar"}')).toEqual({ foo: "bar" });
    });

    it("returns a plain string as-is when it is not valid JSON", () => {
      expect(codec.decode("hello world")).toBe("hello world");
    });

    it("returns non-string primitive payloads unchanged", () => {
      expect(codec.decode(123)).toBe(123);
      expect(codec.decode(null)).toBeNull();
    });
  });

  describe("encode", () => {
    it("encodes an object to Buffer when protocol is msgpack", () => {
      const data = { p: 1, n: "test" };
      const result = codec.encode(data, "msgpack");

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(codec.decode(result)).toEqual(data);
    });

    it("returns the object unchanged when protocol is json", () => {
      const data = { p: 1, n: "test" };

      expect(codec.encode(data, "json")).toBe(data);
    });
  });
});
