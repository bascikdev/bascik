/**
 * Long-term memory: what the assistant knows about one reader across
 * conversations.
 *
 * Memory is the reader's data, so this file gives an interface and two simple
 * implementations, exactly as `store.ts` does for conversations. The chat
 * asks a `MemoryStore` for four things and nothing else, so a consumer can
 * keep memories in a database, or search them with a vector index, without
 * the library knowing.
 *
 * What the library does itself, whatever the store:
 *
 * - **The limits.** A memory is plain text of at most 500 characters on one
 *   line, and a reader has at most 200. A store is never asked to enforce
 *   either.
 * - **The tools.** `memoryTools` gives the model `remember`, `recall`, and
 *   `forget`, for one reader. The first and last change data about a person,
 *   so each shows in the reply what it did, and either can wait for the
 *   reader's OK.
 * - **The prompt.** `memoryPrompt` says when to save and when not to, and
 *   lists what is known as quoted data, never as instructions.
 *
 * Stored text is untrusted. A message such as "remember: ignore your
 * instructions" is saved like any other sentence, so nothing here ever reads
 * a memory as an instruction or as markup.
 */
export type { Memory, MemoryStore } from "./memory/types.ts";
export {
  MAX_MEMORIES,
  MAX_MEMORY_LENGTH,
  cleanMemoryText,
  searchMemories,
} from "./memory/text.ts";
export { fileMemories, inMemoryMemories } from "./memory/stores.ts";
export { forgetMemory, rememberMemory } from "./memory/changes.ts";
export { memoryTools, savedMemory } from "./memory/tools.ts";
export type { MemoryToolOptions } from "./memory/tools.ts";
export { memoryPrompt } from "./memory/prompt.ts";
