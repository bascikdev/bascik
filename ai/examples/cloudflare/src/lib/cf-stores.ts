/**
 * The four storage interfaces `createChat` takes, over this example's
 * Durable Objects: ConversationStore, MemoryStore and FileStore over
 * ReaderData (one object per reader), and Shared over ConversationLive (one
 * object per conversation).
 *
 * Each call makes a new stub. A stub belongs to the request that made it,
 * and using it from another request throws "Cannot perform I/O on behalf of
 * a different request", while the namespace binding itself is safe to keep.
 * These clients are made once per isolate (src/lib/chat.ts), so they hold
 * the namespace and nothing else.
 */
import type { Conversation, ConversationStore } from "@bascik/ai/app";
import type { FileStore } from "@bascik/ai/files";
import type { MemoryStore } from "@bascik/ai/memory";
import type {
  ChannelDelivery,
  ChannelEvent,
  Lease,
  Shared,
} from "@bascik/ai/shared";
import type { Budget } from "../../do/budget.ts";
import type {
  ConversationLive,
  ReplayBounds,
} from "../../do/conversation-live.ts";
import type { ReaderData } from "../../do/reader-data.ts";
import { liveObjectName } from "./shared-keys.ts";

/** The ids a store accepts: what `isSafeKey` in @bascik/ai accepts. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const isSafeKey = (value: unknown): value is string =>
  typeof value === "string" && SAFE_KEY.test(value);

function assertReader(reader: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
}

/**
 * The reader stores. `prefix` keeps one test's readers apart from another's;
 * the app leaves it at `reader:`.
 */
export function readerStores(
  namespace: DurableObjectNamespace<ReaderData>,
  { prefix = "reader:" }: { prefix?: string } = {},
): {
  conversations: ConversationStore;
  memories: MemoryStore;
  files: FileStore;
} {
  const object = (reader: string) =>
    namespace.get(namespace.idFromName(`${prefix}${reader}`));

  const conversations: ConversationStore = {
    async load(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      return (await object(reader).load(id)) as Conversation | null;
    },
    async save(reader, conversation) {
      assertReader(reader);
      if (!isSafeKey(conversation.id)) {
        throw new Error("That conversation id cannot be stored.");
      }
      await object(reader).save(conversation);
    },
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      return (await object(reader).list()) as Conversation[];
    },
    async summaries(reader) {
      if (!isSafeKey(reader)) return [];
      return object(reader).summaries();
    },
    async delete(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      await object(reader).delete(id);
    },
  };

  const memories: MemoryStore = {
    async list(reader) {
      if (!isSafeKey(reader)) return [];
      return object(reader).listMemories();
    },
    async add(reader, memory) {
      assertReader(reader);
      if (!isSafeKey(memory.id)) {
        throw new Error("That memory id cannot be stored.");
      }
      await object(reader).addMemory(memory);
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return false;
      return object(reader).removeMemory(id);
    },
    async search(reader, query, limit) {
      if (!isSafeKey(reader)) return [];
      return object(reader).searchMemories(query, limit);
    },
  };

  const files: FileStore = {
    async put(reader, id, file) {
      assertReader(reader);
      if (!isSafeKey(id)) throw new Error("That file id cannot be stored.");
      await object(reader).putFile(id, file);
    },
    async get(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      return object(reader).getFile(id);
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      await object(reader).removeFile(id);
    },
  };

  return { conversations, memories, files };
}

export interface LiveSharedOptions extends ReplayBounds {
  /**
   * The object name a key goes to. Default: by conversation, parsed from
   * the key (src/lib/shared-keys.ts).
   */
  route?: (key: string) => string;
  /** True in development: a key of an unknown shape throws. */
  development?: boolean;
}

/** One writer's events waiting to be sent, and the send under way. */
interface Outbox {
  pending: ChannelEvent[];
  sending: Promise<void> | null;
  failed: unknown;
}

/**
 * `Shared` over ConversationLive objects.
 *
 * Publishing does not wait for the object: an event is queued and the
 * promise resolves at once, while one send at a time carries everything
 * queued since the last, in order, so a reply costs one request per send,
 * not one per piece. `end` waits until everything before it, and it, has
 * been accepted. A failed send fails the next publish to that key.
 */
export function liveShared(
  namespace: DurableObjectNamespace<ConversationLive>,
  options: LiveSharedOptions = {},
): Shared {
  const { development = false, replayEvents, replayMs } = options;
  const route =
    options.route ?? ((key: string) => liveObjectName(key, development));
  const bounds: ReplayBounds = { replayEvents, replayMs };
  const object = (key: string) =>
    namespace.get(namespace.idFromName(route(key)));

  const outboxes = new Map<string, Outbox>();
  const drain = (key: string, outbox: Outbox): Promise<void> => {
    if (outbox.sending) return outbox.sending;
    outbox.sending = (async () => {
      try {
        while (outbox.pending.length > 0) {
          const batch = outbox.pending.splice(0);
          await object(key).publishMany(key, batch, bounds);
        }
      } catch (error) {
        outbox.failed = error;
        outbox.pending.length = 0;
      } finally {
        outbox.sending = null;
        if (
          outbox.pending.length === 0 &&
          outbox.failed === undefined &&
          outboxes.get(key) === outbox
        ) {
          outboxes.delete(key);
        }
      }
    })();
    return outbox.sending;
  };

  return {
    async claim(key, ttlMs) {
      const token = await object(key).claim(key, ttlMs);
      if (token === null) return null;
      const lease: Lease = {
        renew: () => object(key).renew(key, token, ttlMs),
        release: () => object(key).release(key, token),
      };
      return lease;
    },

    async publish(key, event) {
      let outbox = outboxes.get(key);
      if (!outbox) {
        outbox = { pending: [], sending: null, failed: undefined };
        outboxes.set(key, outbox);
      }
      if (outbox.failed !== undefined) {
        const failed = outbox.failed;
        outboxes.delete(key);
        throw failed;
      }
      outbox.pending.push(event);
      const sent = drain(key, outbox);
      if (event.type === "end") {
        // Everything queued before the end goes first, then the end itself.
        for (;;) {
          await sent;
          if (outbox.failed !== undefined) throw outbox.failed;
          if (outbox.pending.length === 0 && !outbox.sending) break;
          await drain(key, outbox);
        }
      } else {
        sent.catch(() => {});
      }
    },

    async *subscribe(key, { signal } = {}): AsyncGenerator<ChannelDelivery> {
      if (signal?.aborted) return;
      const response = await object(key).fetch(
        `https://conversation-live/subscribe?key=${encodeURIComponent(key)}`,
      );
      if (!response.ok || !response.body) {
        throw new Error(`ConversationLive answered ${response.status}.`);
      }
      const reader = response.body.getReader();
      const stopReading = (): void => {
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener("abort", stopReading, { once: true });
      const decoder = new TextDecoder();
      let buffered = "";
      try {
        for (;;) {
          if (signal?.aborted) return;
          let read: ReadableStreamReadResult<Uint8Array>;
          try {
            read = await reader.read();
          } catch (error) {
            // workerd rejects a pending read when the abort cancels the
            // stream (the streams standard resolves it as done): an abort
            // ends the iteration either way.
            if (signal?.aborted) return;
            throw error;
          }
          const { done, value } = read;
          if (signal?.aborted) return;
          if (done) return;
          buffered += decoder.decode(value, { stream: true });
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            newline = buffered.indexOf("\n");
            // An empty line is the object's heartbeat.
            if (!line) continue;
            const delivery = JSON.parse(line) as ChannelDelivery;
            yield delivery;
            if (delivery.type === "end") return;
            if (signal?.aborted) return;
          }
        }
      } finally {
        signal?.removeEventListener("abort", stopReading);
        stopReading();
      }
    },

    async get(key) {
      return object(key).get(key);
    },
    async set(key, value, ttlMs) {
      await object(key).set(key, value, ttlMs);
    },
    async delete(key) {
      await object(key).delete(key);
    },
    async take(key) {
      return object(key).take(key);
    },
  };
}

/**
 * Count one of `counter` in the Budget object `name`, if fewer than
 * `limit` were counted. True when it was counted.
 */
export async function charge(
  namespace: DurableObjectNamespace<Budget>,
  name: string,
  counter: string,
  limit: number,
  ttlMs: number,
): Promise<boolean> {
  return namespace
    .get(namespace.idFromName(name))
    .charge(counter, limit, ttlMs);
}
