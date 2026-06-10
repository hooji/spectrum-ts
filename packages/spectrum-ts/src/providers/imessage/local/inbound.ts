import { setTimeout as sleep } from "node:timers/promises";
import type {
  IMessageSDK,
  Message as LocalIMessage,
} from "@photon-ai/imessage-kit";
import { asCustom } from "../../../content/custom";
import { reactionSchema } from "../../../content/reaction";
import { type ManagedStream, stream } from "../../../utils/stream";
import { TAPBACK_TO_EMOJI } from "../shared/tapbacks";
import type { IMessageMessage } from "../types";
import { localAttachmentContent } from "./attachments";

const ATTACHMENT_PLACEHOLDER = "\uFFFC";
const ATTACHMENT_JOIN_RETRY_DELAY_MS = 250;
const ATTACHMENT_JOIN_RETRY_LIMIT = 8;
const ATTACHMENT_JOIN_FETCH_LIMIT = 10;

// How many recent rows to scan when resolving a reaction's target message.
// Reactions usually land on recent messages; older targets fall back to a
// stub the user can resolve by id.
const REACTION_TARGET_LOOKUP_LIMIT = 50;

const hasAttachmentPlaceholder = (message: LocalIMessage): boolean =>
  message.text?.includes(ATTACHMENT_PLACEHOLDER) ?? false;

const isPendingAttachmentJoin = (message: LocalIMessage): boolean =>
  message.attachments.length === 0 &&
  (message.hasAttachments || hasAttachmentPlaceholder(message));

const refetchUntilAttachmentsSettle = async (
  client: IMessageSDK,
  message: LocalIMessage
): Promise<LocalIMessage> => {
  if (!message.chatId) {
    return message;
  }

  for (let attempt = 0; attempt < ATTACHMENT_JOIN_RETRY_LIMIT; attempt += 1) {
    await sleep(ATTACHMENT_JOIN_RETRY_DELAY_MS);
    let rows: readonly LocalIMessage[];
    try {
      rows = await client.getMessages({
        chatId: message.chatId,
        limit: ATTACHMENT_JOIN_FETCH_LIMIT,
        since: message.createdAt,
      });
    } catch {
      continue;
    }
    const refreshed = rows.find((row) => row.id === message.id);
    if (refreshed && !isPendingAttachmentJoin(refreshed)) {
      return refreshed;
    }
  }

  return message;
};

type LocalReaction = NonNullable<LocalIMessage["reaction"]>;
type LocalSpace = IMessageMessage["space"];

// Tapbacks map through the shared table; emoji reactions carry their own
// payload. Stickers and poll votes have no spectrum representation.
const localReactionEmoji = (reaction: LocalReaction): string | undefined => {
  if (reaction.kind === "emoji") {
    return reaction.emoji ?? undefined;
  }
  return TAPBACK_TO_EMOJI[reaction.kind];
};

// Look up the reacted-to row among the chat's recent messages and convert it
// with the regular pipeline so the target carries its real content.
const resolveReactionTarget = async (
  client: IMessageSDK,
  chatId: string,
  targetMessageId: string
): Promise<IMessageMessage | undefined> => {
  let rows: readonly LocalIMessage[];
  try {
    rows = await client.getMessages({
      chatId,
      excludeReactions: true,
      limit: REACTION_TARGET_LOOKUP_LIMIT,
    });
  } catch {
    return;
  }
  const row = rows.find((candidate) => candidate.id === targetMessageId);
  if (!row) {
    return;
  }
  const [converted] = await toMessages(row, client);
  return converted;
};

const toReactionMessages = async (
  client: IMessageSDK,
  message: LocalIMessage,
  reaction: LocalReaction,
  space: LocalSpace
): Promise<IMessageMessage[]> => {
  // Reaction removals have no spectrum representation yet; skip them like
  // the other unrepresentable rows.
  if (reaction.isRemoved) {
    return [];
  }
  const emoji = localReactionEmoji(reaction);
  const targetMessageId = reaction.targetMessageId;
  if (!(emoji && targetMessageId && message.participant)) {
    return [];
  }

  // When the target is no longer among the recent rows, fall back to an
  // id-bearing stub — core wraps nested raw records either way, mirroring
  // the terminal provider's reaction targets.
  const target = (await resolveReactionTarget(
    client,
    space.id,
    targetMessageId
  )) ?? {
    id: targetMessageId,
    content: asCustom({ imessage_type: "reaction-target", stub: true }),
    sender: { id: "" },
    space,
    timestamp: message.createdAt,
  };

  return [
    {
      id: message.id,
      content: reactionSchema.parse({ type: "reaction", emoji, target }),
      sender: { id: message.participant },
      space,
      timestamp: message.createdAt,
    },
  ];
};

export const toMessages = async (
  message: LocalIMessage,
  client: IMessageSDK
): Promise<IMessageMessage[]> => {
  const { chatId, chatKind } = message;
  if (!chatId || chatKind === "unknown") {
    return [];
  }

  // Tapback / emoji-reaction rows surface as first-class `reaction` content.
  if (message.reaction !== null) {
    return await toReactionMessages(client, message, message.reaction, {
      id: chatId,
      type: chatKind === "group" ? "group" : "dm",
      // Local mode has no concept of "which-of-my-phones"; phone is empty.
      phone: "",
    });
  }

  // Drop rows spectrum's Content union cannot faithfully represent: group
  // events and retracts would collapse to empty or Apple-generated
  // pseudo-text otherwise.
  if (message.kind !== "text" || message.retractedAt !== null) {
    return [];
  }

  if (isPendingAttachmentJoin(message)) {
    return [];
  }

  const base: Omit<IMessageMessage, "id" | "content"> = {
    sender: { id: message.participant ?? "" },
    // Local mode has no concept of "which-of-my-phones"; phone is empty.
    space: {
      id: chatId,
      type: chatKind === "group" ? "group" : "dm",
      phone: "",
    },
    timestamp: message.createdAt,
  };

  if (message.attachments.length > 0) {
    return Promise.all(
      message.attachments.map(async (att) => ({
        ...base,
        id: `${message.id}:${att.id}`,
        content: await localAttachmentContent(att),
      }))
    );
  }

  return [
    {
      ...base,
      id: message.id,
      content: { type: "text", text: message.text ?? "" },
    },
  ];
};

export const messages = (client: IMessageSDK): ManagedStream<IMessageMessage> =>
  stream((emit, end) => {
    let lastPromise: Promise<void> = Promise.resolve();

    const handleIncoming = async (message: LocalIMessage): Promise<void> => {
      const stableMessage = isPendingAttachmentJoin(message)
        ? await refetchUntilAttachmentsSettle(client, message)
        : message;
      const ms = await toMessages(stableMessage, client);
      for (const m of ms) {
        await emit(m);
      }
    };

    const startPromise = client
      .startWatching({
        onIncomingMessage: (message) => {
          lastPromise = lastPromise
            .then(() => handleIncoming(message))
            .catch(end);
        },
        onError: end,
      })
      .catch(end);

    return async () => {
      await startPromise.catch(() => {});
      await client.stopWatching();
      // The incoming callback is sync (returns undefined), so `stopWatching`
      // does not wait for the `lastPromise` chain: drain it explicitly to
      // avoid `emit`/attachment reads running past teardown.
      await lastPromise.catch(() => {});
    };
  });
