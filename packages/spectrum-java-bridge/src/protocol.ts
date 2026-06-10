import z from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export const BRIDGE_PROTOCOL_VERSION = 1;

/** Sent once on connect so clients can sanity-check compatibility. */
export interface HelloFrame {
  bridge: "spectrum-java-bridge";
  kind: "hello";
  platforms: string[];
  protocol: number;
}

/** One inbound `[space, message]` tuple from `spectrum.messages`. */
export interface MessageFrame {
  kind: "message";
  message: JsonObject;
  space: JsonObject;
}

export interface ResponseFrame {
  error?: string;
  id: number;
  kind: "response";
  ok: boolean;
  result?: JsonValue;
}

export type ServerFrame = HelloFrame | MessageFrame | ResponseFrame;

export const requestFrameSchema = z.object({
  kind: z.literal("request"),
  id: z.number().int(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type RequestFrame = z.infer<typeof requestFrameSchema>;
