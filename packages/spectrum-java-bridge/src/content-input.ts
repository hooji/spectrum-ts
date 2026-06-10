import {
  attachment,
  type ContentInput,
  custom,
  edit,
  type Message,
  reaction,
  reply,
  richlink,
  text,
  typing,
  unsend,
  voice,
} from "spectrum-ts";
import z from "zod";

const binarySourceShape = {
  // Exactly one of these three sources must be present.
  dataBase64: z.string().optional(),
  path: z.string().optional(),
  url: z.url().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
};

const textInputSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
});

const attachmentInputSchema = z.object({
  type: z.literal("attachment"),
  ...binarySourceShape,
});

const voiceInputSchema = z.object({
  type: z.literal("voice"),
  ...binarySourceShape,
  duration: z.number().nonnegative().optional(),
});

const richlinkInputSchema = z.object({
  type: z.literal("richlink"),
  url: z.url(),
});

const reactionInputSchema = z.object({
  type: z.literal("reaction"),
  emoji: z.string().min(1),
  targetMessageId: z.string().min(1),
});

const targetedInputSchema = z.object({
  type: z.enum(["reply", "edit"]),
  content: z.record(z.string(), z.unknown()),
  targetMessageId: z.string().min(1),
});

const unsendInputSchema = z.object({
  type: z.literal("unsend"),
  targetMessageId: z.string().min(1),
});

const typingInputSchema = z.object({
  type: z.literal("typing"),
  state: z.enum(["start", "stop"]).default("start"),
});

const customInputSchema = z.object({
  type: z.literal("custom"),
  data: z.unknown(),
});

const contentInputSchema = z.discriminatedUnion("type", [
  textInputSchema,
  attachmentInputSchema,
  voiceInputSchema,
  richlinkInputSchema,
  reactionInputSchema,
  targetedInputSchema,
  unsendInputSchema,
  typingInputSchema,
  customInputSchema,
]);

export type WireContentInput = z.infer<typeof contentInputSchema>;

type BinarySource = z.infer<z.ZodObject<typeof binarySourceShape>>;

export interface ContentResolveContext {
  resolveMessage(id: string): Promise<Message>;
}

const resolveBinarySource = (
  input: BinarySource,
  kind: string
): string | URL | Buffer => {
  if (input.dataBase64 !== undefined) {
    return Buffer.from(input.dataBase64, "base64");
  }
  if (input.path !== undefined) {
    return input.path;
  }
  if (input.url !== undefined) {
    return new URL(input.url);
  }
  throw new Error(
    `${kind} content requires one of "dataBase64", "path", or "url"`
  );
};

const buildAttachment = (
  input: z.infer<typeof attachmentInputSchema>
): ContentInput =>
  attachment(resolveBinarySource(input, "attachment"), {
    mimeType: input.mimeType,
    name: input.name,
  });

const buildVoice = (input: z.infer<typeof voiceInputSchema>): ContentInput =>
  voice(resolveBinarySource(input, "voice"), {
    duration: input.duration,
    mimeType: input.mimeType,
    name: input.name,
  });

/**
 * Maps one wire-format content descriptor (the JSON a bridge client sends)
 * onto the corresponding spectrum-ts content builder. Message targets are
 * resolved through `ctx` (registry first, then `space.getMessage`).
 */
export const parseContentInput = async (
  raw: unknown,
  ctx: ContentResolveContext
): Promise<ContentInput> => {
  const input = contentInputSchema.parse(raw);
  switch (input.type) {
    case "text":
      return text(input.text);
    case "attachment":
      return buildAttachment(input);
    case "voice":
      return buildVoice(input);
    case "richlink":
      return richlink(input.url);
    case "reaction":
      return reaction(
        input.emoji,
        await ctx.resolveMessage(input.targetMessageId)
      );
    case "reply":
      return reply(
        await parseContentInput(input.content, ctx),
        await ctx.resolveMessage(input.targetMessageId)
      );
    case "edit":
      return edit(
        await parseContentInput(input.content, ctx),
        await ctx.resolveMessage(input.targetMessageId)
      );
    case "unsend":
      return unsend(await ctx.resolveMessage(input.targetMessageId));
    case "typing":
      return typing(input.state);
    case "custom":
      return custom(input.data);
    default:
      throw new Error("unsupported content input");
  }
};
