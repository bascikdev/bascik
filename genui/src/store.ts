/**
 * Where conversations are kept. The chat in `app.ts` asks a store for three
 * things and nothing else, so a consumer can put conversations in any
 * database by implementing them. Two stores are here: one in memory, and one
 * JSON file per conversation.
 */
import { randomUUID } from "node:crypto";
import { partsOf, type ChatMessage } from "./model.ts";

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
  /** The reader's conversations, newest first by `updatedAt`. */
  list(reader: string): Promise<Conversation[]>;
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
}

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

const newestFirst = (a: Conversation, b: Conversation): number =>
  b.updatedAt - a.updatedAt;

function assertSafe(reader: string, id: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
  if (!isSafeKey(id)) throw new Error("That conversation id cannot be stored.");
}

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
  };
}

/**
 * One JSON file per conversation: `<directory>/<reader>/<id>.json`. It is a
 * good store for one server; with several, use a database. A write goes to a
 * temporary file first and is renamed into place, so a reader never sees half
 * a conversation.
 */
export function fileStore(directory: string): ConversationStore {
  const modules = Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const fileOf = async (reader: string, id: string): Promise<string> => {
    const [, path] = await modules;
    return path.join(directory, reader, `${id}.json`);
  };
  const read = async (
    reader: string,
    id: string,
  ): Promise<Conversation | null> => {
    if (!isSafeKey(reader) || !isSafeKey(id)) return null;
    const [fs] = await modules;
    try {
      const value: unknown = JSON.parse(
        await fs.readFile(await fileOf(reader, id), "utf8"),
      );
      return isConversation(value) ? value : null;
    } catch {
      return null;
    }
  };
  return {
    load: read,
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      const [fs, path] = await modules;
      const file = await fileOf(reader, conversation.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(partial, JSON.stringify(conversation));
      await fs.rename(partial, file);
    },
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      const [fs, path] = await modules;
      let files: string[];
      try {
        files = await fs.readdir(path.join(directory, reader));
      } catch {
        return [];
      }
      const all = await Promise.all(
        files
          .filter((file) => file.endsWith(".json"))
          .map((file) => read(reader, file.slice(0, -".json".length))),
      );
      return all
        .filter((entry): entry is Conversation => entry !== null)
        .sort(newestFirst);
    },
  };
}

/** A file in the folder is only a conversation when it has the shape of one. */
function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Conversation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.updatedAt === "number" &&
    Array.isArray(candidate.messages)
  );
}

/* ---- Search ---- */

/** A query shorter than this (after trimming) finds nothing. */
export const MIN_QUERY = 2;
/** A query is cut to this many characters. */
export const MAX_QUERY = 200;
/** The most words of a query that are matched; the rest are ignored. */
const MAX_WORDS = 8;
/** The fallback reads at most this many conversations, the newest. */
export const MAX_SCANNED = 200;
/** The most matches one search returns. */
export const MAX_MATCHES = 50;
/** How long a snippet is, more or less. */
const SNIPPET = 160;
/** How much of the text before the first match a snippet keeps. */
const LEAD = 50;

/**
 * Lowercase without changing the length: a character whose lowercase form is
 * longer or shorter stays as it is, so an offset in the result is an offset in
 * the original.
 */
const lower = (text: string): string =>
  Array.from(text, (char) => {
    const small = char.toLowerCase();
    return small.length === char.length ? small : char;
  }).join("");

/** The words of a query: lowercase, without repeats, at most `MAX_WORDS`. */
function wordsOf(query: string): string[] {
  const words = lower(query.trim().slice(0, MAX_QUERY)).split(/\s+/);
  return [...new Set(words.filter(Boolean))].slice(0, MAX_WORDS);
}

/** What was said in a conversation: the reader's words, and the model's. Never a tool call. */
function saidIn(conversation: Conversation): string[] {
  return conversation.messages.flatMap((message) =>
    partsOf(message)
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean),
  );
}

/** Every `[start, end)` where one of the words is in the text, in order, merged. */
function marksIn(text: string, words: string[]): SearchMatch["marks"] {
  const small = lower(text);
  const found: SearchMatch["marks"] = [];
  for (const word of words) {
    let at = small.indexOf(word);
    while (at !== -1) {
      found.push([at, at + word.length]);
      at = small.indexOf(word, at + word.length);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: SearchMatch["marks"] = [];
  for (const mark of found) {
    const last = merged.at(-1);
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([mark[0], mark[1]]);
  }
  return merged;
}

/** Match one conversation: how many times the words appear, and the best place to show. */
function matchOf(
  conversation: Conversation,
  words: string[],
): { count: number; match: SearchMatch } | null {
  const texts = saidIn(conversation).map((text) => ({
    text,
    marks: marksIn(text, words),
  }));
  // Every word has to be in the conversation, though not in one message.
  const everything = lower(texts.map((entry) => entry.text).join("\n"));
  if (!words.every((word) => everything.includes(word))) return null;
  let count = 0;
  let best: (typeof texts)[number] | undefined;
  let bestWords = 0;
  for (const entry of texts) {
    count += entry.marks.length;
    const small = lower(entry.text);
    const distinct = words.filter((word) => small.includes(word)).length;
    if (distinct > bestWords) {
      best = entry;
      bestWords = distinct;
    }
  }
  if (!best || best.marks.length === 0) return null;
  const text = best.text;
  let start = Math.max(0, best.marks[0]![0] - LEAD);
  let end = Math.min(text.length, start + SNIPPET);
  // Never cut a surrogate pair in half.
  const trail = (at: number): boolean => /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  if (start > 0 && trail(start)) start += 1;
  if (end < text.length && trail(end)) end -= 1;
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  const marks: SearchMatch["marks"] = [];
  for (const [from, to] of best.marks) {
    if (to <= start || from >= end) continue;
    marks.push([
      Math.max(from, start) - start + head.length,
      Math.min(to, end) - start + head.length,
    ]);
  }
  return {
    count,
    match: {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      snippet: head + text.slice(start, end) + tail,
      marks,
    },
  };
}

/**
 * The reader's conversations that match a query, best first. It uses the
 * store's own `search` when it has one. Otherwise it reads the reader's
 * newest `MAX_SCANNED` conversations and matches words: case does not matter,
 * every word has to appear somewhere in the conversation, and more
 * appearances rank higher, then the more recent conversation. A query shorter
 * than `MIN_QUERY` finds nothing, and `limit` is held to `MAX_MATCHES`.
 *
 * Only what was said is searched, never what a tool was given or returned.
 */
export async function searchConversations(
  store: ConversationStore,
  reader: string,
  query: string,
  limit = 20,
): Promise<SearchMatch[]> {
  const asked = query.trim().slice(0, MAX_QUERY);
  const wanted = Math.min(MAX_MATCHES, Math.max(0, Math.floor(limit) || 0));
  if (asked.length < MIN_QUERY || wanted === 0) return [];
  if (store.search) {
    return (await store.search(reader, asked, wanted)).slice(0, wanted);
  }
  const words = wordsOf(asked);
  const listed = (await store.list(reader)).slice(0, MAX_SCANNED);
  const found = await Promise.all(
    listed.map(async (entry) => {
      // A list may hold only what a sidebar needs: read the rest when it does.
      const conversation =
        entry.messages.length > 0 ? entry : await store.load(reader, entry.id);
      return conversation ? matchOf(conversation, words) : null;
    }),
  );
  return found
    .filter((entry) => entry !== null)
    .sort((a, b) => b.count - a.count || b.match.updatedAt - a.match.updatedAt)
    .slice(0, wanted)
    .map((entry) => entry.match);
}
