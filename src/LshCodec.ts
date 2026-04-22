import { decode, encode } from "@msgpack/msgpack";

/**
 * Supported serialization protocols.
 */
export type Protocol = "json" | "msgpack";
export type DecodeProtocol = Protocol | "text";

/**
 * Handles the encoding and decoding of messages between the node and devices.
 * Centralizes the logic for handling different protocols (JSON vs MsgPack).
 */
export class LshCodec {
  /**
   * Decodes an incoming payload.
   * Buffer payloads must be decoded using the explicit transport protocol
   * selected by the caller. Requiring the protocol at the API boundary keeps
   * future call sites from accidentally falling back to the text path.
   *
   * @param payload - The raw payload from the Node-RED message.
   * @param protocol - The transport protocol expected for this MQTT topic.
   * @returns The decoded JavaScript object.
   * @throws Error if decoding fails.
   */
  public decode(payload: unknown, protocol: DecodeProtocol): unknown {
    if (Buffer.isBuffer(payload)) {
      if (protocol === "msgpack") {
        return decode(payload);
      }

      return this.decodeText(payload.toString("utf8"));
    }

    if (protocol === "msgpack") {
      throw new Error("MsgPack payloads must arrive as Buffers.");
    }

    // It's not a buffer. Node-RED 'mqtt in' node automatically parses JSON
    // to Object if configured to do so, or returns string.
    if (typeof payload === "object" && payload !== null) {
      return payload;
    }

    if (typeof payload === "string") {
      return this.decodeText(payload);
    }

    return payload;
  }

  private decodeText(payload: string): unknown {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }

  /**
   * Encodes a payload for transmission based on the configured protocol.
   *
   * @param payload - The JavaScript object to encode.
   * @param protocol - The target protocol ('json' or 'msgpack').
   * @returns A Buffer (for MsgPack) or the original Object (for JSON to be handled by Node-RED).
   */
  public encode<T>(payload: T, protocol: "msgpack"): Buffer;
  public encode<T>(payload: T, protocol: "json"): T;
  public encode<T>(payload: T, protocol: Protocol): Buffer | T;
  public encode<T>(payload: T, protocol: Protocol): Buffer | T {
    if (protocol === "msgpack") {
      // Encode to Uint8Array and convert to Buffer for Node-RED.
      return Buffer.from(encode(payload));
    }

    // For JSON we return the object and let mqtt-out handle serialization.
    return payload;
  }
}
