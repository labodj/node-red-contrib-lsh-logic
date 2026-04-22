import { LshCodec } from "../LshCodec";
import { encode } from "@msgpack/msgpack";

describe("LshCodec", () => {
  const codec = new LshCodec();

  describe("decode", () => {
    it("decodes a MsgPack buffer when explicitly treated as msgpack", () => {
      const data = { p: 1, n: "device1" };
      const buffer = Buffer.from(encode(data));

      expect(codec.decode(buffer, "msgpack")).toEqual(data);
    });

    it("decodes a JSON buffer when explicitly treated as text", () => {
      expect(codec.decode(Buffer.from('{"foo":"bar"}'), "text")).toEqual({
        foo: "bar",
      });
    });

    it("throws when an explicitly MsgPack buffer actually contains JSON text", () => {
      expect(() => codec.decode(Buffer.from('{"p":5}'), "msgpack")).toThrow();
    });

    it("throws when a non-text buffer cannot be decoded as MsgPack", () => {
      expect(() => codec.decode(Buffer.from([0xc1]), "msgpack")).toThrow();
    });

    it("throws when MsgPack mode receives a string payload", () => {
      expect(() => codec.decode('{"p":5}', "msgpack")).toThrow(
        "MsgPack payloads must arrive as Buffers.",
      );
    });

    it("throws when MsgPack mode receives an already-parsed object payload", () => {
      expect(() => codec.decode({ p: 5 }, "msgpack")).toThrow(
        "MsgPack payloads must arrive as Buffers.",
      );
    });

    it("parses a JSON string", () => {
      expect(codec.decode('{"foo":"bar"}', "text")).toEqual({ foo: "bar" });
    });

    it("returns a plain string as-is when it is not valid JSON", () => {
      expect(codec.decode("hello world", "text")).toBe("hello world");
    });

    it("returns non-string primitive payloads unchanged", () => {
      expect(codec.decode(123, "text")).toBe(123);
      expect(codec.decode(null, "text")).toBeNull();
    });
  });

  describe("encode", () => {
    it("encodes an object to Buffer when protocol is msgpack", () => {
      const data = { p: 1, n: "test" };
      const result = codec.encode(data, "msgpack");

      expect(Buffer.isBuffer(result)).toBe(true);
      expect(codec.decode(result, "msgpack")).toEqual(data);
    });

    it("returns the object unchanged when protocol is json", () => {
      const data = { p: 1, n: "test" };

      expect(codec.encode(data, "json")).toBe(data);
    });
  });
});
