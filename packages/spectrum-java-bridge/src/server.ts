import { createLogger } from "@photon-ai/otel";
import { type ServerWebSocket, serve } from "bun";
import type {
  Attachment,
  Content,
  ContentInput,
  Message,
  Space,
  SpectrumInstance,
  Voice,
} from "spectrum-ts";
import z from "zod";
import { parseContentInput } from "./content-input";
import type {
  HelloFrame,
  JsonObject,
  JsonValue,
  RequestFrame,
} from "./protocol";
import { BRIDGE_PROTOCOL_VERSION, requestFrameSchema } from "./protocol";
import { BridgeRegistry } from "./registry";
import { serializeMessage, serializeSpace } from "./serialize";

const log = createLogger("spectrum.java-bridge");

// Inbound frames buffered while no client is connected; oldest dropped first.
const EVENT_BACKLOG_CAPACITY = 1000;

export interface BridgeOptions {
  app: SpectrumInstance;
  host?: string;
  port?: number;
}

export interface BridgeHandle {
  hostname: string;
  port: number;
  /** Closes the server and stops the Spectrum instance. */
  stop(): Promise<void>;
}

const spaceParamsSchema = z.object({ spaceId: z.string().min(1) });

const messageParamsSchema = z.object({ messageId: z.string().min(1) });

const sendParamsSchema = z.object({
  spaceId: z.string().min(1),
  content: z.array(z.record(z.string(), z.unknown())).min(1),
});

const replyParamsSchema = z.object({
  messageId: z.string().min(1),
  content: z.array(z.record(z.string(), z.unknown())).min(1),
});

const reactParamsSchema = z.object({
  messageId: z.string().min(1),
  emoji: z.string().min(1),
});

const editParamsSchema = z.object({
  messageId: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
});

const renameParamsSchema = z.object({
  spaceId: z.string().min(1),
  displayName: z.string().min(1),
});

const getMessageParamsSchema = z.object({
  spaceId: z.string().min(1),
  messageId: z.string().min(1),
});

const readAttachmentParamsSchema = z.object({
  messageId: z.string().min(1),
  attachmentId: z.string().optional(),
});

type BinaryContent = Attachment | Voice;

// Walk a message's content tree for binary content (attachment/voice). When
// `attachmentId` is given, only an attachment with that id matches; otherwise
// the first binary part wins.
const findBinaryContent = (
  content: Content,
  attachmentId: string | undefined
): BinaryContent | undefined => {
  if (content.type === "attachment") {
    if (attachmentId === undefined || content.id === attachmentId) {
      return content;
    }
    return;
  }
  if (content.type === "voice") {
    return attachmentId === undefined ? content : undefined;
  }
  if (content.type === "reply" || content.type === "edit") {
    return findBinaryContent(content.content as Content, attachmentId);
  }
  if (content.type === "group") {
    for (const item of content.items) {
      const found = findBinaryContent(item.content, attachmentId);
      if (found) {
        return found;
      }
    }
  }
  return;
};

interface RespondingHold {
  count: number;
  release: () => void;
}

class BridgeCore {
  readonly registry = new BridgeRegistry();
  private readonly respondingHolds = new Map<string, RespondingHold>();

  private requireSpace(spaceId: string): Space {
    const space = this.registry.getSpace(spaceId);
    if (!space) {
      throw new Error(
        `unknown space "${spaceId}" — spaces become addressable after their first inbound message`
      );
    }
    return space;
  }

  private requireMessage(messageId: string): Message {
    const message = this.registry.getMessage(messageId);
    if (!message) {
      throw new Error(
        `unknown message "${messageId}" — it may have been evicted from the bridge registry`
      );
    }
    return message;
  }

  private async resolveMessage(messageId: string): Promise<Message> {
    return await Promise.resolve(this.requireMessage(messageId));
  }

  private async parseContents(raw: unknown[]): Promise<ContentInput[]> {
    const ctx = { resolveMessage: (id: string) => this.resolveMessage(id) };
    const contents: ContentInput[] = [];
    for (const entry of raw) {
      contents.push(await parseContentInput(entry, ctx));
    }
    return contents;
  }

  private async serializeSent(
    sent: (Message | undefined)[]
  ): Promise<JsonObject> {
    const messages: JsonValue[] = [];
    for (const message of sent) {
      if (!message) {
        continue;
      }
      this.registry.registerMessage(message);
      messages.push(await serializeMessage(message));
    }
    return { messages };
  }

  async send(params: unknown): Promise<JsonValue> {
    const { spaceId, content } = sendParamsSchema.parse(params);
    const space = this.requireSpace(spaceId);
    const sent: (Message | undefined)[] = [];
    for (const input of await this.parseContents(content)) {
      sent.push(await space.send(input));
    }
    return await this.serializeSent(sent);
  }

  async reply(params: unknown): Promise<JsonValue> {
    const { messageId, content } = replyParamsSchema.parse(params);
    const target = this.requireMessage(messageId);
    const sent: (Message | undefined)[] = [];
    for (const input of await this.parseContents(content)) {
      sent.push(await target.reply(input));
    }
    return await this.serializeSent(sent);
  }

  async react(params: unknown): Promise<JsonValue> {
    const { messageId, emoji } = reactParamsSchema.parse(params);
    const sent = await this.requireMessage(messageId).react(emoji);
    return await this.serializeSent([sent]);
  }

  async edit(params: unknown): Promise<JsonValue> {
    const { messageId, content } = editParamsSchema.parse(params);
    const target = this.requireMessage(messageId);
    const ctx = { resolveMessage: (id: string) => this.resolveMessage(id) };
    await target.edit(await parseContentInput(content, ctx));
    return {};
  }

  async unsend(params: unknown): Promise<JsonValue> {
    const { messageId } = messageParamsSchema.parse(params);
    await this.requireMessage(messageId).unsend();
    return {};
  }

  async getMessage(params: unknown): Promise<JsonValue> {
    const { spaceId, messageId } = getMessageParamsSchema.parse(params);
    const cached = this.registry.getMessage(messageId);
    const message =
      cached ?? (await this.requireSpace(spaceId).getMessage(messageId));
    if (!message) {
      return { message: null };
    }
    this.registry.registerMessage(message);
    return { message: await serializeMessage(message) };
  }

  async startTyping(params: unknown): Promise<JsonValue> {
    const { spaceId } = spaceParamsSchema.parse(params);
    await this.requireSpace(spaceId).startTyping();
    return {};
  }

  async stopTyping(params: unknown): Promise<JsonValue> {
    const { spaceId } = spaceParamsSchema.parse(params);
    await this.requireSpace(spaceId).stopTyping();
    return {};
  }

  async rename(params: unknown): Promise<JsonValue> {
    const { spaceId, displayName } = renameParamsSchema.parse(params);
    await this.requireSpace(spaceId).rename(displayName);
    return {};
  }

  async readAttachment(params: unknown): Promise<JsonValue> {
    const { messageId, attachmentId } =
      readAttachmentParamsSchema.parse(params);
    const message = this.requireMessage(messageId);
    const binary = findBinaryContent(message.content, attachmentId);
    if (!binary) {
      throw new Error(`message "${messageId}" carries no matching attachment`);
    }
    const bytes = await binary.read();
    return {
      dataBase64: bytes.toString("base64"),
      mimeType: binary.mimeType,
      name: binary.name ?? null,
    };
  }

  /**
   * `space.responding(fn)` is a scoped callback in TypeScript; over the wire
   * it becomes an explicit begin/end pair. Begin opens (or re-enters) a hold
   * backed by a promise handed to `space.responding`; end releases it once
   * the nesting count drops to zero.
   */
  async respondingBegin(params: unknown): Promise<JsonValue> {
    const { spaceId } = spaceParamsSchema.parse(params);
    const space = this.requireSpace(spaceId);
    const existing = this.respondingHolds.get(spaceId);
    if (existing) {
      existing.count += 1;
      return {};
    }
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.respondingHolds.set(spaceId, { count: 1, release });
    space
      .responding(() => done)
      .catch((error: unknown) => {
        log.warn("responding hold failed", { error: String(error), spaceId });
      });
    return await Promise.resolve({});
  }

  async respondingEnd(params: unknown): Promise<JsonValue> {
    const { spaceId } = spaceParamsSchema.parse(params);
    const hold = this.respondingHolds.get(spaceId);
    if (!hold) {
      return {};
    }
    hold.count -= 1;
    if (hold.count <= 0) {
      hold.release();
      this.respondingHolds.delete(spaceId);
    }
    return await Promise.resolve({});
  }

  releaseAllHolds(): void {
    for (const hold of this.respondingHolds.values()) {
      hold.release();
    }
    this.respondingHolds.clear();
  }

  async dispatch(method: string, params: unknown): Promise<JsonValue> {
    switch (method) {
      case "send":
        return await this.send(params);
      case "reply":
        return await this.reply(params);
      case "react":
        return await this.react(params);
      case "edit":
        return await this.edit(params);
      case "unsend":
        return await this.unsend(params);
      case "getMessage":
        return await this.getMessage(params);
      case "startTyping":
        return await this.startTyping(params);
      case "stopTyping":
        return await this.stopTyping(params);
      case "rename":
        return await this.rename(params);
      case "readAttachment":
        return await this.readAttachment(params);
      case "respondingBegin":
        return await this.respondingBegin(params);
      case "respondingEnd":
        return await this.respondingEnd(params);
      default:
        throw new Error(`unknown method "${method}"`);
    }
  }
}

const platformNames = (app: SpectrumInstance): string[] => {
  const internal = (
    app as unknown as {
      __internal?: { platforms?: Map<string, unknown> };
    }
  ).__internal;
  return internal?.platforms ? [...internal.platforms.keys()] : [];
};

export const startBridge = (options: BridgeOptions): BridgeHandle => {
  const { app } = options;
  const core = new BridgeCore();
  const clients = new Set<ServerWebSocket<unknown>>();
  const backlog: string[] = [];

  const hello: HelloFrame = {
    bridge: "spectrum-java-bridge",
    kind: "hello",
    platforms: platformNames(app),
    protocol: BRIDGE_PROTOCOL_VERSION,
  };

  const broadcast = (frame: string): void => {
    if (clients.size === 0) {
      backlog.push(frame);
      if (backlog.length > EVENT_BACKLOG_CAPACITY) {
        backlog.shift();
      }
      return;
    }
    for (const ws of clients) {
      ws.send(frame);
    }
  };

  const handleRequest = async (
    ws: ServerWebSocket<unknown>,
    request: RequestFrame
  ): Promise<void> => {
    try {
      const result = await core.dispatch(request.method, request.params ?? {});
      ws.send(
        JSON.stringify({ id: request.id, kind: "response", ok: true, result })
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          id: request.id,
          kind: "response",
          ok: false,
        })
      );
    }
  };

  const handleFrame = (
    ws: ServerWebSocket<unknown>,
    raw: string | Buffer
  ): void => {
    let request: RequestFrame;
    try {
      request = requestFrameSchema.parse(JSON.parse(raw.toString()));
    } catch (error) {
      log.warn("dropping malformed request frame", { error: String(error) });
      return;
    }
    handleRequest(ws, request).catch((error: unknown) => {
      log.warn("request handling failed", { error: String(error) });
    });
  };

  const server = serve({
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        return bunServer.upgrade(request)
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
    hostname: options.host ?? "127.0.0.1",
    port: options.port ?? 8787,
    websocket: {
      close(ws) {
        clients.delete(ws);
      },
      message(ws, raw) {
        handleFrame(ws, raw);
      },
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify(hello));
        while (backlog.length > 0) {
          const frame = backlog.shift();
          if (frame !== undefined) {
            ws.send(frame);
          }
        }
      },
    },
  });

  const pump = (async () => {
    for await (const [space, message] of app.messages) {
      core.registry.registerSpace(space);
      core.registry.registerMessage(message);
      broadcast(
        JSON.stringify({
          kind: "message",
          message: await serializeMessage(message),
          space: serializeSpace(space),
        })
      );
    }
  })();
  pump.catch((error: unknown) => {
    log.error("message pump failed", { error: String(error) });
  });

  log.info("bridge listening", {
    hostname: server.hostname,
    port: server.port,
  });

  return {
    hostname: server.hostname ?? "127.0.0.1",
    port: server.port ?? 0,
    async stop() {
      core.releaseAllHolds();
      await app.stop();
      await pump.catch(() => undefined);
      // `server.stop(true)` closes live websockets itself. Closing them
      // manually first makes Bun's stop promise hang forever (Bun 1.3.x).
      await server.stop(true);
    },
  };
};
