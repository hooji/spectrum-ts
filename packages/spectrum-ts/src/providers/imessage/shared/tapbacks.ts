/**
 * Canonical tapback ↔ emoji mapping shared by the remote (gRPC) and local
 * (chat.db) iMessage paths, so a tapback surfaces as the same spectrum
 * `reaction` emoji regardless of transport.
 */
export type TapbackKind =
  | "love"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export const EMOJI_TO_TAPBACK: Readonly<Record<string, TapbackKind>> = {
  "❤️": "love",
  "👍": "like",
  "👎": "dislike",
  "😂": "laugh",
  "‼️": "emphasize",
  "❓": "question",
};

export const TAPBACK_TO_EMOJI: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(EMOJI_TO_TAPBACK).map(([emoji, kind]) => [kind, emoji])
  );
