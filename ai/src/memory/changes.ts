/**
 * Saving and forgetting one memory with the library's rules, whatever the
 * store: the text is cleaned and checked, and nothing is dropped silently.
 */
import { randomUUID } from "node:crypto";
import { isSafeKey } from "../store/conversation.ts";
import { MAX_MEMORIES, MAX_MEMORY_LENGTH, cleanMemoryText } from "./text.ts";
import type { Memory, MemoryStore } from "./types.ts";

/**
 * Save a memory for a reader: the text is cleaned, checked against the
 * limits, and saved unless the reader already has the same words. It throws a
 * sentence the model can act on when the text is empty or too long, or when
 * the reader has `MAX_MEMORIES` already: nothing is dropped behind their
 * back, so a reader's memory only shrinks when they, or the model with their
 * OK, forget something.
 */
export async function rememberMemory(
  store: MemoryStore,
  reader: string,
  text: string,
  options: { conversationId?: string; now?: number } = {},
): Promise<{ memory: Memory; already: boolean }> {
  const clean = cleanMemoryText(text);
  if (!clean)
    throw new Error("There is nothing to remember: the text is empty.");
  if (clean.length > MAX_MEMORY_LENGTH) {
    throw new Error(
      `That is ${clean.length} characters; a memory is at most ${MAX_MEMORY_LENGTH}. Say it in one short sentence.`,
    );
  }
  const existing = await store.list(reader);
  const same = existing.find(
    (entry) => entry.text.toLowerCase() === clean.toLowerCase(),
  );
  if (same) return { memory: same, already: true };
  if (existing.length >= MAX_MEMORIES) {
    throw new Error(
      `The reader already has ${MAX_MEMORIES} memories, the most there can be. Forget one that is out of date first.`,
    );
  }
  const memory: Memory = {
    id: randomUUID(),
    text: clean,
    created: options.now ?? Date.now(),
    ...(options.conversationId && isSafeKey(options.conversationId)
      ? { conversationId: options.conversationId }
      : {}),
  };
  await store.add(reader, memory);
  return { memory, already: false };
}

/** Remove one of the reader's memories and answer what it said, or null when there is none. */
export async function forgetMemory(
  store: MemoryStore,
  reader: string,
  id: string,
): Promise<Memory | null> {
  if (!isSafeKey(id)) return null;
  const found = (await store.list(reader)).find((entry) => entry.id === id);
  if (!found) return null;
  return (await store.remove(reader, id)) ? found : null;
}
