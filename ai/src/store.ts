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
  /**
   * Every one of the reader's conversations, newest first by `updatedAt`.
   * It has to be all of them, not a page: without `summaries`, the chat
   * counts a reader's conversations with it.
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

const newestFirst = (a: ConversationSummary, b: ConversationSummary): number =>
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
  /**
   * The ids of the reader's conversations, `OPEN_AT_ONCE` at a time. Only
   * regular files count (never a folder, a link, or a pipe), and a caller
   * opens one batch before the next, so a folder that holds more than it
   * should costs time, not every file descriptor.
   */
  const batchesOf = async (reader: string): Promise<string[][]> => {
    if (!isSafeKey(reader)) return [];
    const [fs, path] = await modules;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(path.join(directory, reader), {
        withFileTypes: true,
      });
    } catch {
      return [];
    }
    const ids = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -".json".length))
      .filter(isSafeKey);
    const batches: string[][] = [];
    for (let at = 0; at < ids.length; at += OPEN_AT_ONCE) {
      batches.push(ids.slice(at, at + OPEN_AT_ONCE));
    }
    return batches;
  };
  const listing = turns(LISTS_AT_ONCE);
  return {
    load: read,
    async save(reader, conversation) {
      assertSafe(reader, conversation.id);
      const [fs, path] = await modules;
      const file = await fileOf(reader, conversation.id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const partial = `${file}.${randomUUID()}.tmp`;
      // The summary comes first in the file, so `summaries` reads only the
      // start of each file.
      const { id, title, updatedAt, ...rest } = conversation;
      await fs.writeFile(
        partial,
        JSON.stringify({ id, title, updatedAt, ...rest }),
      );
      await fs.rename(partial, file);
    },
    async list(reader) {
      // Every conversation is read: the chat keeps a reader to
      // `maxConversations` of at most `MAX_CONVERSATION_BYTES` each, so
      // that is all there is to read. Only `LISTS_AT_ONCE` lists read at a
      // time, so many page loads at once wait their turn instead of all
      // holding a reader's conversations half read.
      await listing.acquire();
      try {
        const all: Conversation[] = [];
        for (const batch of await batchesOf(reader)) {
          for (const entry of await Promise.all(
            batch.map((id) => read(reader, id)),
          )) {
            if (entry !== null) all.push(entry);
          }
        }
        return all.sort(newestFirst);
      } finally {
        listing.release();
      }
    },
    async summaries(reader) {
      const [fs] = await modules;
      const head = async (id: string): Promise<ConversationSummary | null> => {
        try {
          const handle = await fs.open(await fileOf(reader, id), "r");
          try {
            const bytes = new Uint8Array(HEAD_BYTES);
            const { bytesRead } = await handle.read(bytes, 0, HEAD_BYTES, 0);
            const found = summaryAtStart(
              new TextDecoder().decode(bytes.subarray(0, bytesRead)),
            );
            if (found) return { ...found, id };
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
        // A file this store did not write: read all of it.
        const whole = await read(reader, id);
        return whole
          ? { id, title: whole.title, updatedAt: whole.updatedAt }
          : null;
      };
      const all: ConversationSummary[] = [];
      for (const batch of await batchesOf(reader)) {
        for (const entry of await Promise.all(batch.map(head))) {
          if (entry !== null) all.push(entry);
        }
      }
      return all.sort(newestFirst);
    },
    async delete(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      const [fs] = await modules;
      await fs.rm(await fileOf(reader, id), { force: true });
    },
  };
}

/** How many of a reader's files `fileStore` opens at once. */
const OPEN_AT_ONCE = 32;
/** How much of a file `fileStore.summaries` reads to find its summary. */
const HEAD_BYTES = 4096;
/** How many `fileStore.list` calls read at once; the rest wait. */
const LISTS_AT_ONCE = 2;

/** At most `limit` holders at once; the others wait, first come first served. */
function turns(limit: number): {
  acquire(): Promise<void>;
  release(): void;
} {
  let held = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire() {
      if (held < limit) {
        held += 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else held -= 1;
    },
  };
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const JSON_NUMBER = String.raw`-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?`;
/** The start of a file `fileStore` wrote: its id, title and updatedAt, in that order. */
const SUMMARY_AT_START = new RegExp(
  String.raw`^\{"id":(${JSON_STRING}),"title":(${JSON_STRING}),"updatedAt":(${JSON_NUMBER}),`,
);

/** The summary at the start of a conversation's JSON, or null when it is not there. */
function summaryAtStart(text: string): ConversationSummary | null {
  const found = SUMMARY_AT_START.exec(text);
  if (!found) return null;
  try {
    const id: unknown = JSON.parse(found[1]!);
    const title: unknown = JSON.parse(found[2]!);
    const updatedAt = Number(found[3]);
    if (typeof id !== "string" || typeof title !== "string") return null;
    return Number.isFinite(updatedAt) ? { id, title, updatedAt } : null;
  } catch {
    return null;
  }
}

/* ---- How much a reader keeps ---- */

/** The most conversations the chat keeps for one reader, by default. */
export const MAX_CONVERSATIONS = 200;

/**
 * The most one conversation holds, as UTF-8 bytes of its JSON. A longer one
 * loses its oldest messages when it is saved. With `MAX_CONVERSATIONS`, it
 * bounds what one reader's `list` reads, whatever they send.
 */
export const MAX_CONVERSATION_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const bytesOf = (value: unknown): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

/**
 * Each store's saves in progress, by reader. It is kept by store, not by
 * `limitConversations` call, so two chats over one store take turns too.
 */
const savingByStore = new WeakMap<
  ConversationStore,
  Map<string, Promise<unknown>>
>();

function wholeNumber(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a whole number of at least 1.`);
  }
}

/**
 * The store, keeping each reader to at most `max` conversations of at most
 * `maxBytes` each.
 *
 * Saving a conversation the store does not have yet, when the reader already
 * has `max`, first deletes their oldest (by `updatedAt`), so a reader is
 * never stuck and never holds more. A store without `delete` refuses that
 * save with an error instead. Saving one the store already has never deletes
 * anything. The count comes from the store's `summaries` when it has one,
 * and from `list` when not, so either has to return every conversation. When
 * the count cannot be read, the save goes ahead, and the next new
 * conversation brings the reader back to the cap.
 *
 * A conversation over `maxBytes` is saved without its oldest messages: as
 * few as it takes, and it starts at something the reader said when it can.
 * When the newest message alone is over, only it is kept: the chat caps
 * what one message holds (a voice turn, `MAX_VOICE_TURN_CHARS`), so that
 * stays bounded too, and a reader is never refused their latest turn.
 *
 * A reader's saves to one store take turns, so two new conversations at once
 * cannot both see room for one. That holds within one server; across
 * several, the database has to keep the count.
 */
export function limitConversations(
  store: ConversationStore,
  max = MAX_CONVERSATIONS,
  maxBytes = MAX_CONVERSATION_BYTES,
): ConversationStore {
  wholeNumber(max, "maxConversations");
  wholeNumber(maxBytes, "maxBytes");
  let saving = savingByStore.get(store);
  if (!saving) savingByStore.set(store, (saving = new Map()));
  const queue = saving;
  const inTurn = (reader: string, step: () => Promise<void>): Promise<void> => {
    const run = (queue.get(reader) ?? Promise.resolve()).then(step);
    const settled = run.then(
      () => {},
      () => {},
    );
    queue.set(reader, settled);
    void settled.then(() => {
      if (queue.get(reader) === settled) queue.delete(reader);
    });
    return run;
  };
  const counted = async (reader: string): Promise<ConversationSummary[]> =>
    store.summaries ? store.summaries(reader) : store.list(reader);
  const makeRoom = async (reader: string, id: string): Promise<void> => {
    let entries: ConversationSummary[];
    try {
      entries = await counted(reader);
    } catch {
      return;
    }
    if (entries.some((entry) => entry.id === id)) return;
    const over = entries.length - (max - 1);
    if (over <= 0) return;
    const remove = store.delete;
    if (!remove) {
      throw new Error(
        `This reader already has ${max} conversations, the most the chat keeps, and the store has no delete to make room for a new one.`,
      );
    }
    const oldest = [...entries]
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, over);
    for (const entry of oldest) await remove.call(store, reader, entry.id);
  };
  /** The conversation, without as many of its oldest messages as it takes to fit. */
  const fitted = (conversation: Conversation): Conversation => {
    let size = bytesOf(conversation);
    if (size <= maxBytes) return conversation;
    const { messages } = conversation;
    // The first message to keep that fits, and the first that fits and is
    // something the reader said.
    let fits = -1;
    let said = -1;
    for (let from = 0; from < messages.length; from += 1) {
      if (size <= maxBytes) {
        if (fits === -1) fits = from;
        if (messages[from]!.role === "user") {
          said = from;
          break;
        }
      }
      // The message, and the comma after it.
      size -= bytesOf(messages[from]) + 1;
    }
    if (fits === -1) fits = messages.length - 1;
    return {
      ...conversation,
      messages: messages.slice(said === -1 ? fits : said),
    };
  };
  const limited: ConversationStore = {
    load: (reader, id) => store.load(reader, id),
    list: (reader) => store.list(reader),
    save: async (reader, conversation) => {
      const kept = fitted(conversation);
      await inTurn(reader, async () => {
        await makeRoom(reader, kept.id);
        await store.save(reader, kept);
      });
    },
  };
  const { summaries, search, delete: remove } = store;
  if (summaries) limited.summaries = (...args) => summaries.apply(store, args);
  if (search) limited.search = (...args) => search.apply(store, args);
  if (remove) limited.delete = (...args) => remove.apply(store, args);
  return limited;
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
