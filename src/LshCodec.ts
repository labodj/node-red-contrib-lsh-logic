import { decode, encode } from "@msgpack/msgpack";

/**
 * Supported serialization protocols.
 */
export type Protocol = "json" | "msgpack";
export type DecodeProtocol = Protocol | "text" | "auto";

/**
 * Handles the encoding and decoding of messages between the node and devices.
 * Centralizes the logic for handling different protocols (JSON vs MsgPack).
 */
export class LshCodec {
  /**
   * Decodes an incoming payload.
   * Automatically detects MsgPack (Buffer) vs JSON (Object/String).
   *
   * @param payload - The raw payload from the Node-RED message.
   * @returns The decoded JavaScript object.
   * @throws Error if decoding fails.
   */
  public decode(payload: unknown, protocol: DecodeProtocol = "auto"): unknown {
    if (Buffer.isBuffer(payload)) {
      if (protocol === "msgpack" || protocol === "auto") {
        try {
          return decode(payload);
        } catch (error) {
          const text = payload.toString("utf8");
          if (this.isTextPayload(text)) {
            return this.decodeText(text);
          }
          throw error;
        }
      }
      return this.decodeText(payload.toString("utf8"));
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

  private isTextPayload(payload: string): boolean {
    return (
      payload.length === 0 || (!payload.includes("\uFFFD") && /^[\t\n\r\x20-\x7E]*$/.test(payload))
    );
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
