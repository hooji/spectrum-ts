import { afterEach, describe, expect, it } from "bun:test";
import { Spectrum } from "spectrum-ts";
import type { JsonObject } from "../src/protocol";
import { type BridgeHandle, startBridge } from "../src/server";
import { createMockPlatform, type MockPlatformHarness } from "./mock-platform";

const FRAME_TIMEOUT_MS = 5000;

interface TestClient {
  close(): void;
  next(): Promise<JsonObject>;
  request(method: string, params: JsonObject): Promise<JsonObject>;
}

const connectClient = (handle: BridgeHandle): Promise<TestClient> =>
  new Promise((resolveClient, rejectClient) => {
    const ws = new WebSocket(`ws://${handle.hostname}:${handle.port}/ws`);
    const frames: JsonObject[] = [];
    const waiters: ((frame: JsonObject) => void)[] = [];
    const pending = new Map<number, (frame: JsonObject) => void>();
    let requestId = 0;

    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as JsonObject;
      if (frame.kind === "response") {
        pending.get(frame.id as number)?.(frame);
        pending.delete(frame.id as number);
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        frames.push(frame);
      }
    });
    ws.addEventListener("error", () => rejectClient(new Error("ws error")));
    ws.addEventListener("open", () => {
      resolveClient({
        close: () => ws.close(),
        next: () =>
          new Promise<JsonObject>((resolve, reject) => {
            const buffered = frames.shift();
            if (buffered) {
              resolve(buffered);
              return;
            }
            const timer = setTimeout(
              () => reject(new Error("timed out waiting for frame")),
              FRAME_TIMEOUT_MS
            );
            waiters.push((frame) => {
              clearTimeout(timer);
              resolve(frame);
            });
          }),
        request: (method, params) =>
          new Promise<JsonObject>((resolve, reject) => {
            requestId += 1;
            const id = requestId;
            const timer = setTimeout(
              () => reject(new Error(`timed out waiting for response ${id}`)),
              FRAME_TIMEOUT_MS
            );
            pending.set(id, (frame) => {
              clearTimeout(timer);
              resolve(frame);
            });
            ws.send(JSON.stringify({ id, kind: "request", method, params }));
          }),
      });
    });
  });

describe("spectrum java bridge", () => {
  let handle: BridgeHandle | undefined;
  let client: TestClient | undefined;

  const setup = async (): Promise<{
    client: TestClient;
    mock: MockPlatformHarness;
  }> => {
    const mock = createMockPlatform();
    const app = await Spectrum({
      providers: [mock.platform.config({})],
    });
    handle = startBridge({ app, port: 0 });
    client = await connectClient(handle);
    return { client, mock };
  };

  afterEach(async () => {
    client?.close();
    client = undefined;
    await handle?.stop();
    handle = undefined;
  });

  it("sends a hello frame with the platform list on connect", async () => {
    const { client: ws } = await setup();
    const hello = await ws.next();
    expect(hello.kind).toBe("hello");
    expect(hello.protocol).toBe(1);
    expect(hello.platforms).toEqual(["Mock"]);
  });

  it("delivers inbound messages as message frames", async () => {
    const { client: ws, mock } = await setup();
    await ws.next(); // hello
    const id = mock.pushInboundText("space-1", "hi there");
    const frame = await ws.next();
    expect(frame.kind).toBe("message");
    const space = frame.space as JsonObject;
    const message = frame.message as JsonObject;
    expect(space.id).toBe("space-1");
    expect(space.platform).toBe("Mock");
    expect(message.id).toBe(id);
    expect(message.direction).toBe("inbound");
    expect(message.content).toEqual({ text: "hi there", type: "text" });
    expect((message.sender as JsonObject).id).toBe("user-1");
  });

  it("routes send requests to the provider and returns sent messages", async () => {
    const { client: ws, mock } = await setup();
    await ws.next(); // hello
    mock.pushInboundText("space-1", "hello");
    await ws.next(); // make the space addressable

    const response = await ws.request("send", {
      content: [{ text: "hi from java", type: "text" }],
      spaceId: "space-1",
    });
    expect(response.ok).toBe(true);
    const messages = (response.result as JsonObject).messages as JsonObject[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toEqual({
      text: "hi from java",
      type: "text",
    });
    expect(messages[0]?.direction).toBe("outbound");
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]).toEqual({ text: "hi from java", type: "text" });
  });

  it("supports reply and react against a registered message", async () => {
    const { client: ws, mock } = await setup();
    await ws.next(); // hello
    const inboundId = mock.pushInboundText("space-1", "react to me");
    await ws.next();

    const replyResponse = await ws.request("reply", {
      content: [{ text: "pong", type: "text" }],
      messageId: inboundId,
    });
    expect(replyResponse.ok).toBe(true);

    const reactResponse = await ws.request("react", {
      emoji: "👍",
      messageId: inboundId,
    });
    expect(reactResponse.ok).toBe(true);
    const reactionMessages = (reactResponse.result as JsonObject)
      .messages as JsonObject[];
    const reactionContent = reactionMessages[0]?.content as JsonObject;
    expect(reactionContent.type).toBe("reaction");
    expect(reactionContent.emoji).toBe("👍");
    expect((reactionContent.target as JsonObject).id).toBe(inboundId);

    expect(mock.sent.map((c) => c.type)).toEqual(["reply", "reaction"]);
  });

  it("round-trips attachment bytes via readAttachment", async () => {
    const { client: ws, mock } = await setup();
    await ws.next(); // hello
    const bytes = Buffer.from("attachment-bytes");
    const id = mock.pushInboundAttachment("space-1", bytes, "blob.bin");
    const frame = await ws.next();
    expect((frame.message as JsonObject).id).toBe(id);

    const response = await ws.request("readAttachment", { messageId: id });
    expect(response.ok).toBe(true);
    const result = response.result as JsonObject;
    expect(result.name).toBe("blob.bin");
    expect(Buffer.from(result.dataBase64 as string, "base64").toString()).toBe(
      "attachment-bytes"
    );
  });

  it("rejects requests against unknown spaces with an error response", async () => {
    const { client: ws } = await setup();
    await ws.next(); // hello
    const response = await ws.request("send", {
      content: [{ text: "nope", type: "text" }],
      spaceId: "missing",
    });
    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain('unknown space "missing"');
  });

  it("holds and releases responding via begin/end", async () => {
    const { client: ws, mock } = await setup();
    await ws.next(); // hello
    mock.pushInboundText("space-1", "hello");
    await ws.next();

    const begin = await ws.request("respondingBegin", { spaceId: "space-1" });
    expect(begin.ok).toBe(true);
    const end = await ws.request("respondingEnd", { spaceId: "space-1" });
    expect(end.ok).toBe(true);
  });
});
