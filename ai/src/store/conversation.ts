/**
 * Small rules every conversation store shares: a new empty conversation, the
 * id shape a store accepts, newest-first order, and a conversation's size as
 * UTF-8 bytes of its JSON.
 */
import { randomUUID } from "node:crypto";
import type { Conversation, ConversationSummary } from "./types.ts";

/** A conversation with nothing said yet. */
export const newConversation = (): Conversation => ({
  id: randomUUID(),
  title: "New chat",
  updatedAt: Date.now(),
  messages: [],
});

/**
 * The ids a store accepts for a reader and for a conversation: letters,
 * digits, `_` and `-`, up to 128. It is the one rule that keeps either out
 * of a path (`..`, `/`, `\`, a drive letter, a NUL) and out of a file name
 * that means something else.
 */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
export const isSafeKey = (value: unknown): value is string =>
  typeof value === "string" && SAFE_KEY.test(value);

export const newestFirst = (
  a: ConversationSummary,
  b: ConversationSummary,
): number => b.updatedAt - a.updatedAt;

export function assertSafe(reader: string, id: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
  if (!isSafeKey(id)) throw new Error("That conversation id cannot be stored.");
}

const encoder = new TextEncoder();
export const bytesOf = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).byteLength;
