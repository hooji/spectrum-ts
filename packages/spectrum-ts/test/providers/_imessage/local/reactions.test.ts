import { describe, expect, it, mock } from "bun:test";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import type { Reaction } from "@/content/reaction";
import { toMessages } from "@/providers/imessage/local/inbound";

const CREATED_AT = new Date(1_700_000_000_000);

type LocalReaction = NonNullable<LocalIMessage["reaction"]>;

const row = (overrides: Partial<LocalIMessage> = {}): LocalIMessage =>
  ({
    id: "msg-1",
    chatId: "chat-1",
    chatKind: "dm",
    participant: "+15550100",
    text: "hello",
    kind: "text",
    reaction: null,
    retractedAt: null,
    createdAt: CREATED_AT,
    attachments: [],
    hasAttachments: false,
    ...overrides,
  }) as unknown as LocalIMessage;

const reactionPayload = (
  overrides: Partial<LocalReaction> = {}
): LocalReaction =>
  ({
    kind: "like",
    targetMessageId: "target-1",
    emoji: null,
    textRange: { location: 0, length: 5 },
    isRemoved: false,
    ...overrides,
  }) as LocalReaction;

const makeClient = (rows: LocalIMessage[] = []) => {
  const getMessages = mock(() => Promise.resolve(rows));
  return {
    client: { getMessages } as unknown as IMessageSDK,
    getMessages,
  };
};

describe("iMessage local inbound reactions", () => {
  it("maps a tapback row to reaction content with a resolved target", async () => {
    const targetRow = row({ id: "target-1", text: "original" });
    const { client, getMessages } = makeClient([targetRow]);

    const reactionRow = row({
      id: "reaction-1",
      reaction: reactionPayload(),
      text: 'Liked "original"',
    });
    const result = await toMessages(reactionRow, client);

    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    const message = result[0];
    expect(message?.id).toBe("reaction-1");
    expect(message?.sender).toEqual({ id: "+15550100" });
    const content = message?.content as Reaction;
    expect(content.type).toBe("reaction");
    expect(content.emoji).toBe("👍");
    expect(content.target.id).toBe("target-1");
    expect(content.target.content).toEqual({ type: "text", text: "original" });
  });

  it("uses the emoji payload for emoji-kind reactions", async () => {
    const { client } = makeClient([row({ id: "target-1" })]);
    const result = await toMessages(
      row({
        id: "reaction-2",
        reaction: reactionPayload({ kind: "emoji", emoji: "🦊" }),
      }),
      client
    );
    expect((result[0]?.content as Reaction).emoji).toBe("🦊");
  });

  it("falls back to a stub target when the target row is not found", async () => {
    const { client } = makeClient([]);
    const result = await toMessages(
      row({ id: "reaction-3", reaction: reactionPayload() }),
      client
    );
    expect(result).toHaveLength(1);
    const content = result[0]?.content as Reaction;
    expect(content.target.id).toBe("target-1");
    expect(content.target.content).toEqual({
      type: "custom",
      raw: { imessage_type: "reaction-target", stub: true },
    });
  });

  it("drops reaction removals", async () => {
    const { client } = makeClient();
    const result = await toMessages(
      row({ reaction: reactionPayload({ isRemoved: true }) }),
      client
    );
    expect(result).toEqual([]);
  });

  it("drops sticker and poll-vote rows", async () => {
    const { client } = makeClient();
    for (const kind of ["sticker", "pollVote"] as const) {
      const result = await toMessages(
        row({ reaction: reactionPayload({ kind }) }),
        client
      );
      expect(result).toEqual([]);
    }
  });

  it("still maps plain text rows", async () => {
    const { client, getMessages } = makeClient();
    const result = await toMessages(row(), client);
    expect(getMessages).not.toHaveBeenCalled();
    expect(result[0]?.content).toEqual({ type: "text", text: "hello" });
  });
});
