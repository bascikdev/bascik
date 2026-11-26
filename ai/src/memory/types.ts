/**
 * The shapes long-term memory works with: one memory about a reader, and
 * the store interface a database implements.
 */

/** One thing the assistant knows about a reader. Plain text only. */
export interface Memory {
  /** Unique for the reader. Letters, digits, `_` and `-` only. */
  id: string;
  /** One line of plain text, at most `MAX_MEMORY_LENGTH` characters. */
  text: string;
  /** Milliseconds since the epoch: when it was saved. */
  created: number;
  /** When it was last changed, if it ever was. */
  updated?: number;
  /** The conversation it was saved in, when there was one. */
  conversationId?: string;
}

/**
 * What the chat needs from a database. A reader is whatever the app's
 * sessions say it is, and a store never lets one reader see another's
 * memories. Readers and ids come from requests, so a store checks them
 * before it uses one as a key or a path.
 *
 * `list` and `add` hand over copies. The library has already cleaned the
 * text and checked the limits before `add` is called.
 */
export interface MemoryStore {
  /** The reader's memories, newest first. */
  list(reader: string): Promise<Memory[]>;
  /** Save a memory, or replace the one with the same id. */
  add(reader: string, memory: Memory): Promise<void>;
  /** Remove one. False when the reader has no memory with that id. */
  remove(reader: string, id: string): Promise<boolean>;
  /**
   * The memories that best answer `query`, best first, at most `limit`. A
   * store decides what "best" means: the two here count shared words, and a
   * vector index would rank by meaning. An empty query asks for the newest.
   */
  search(reader: string, query: string, limit: number): Promise<Memory[]>;
}
