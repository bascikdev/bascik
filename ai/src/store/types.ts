/**
 * The shapes a conversation store works with: a conversation, the store
 * interface a database implements, a summary for counts and sidebars, and
 * one search match.
 */
import type { ChatMessage } from "../model.ts";

export interface Conversation {
  id: string;
  title: string;
  /** Milliseconds since the epoch; the chat sets it each time it saves. */
  updatedAt: number;
  messages: ChatMessage[];
}

/**
 * What the chat needs from a database. A reader is whatever the app's
 * sessions say it is (an anonymous cookie, a signed-in user), and a store
 * never lets one reader see another's conversations.
 *
 * `load` and `save` hand over copies: the chat changes what it loaded and
 * saves it again, and a store that gave out its own object would see those
 * changes before they were saved. Ids and readers come from the request, so
 * a store checks them before it uses one as a key or a path.
 */
export interface ConversationStore {
  /** The reader's conversation with that id, or null when there is none. */
  load(reader: string, id: string): Promise<Conversation | null>;
  /** Create the conversation or replace it. */
  save(reader: string, conversation: Conversation): Promise<void>;
  /**
   * Every one of the reader's conversations, newest first by `updatedAt`.
   * It has to be all of them, not a page: without `summaries`, the chat
   * counts a reader's conversations with it, and lists and searches them
   * with it too. With `summaries`, the chat reads whole conversations only
   * through `load`, one at a time, and never calls this.
   */
  list(reader: string): Promise<Conversation[]>;
  /**
   * Optional: every one of the reader's conversations without its messages,
   * newest first by `updatedAt`, and all of them, as `list`. The chat counts
   * conversations with it each time a new one is saved, so it should be
   * cheap: a query of three columns, not of every message. Without it, the
   * chat counts with `list`.
   */
  summaries?(reader: string): Promise<ConversationSummary[]>;
  /**
   * Optional: the reader's conversations that match what they typed, best
   * first, at most `limit`. A store over a database implements it with the
   * database's own full-text search. Without it, `searchConversations` reads
   * the conversations and matches words itself.
   *
   * The query is what the reader typed: use it as data (a bound parameter),
   * never as part of a query's text. Match what was said, not tool inputs or
   * outputs, and only the reader's own conversations.
   */
  search?(reader: string, query: string, limit: number): Promise<SearchMatch[]>;
  /**
   * Optional: remove the reader's conversation with that id. Removing one
   * that is not there is not an error. The chat keeps each reader to
   * `maxConversations` and deletes their oldest to make room for a new one;
   * without `delete`, a reader at the cap cannot start another.
   */
  delete?(reader: string, id: string): Promise<void>;
}

/** A conversation without its messages: what a count or a sidebar needs. */
export type ConversationSummary = Pick<
  Conversation,
  "id" | "title" | "updatedAt"
>;

/** One conversation that matched a search. */
export interface SearchMatch {
  /** The conversation's id. */
  id: string;
  title: string;
  /** Milliseconds since the epoch, as `Conversation.updatedAt`. */
  updatedAt: number;
  /** A short piece of the text that matched. Plain text, never markup. */
  snippet: string;
  /**
   * Where the matched words are in `snippet`, as `[start, end)` offsets in
   * UTF-16 code units, in order and not overlapping. Empty when the store
   * cannot say.
   */
  marks: Array<[start: number, end: number]>;
}
