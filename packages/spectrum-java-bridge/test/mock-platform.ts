import { randomUUID } from "node:crypto";
import {
  attachment,
  type Content,
  definePlatform,
  type PlatformProviderConfig,
  type ProviderMessage,
} from "spectrum-ts";
import z from "zod";

type MockInbound = ProviderMessage<{ id: string }, { id: string }>;

interface Queue<T> {
  close(): void;
  iter: AsyncIterable<T>;
  push(value: T): void;
}

// Minimal push queue: a pending next() resolves via push() or close(); the
// iterator's return() closes it so Spectrum's stop() can cancel a parked read.
const makeQueue = <T>(): Queue<T> => {
  const buffer: T[] = [];
  const waiters: ((r: IteratorResult<T>) => void)[] = [];
  let closed = false;
  const drain = () => {
    while (waiters.length > 0) {
      waiters.shift()?.({ done: true, value: undefined as never });
    }
  };
  return {
    close() {
      closed = true;
      drain();
    },
    iter: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (closed && buffer.length === 0) {
              return Promise.resolve({ done: true, value: undefined as never });
            }
            const buffered = buffer.shift();
            if (buffered !== undefined) {
              return Promise.resolve({ done: false, value: buffered });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<T>> {
            closed = true;
            drain();
            return Promise.resolve({ done: true, value: undefined as never });
          },
        };
      },
    },
    push(value: T) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
      } else {
        buffer.push(value);
      }
    },
  };
};

export interface MockPlatformHarness {
  /** When true, every text send is echoed back as an inbound `echo: <text>`. */
  echo: { enabled: boolean };
  platform: {
    config: (config: Record<string, never>) => PlatformProviderConfig;
  };
  pushInboundAttachment(spaceId: string, bytes: Buffer, name: string): string;
  pushInboundText(spaceId: string, messageText: string, id?: string): string;
  /** Everything the provider's send action received, in order. */
  sent: Content[];
}

export const createMockPlatform = (name = "Mock"): MockPlatformHarness => {
  const queue = makeQueue<MockInbound>();
  const sent: Content[] = [];
  const echo = { enabled: false };

  const pushInbound = (spaceId: string, content: Content, id?: string) => {
    const messageId = id ?? randomUUID();
    queue.push({
      content,
      id: messageId,
      sender: { id: "user-1" },
      space: { id: spaceId },
      timestamp: new Date(),
    });
    return messageId;
  };

  const platform = definePlatform(name, {
    config: z.object({}),
    lifecycle: {
      createClient: () => Promise.resolve({}),
      destroyClient: () => {
        queue.close();
        return Promise.resolve();
      },
    },
    messages: () => queue.iter,
    send: async ({ space, content }) => {
      sent.push(content);
      // Echo both bare text and the text inside a reply wrapper.
      let echoSource: string | undefined;
      if (content.type === "text") {
        echoSource = content.text;
      } else if (content.type === "reply" && content.content.type === "text") {
        echoSource = content.content.text;
      }
      if (echo.enabled && echoSource !== undefined) {
        pushInbound(space.id, {
          text: `echo: ${echoSource}`,
          type: "text",
        });
      }
      return await Promise.resolve({
        content,
        id: randomUUID(),
        space: { id: space.id },
        timestamp: new Date(),
      });
    },
    space: {
      create: ({ input }) =>
        Promise.resolve({ id: input.users[0]?.id ?? "s1" }),
    },
    user: { resolve: ({ input }) => Promise.resolve({ id: input.userID }) },
  });

  return {
    echo,
    // The full generic Platform type is irrelevant to the harness; expose
    // just the config factory shape Spectrum's providers array needs.
    platform: platform as unknown as MockPlatformHarness["platform"],
    pushInboundAttachment: (spaceId, bytes, attachmentName) => {
      const builder = attachment(bytes, {
        mimeType: "application/octet-stream",
        name: attachmentName,
      });
      const id = randomUUID();
      builder.build().then((content) => pushInbound(spaceId, content, id));
      return id;
    },
    pushInboundText: (spaceId, messageText, id) =>
      pushInbound(spaceId, { text: messageText, type: "text" }, id),
    sent,
  };
};
