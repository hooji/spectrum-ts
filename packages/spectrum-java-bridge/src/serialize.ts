import type { Content, Message, Space, User } from "spectrum-ts";
import type { JsonObject, JsonValue } from "./protocol";

// Reaction/reply/edit targets are serialized one level deep; anything nested
// further collapses to an `{ id }` reference the client can resolve via the
// message registry.
const MAX_TARGET_DEPTH = 1;

// Generic fallback serialization stops descending here so cyclic or deeply
// nested provider extras cannot blow up the frame.
const MAX_GENERIC_DEPTH = 4;

const isJsonPrimitive = (
  value: unknown
): value is string | number | boolean | null =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

// Best-effort projection of an arbitrary value into JSON: primitives pass
// through, dates become ISO strings, functions/binary/cycles are dropped.
const toJsonSafe = (value: unknown, depth: number): JsonValue | undefined => {
  if (isJsonPrimitive(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= MAX_GENERIC_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const safe = toJsonSafe(item, depth + 1);
      if (safe !== undefined) {
        items.push(safe);
      }
    }
    return items;
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const safe = toJsonSafe(entry, depth + 1);
      if (safe !== undefined) {
        out[key] = safe;
      }
    }
    return out;
  }
  return;
};

const serializeSender = (sender: User | undefined): JsonValue => {
  if (!sender) {
    return null;
  }
  const out: JsonObject = { id: sender.id };
  if (sender.kind) {
    out.kind = sender.kind;
  }
  return out;
};

export const serializeSpace = (space: Space): JsonObject => {
  const out: JsonObject = { id: space.id, platform: space.__platform };
  // Surface provider extras (e.g. iMessage's `type`/`phone`) when they are
  // plain JSON primitives; methods and complex internals stay behind.
  for (const [key, value] of Object.entries(space)) {
    if (key === "id" || key === "__platform") {
      continue;
    }
    if (isJsonPrimitive(value) && value !== null) {
      out[key] = value;
    }
  }
  return out;
};

const serializeTarget = async (
  target: Message,
  depth: number
): Promise<JsonObject> => {
  if (depth >= MAX_TARGET_DEPTH) {
    return { id: target.id };
  }
  return await serializeMessage(target, depth + 1);
};

const serializeWrapped = async (
  content: Extract<Content, { type: "reply" | "edit" }>,
  depth: number
): Promise<JsonObject> => ({
  type: content.type,
  content: await serializeContent(content.content as Content, depth),
  target: await serializeTarget(content.target, depth),
});

const serializeBinaryMeta = (content: {
  type: string;
  name?: string;
  mimeType: string;
  size?: number;
}): JsonObject => {
  const out: JsonObject = { type: content.type, mimeType: content.mimeType };
  if (content.name !== undefined) {
    out.name = content.name;
  }
  if (content.size !== undefined) {
    out.size = content.size;
  }
  return out;
};

export const serializeContent = async (
  content: Content,
  depth = 0
): Promise<JsonObject> => {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "attachment":
      return { ...serializeBinaryMeta(content), id: content.id };
    case "voice": {
      const out = serializeBinaryMeta(content);
      if (content.duration !== undefined) {
        out.duration = content.duration;
      }
      return out;
    }
    case "reaction":
      return {
        type: "reaction",
        emoji: content.emoji,
        target: await serializeTarget(content.target, depth),
      };
    case "reply":
    case "edit":
      return await serializeWrapped(content, depth);
    case "unsend":
      return {
        type: "unsend",
        target: await serializeTarget(content.target, depth),
      };
    case "group": {
      const items: JsonValue[] = [];
      for (const item of content.items) {
        items.push(await serializeMessage(item, depth + 1));
      }
      return { type: "group", items };
    }
    case "richlink":
      return {
        type: "richlink",
        url: content.url,
        title: (await content.title()) ?? null,
        summary: (await content.summary()) ?? null,
      };
    default:
      return (toJsonSafe(content, 0) ?? { type: content.type }) as JsonObject;
  }
};

export const serializeMessage = async (
  message: Message,
  depth = 0
): Promise<JsonObject> => ({
  id: message.id,
  platform: message.platform,
  direction: message.direction,
  timestamp: message.timestamp.toISOString(),
  spaceId: message.space.id,
  sender: serializeSender(message.sender),
  content: await serializeContent(message.content, depth),
});
