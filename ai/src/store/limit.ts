/**
 * How much a reader keeps: `limitConversations` wraps a store so each reader
 * has at most so many conversations of at most so many bytes, and its list
 * reads a bounded amount.
 */
import { bytesOf, newestFirst } from "./conversation.ts";
import { savingOf } from "./save-turns.ts";
import type {
  Conversation,
  ConversationStore,
  ConversationSummary,
} from "./types.ts";

/** The most conversations the chat keeps for one reader, by default. */
export const MAX_CONVERSATIONS = 200;

/**
 * The most one conversation holds, as UTF-8 bytes of its JSON. A longer one
 * loses its oldest messages when it is saved. The newest message is always
 * kept, so one conversation can be longer by that message alone: the chat
 * caps a voice turn at `MAX_VOICE_TURN_CHARS` characters, up to three bytes
 * each, about 1.5 MiB.
 */
export const MAX_CONVERSATION_BYTES = 1024 * 1024;

/**
 * How much of a reader's conversations the chat's `list` reads whole, as
 * UTF-8 bytes of their JSON, newest first. Older ones are listed from
 * `summaries`, with no messages: load one to read it. One list therefore
 * holds this much and one conversation more, whatever a reader has stored.
 */
export const MAX_LISTED_BYTES = 4 * 1024 * 1024;

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
 * and from `list` when not (or when `summaries` fails), so either has to
 * return every conversation. When neither answers, a new conversation is
 * refused with an error, and one the reader already has is still saved.
 *
 * A conversation over `maxBytes` is saved without its oldest messages: as
 * few as it takes, and it starts at something the reader said when it can.
 * When the newest message alone is over, only it is kept: the chat caps
 * what one message holds (a voice turn, `MAX_VOICE_TURN_CHARS`), so that
 * stays bounded too, and a reader is never refused their latest turn.
 *
 * With `summaries`, its `list` reads whole only the newest conversations,
 * up to `MAX_LISTED_BYTES`, one at a time; the rest come from `summaries`
 * with no messages. A page that lists a reader's conversations then reads a
 * bounded amount, however many large ones they have.
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
  const inTurn = async (
    reader: string,
    step: () => Promise<void>,
  ): Promise<void> => {
    const queue = await savingOf(store);
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
  /** Every conversation the reader has, or null when neither way of counting answers. */
  const counted = async (
    reader: string,
  ): Promise<ConversationSummary[] | null> => {
    if (store.summaries) {
      try {
        return await store.summaries(reader);
      } catch {
        // Count with `list` instead.
      }
    }
    try {
      return await store.list(reader);
    } catch {
      return null;
    }
  };
  const makeRoom = async (reader: string, id: string): Promise<void> => {
    const entries = await counted(reader);
    if (entries === null) {
      // Without a count, only a conversation the reader already has is safe
      // to save: a new one could take them past the cap.
      const existing = await store.load(reader, id).catch(() => null);
      if (existing) return;
      throw new Error(
        "The store could not count this reader's conversations, so the chat did not start a new one.",
      );
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
  const { summaries, search, delete: remove } = store;
  const limited: ConversationStore = {
    load: (reader, id) => store.load(reader, id),
    list: summaries
      ? async (reader) => {
          const listed: Conversation[] = [];
          let left = MAX_LISTED_BYTES;
          for (const summary of await summaries.call(store, reader)) {
            if (left <= 0) {
              listed.push({ ...summary, messages: [] });
              continue;
            }
            const whole = await store.load(reader, summary.id);
            if (whole === null) continue;
            left -= bytesOf(whole);
            listed.push(whole);
          }
          return listed.sort(newestFirst);
        }
      : (reader) => store.list(reader),
    save: async (reader, conversation) => {
      const kept = fitted(conversation);
      await inTurn(reader, async () => {
        await makeRoom(reader, kept.id);
        await store.save(reader, kept);
      });
    },
  };
  if (summaries) limited.summaries = (...args) => summaries.apply(store, args);
  if (search) limited.search = (...args) => search.apply(store, args);
  if (remove) limited.delete = (...args) => remove.apply(store, args);
  return limited;
}
