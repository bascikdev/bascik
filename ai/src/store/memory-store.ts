/**
 * The conversation store that keeps everything in this process's memory,
 * one map per reader. For tests, demos, and a first try.
 */
import { assertSafe, isSafeKey, newestFirst } from "./conversation.ts";
import type { Conversation, ConversationStore } from "./types.ts";

/** Conversations in this process's memory: for tests, demos, and a first try. */
export function memoryStore(): ConversationStore {
  const readers = new Map<string, Map<string, Conversation>>();
  return {
    async load(reader, id) {
      const found =
        isSafeKey(reader) && isSafeKey(id)
          ? readers.get(reader)?.get(id)
          : undefined;
      return found ? structuredClone(found) : null;
    },
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      let own = readers.get(reader);
      if (!own) readers.set(reader, (own = new Map()));
      own.set(conversation.id, structuredClone(conversation));
    },
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      return [...(readers.get(reader)?.values() ?? [])]
        .map((conversation) => structuredClone(conversation))
        .sort(newestFirst);
    },
    async summaries(reader) {
      if (!isSafeKey(reader)) return [];
      return [...(readers.get(reader)?.values() ?? [])]
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort(newestFirst);
    },
    async delete(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      const own = readers.get(reader);
      own?.delete(id);
      if (own?.size === 0) readers.delete(reader);
    },
  };
}
