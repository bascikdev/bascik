/**
 * ConversationLive: the chat's `Shared` store for one conversation, named
 * `live:<chatId>:<conversationId>` (see src/lib/shared-keys.ts). Every key
 * of one conversation lands here, so the object's one-call-at-a-time rule
 * is what makes a claim or a take atomic: each method awaits nothing but its
 * own storage, and a Durable Object does not start another call while it
 * waits on that.
 *
 * - Leases and values are kept in storage, with their expiry: a restarted
 *   object still knows who holds the reply, so it cannot give it to a second
 *   writer.
 * - A channel's events (the reply's HTML) are kept in memory, bounded by
 *   count, bytes and age. A durable marker says a channel was open, so a
 *   subscriber to an object that restarted and lost the events is told
 *   `gap` first, and the chat shows the stored reply once it is finished.
 * - `subscribe` is a `fetch` that answers NDJSON: each event on a line, and
 *   an empty line every few seconds while nothing happens.
 *
 * The alarm deletes what has expired, and the whole object once nothing is
 * left.
 */
import { DurableObject } from "cloudflare:workers";
import type { ChannelDelivery, ChannelEvent } from "@bascik/ai/shared";
import type { Env } from "../src/lib/env.ts";

/** The most events, bytes, and milliseconds of quiet a channel keeps for late readers. */
export const REPLAY_EVENTS = 20_000;
export const REPLAY_BYTES = 2 * 1024 * 1024;
export const REPLAY_MS = 120_000;
/** How often a waiting subscriber's stream gets an empty line. */
export const HEARTBEAT_MS = 5000;
/** How long after the last expiry the alarm runs. */
const ALARM_SLACK_MS = 10_000;

interface Held {
  token: string;
  until: number;
}

interface Stored {
  value: string;
  expiresAt: number;
}

/** A channel's retention, sent by the writer with each batch. */
export interface ReplayBounds {
  replayEvents?: number;
  replayMs?: number;
}

interface Channel {
  events: ChannelEvent[];
  replayEvents: number;
  replayMs: number;
  /** The number of the first event still kept: events before it were trimmed. */
  firstSeq: number;
  bytes: number;
  /** When the last event came. */
  touched: number;
  /**
   * The object restarted while this channel was open, so the events before
   * its first one here are gone: every reader is told `gap` first.
   */
  lostHead: boolean;
  waiting: Set<() => void>;
}

const LEASE = "lease:";
const VALUE = "value:";
const MARKER = "chan:";

const sizeOf = (event: ChannelEvent): number =>
  event.type === "data" ? event.data.length * 2 : 16;

export class ConversationLive extends DurableObject<Env> {
  private channels = new Map<string, Channel>();

  /* ---- Leases ---- */

  /** A token for the caller when no one holds `key`, else null. */
  async claim(key: string, ttlMs: number): Promise<string | null> {
    const now = Date.now();
    const held = await this.ctx.storage.get<Held>(LEASE + key);
    if (held && held.until > now) return null;
    const token = crypto.randomUUID();
    await this.ctx.storage.put<Held>(LEASE + key, {
      token,
      until: now + ttlMs,
    });
    await this.expireBy(now + ttlMs);
    return token;
  }

  /** Extend the claim, if it is still this holder's. */
  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const held = await this.ctx.storage.get<Held>(LEASE + key);
    if (!held || held.token !== token || held.until <= now) return false;
    await this.ctx.storage.put<Held>(LEASE + key, {
      token,
      until: now + ttlMs,
    });
    await this.expireBy(now + ttlMs);
    return true;
  }

  async release(key: string, token: string): Promise<void> {
    const held = await this.ctx.storage.get<Held>(LEASE + key);
    if (held?.token === token) await this.ctx.storage.delete(LEASE + key);
  }

  /* ---- Values ---- */

  async get(key: string): Promise<string | undefined> {
    const stored = await this.ctx.storage.get<Stored>(VALUE + key);
    if (!stored) return undefined;
    if (stored.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(VALUE + key);
      return undefined;
    }
    return stored.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const expiresAt = Date.now() + ttlMs;
    await this.ctx.storage.put<Stored>(VALUE + key, { value, expiresAt });
    await this.expireBy(expiresAt);
  }

  async delete(key: string): Promise<void> {
    await this.ctx.storage.delete(VALUE + key);
  }

  /** Read and delete in one call: of two takers, one gets the value. */
  async take(key: string): Promise<string | undefined> {
    const value = await this.get(key);
    if (value !== undefined) await this.ctx.storage.delete(VALUE + key);
    return value;
  }

  /* ---- Channels ---- */

  /**
   * The channel for `key`, made when this instance has none. A new one in an
   * object whose durable marker is still current belongs to a reply that
   * was open before a restart: its start is gone, whichever comes first
   * after the restart, the writer's next publish or a reader.
   */
  private async channelFor(key: string): Promise<Channel> {
    this.forgetQuiet();
    const existing = this.channels.get(key);
    if (existing) return existing;
    const marker = (await this.ctx.storage.get<number>(MARKER + key)) ?? 0;
    // Another call may have made it while storage answered.
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        events: [],
        replayEvents: REPLAY_EVENTS,
        replayMs: REPLAY_MS,
        firstSeq: 0,
        bytes: 0,
        touched: Date.now(),
        lostHead: marker > Date.now(),
        waiting: new Set(),
      };
      this.channels.set(key, channel);
    }
    return channel;
  }

  /** Drop channels nobody wrote to for `REPLAY_MS`, and let their readers go. */
  private forgetQuiet(): void {
    const now = Date.now();
    for (const [key, channel] of this.channels) {
      if (channel.touched + channel.replayMs <= now) {
        this.channels.delete(key);
        for (const wake of channel.waiting) wake();
        channel.waiting.clear();
      }
    }
  }

  /** Append events to a channel, in order, and wake its readers. */
  async publishMany(
    key: string,
    events: ChannelEvent[],
    bounds: ReplayBounds = {},
  ): Promise<void> {
    if (events.length === 0) return;
    const channel = await this.channelFor(key);
    channel.replayEvents = Math.max(
      1,
      Math.min(bounds.replayEvents ?? REPLAY_EVENTS, REPLAY_EVENTS),
    );
    channel.replayMs = Math.max(
      1,
      Math.min(bounds.replayMs ?? REPLAY_MS, REPLAY_MS),
    );
    for (const event of events) {
      channel.events.push(event);
      channel.bytes += sizeOf(event);
    }
    while (
      channel.events.length > 1 &&
      (channel.events.length > channel.replayEvents ||
        channel.bytes > REPLAY_BYTES)
    ) {
      channel.bytes -= sizeOf(channel.events.shift()!);
      channel.firstSeq++;
    }
    const now = Date.now();
    channel.touched = now;
    // The marker outlives a restart: a reader that finds it, and no events,
    // knows the start of the reply is gone.
    await this.ctx.storage.put<number>(MARKER + key, now + channel.replayMs);
    await this.expireBy(now + channel.replayMs);
    for (const wake of channel.waiting) wake();
    channel.waiting.clear();
  }

  /** `GET /subscribe?key=`: the channel's events as NDJSON, until `end`. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (url.pathname !== "/subscribe" || !key) {
      return new Response("Not found", { status: 404 });
    }
    const channel = await this.channelFor(key);
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    const writer = writable.getWriter();
    const send = (delivery: ChannelDelivery | null): Promise<void> =>
      writer.write(
        encoder.encode(delivery ? `${JSON.stringify(delivery)}\n` : "\n"),
      );
    let open = true;
    request.signal?.addEventListener("abort", () => {
      open = false;
    });
    const pump = async (): Promise<void> => {
      let next = channel.firstSeq;
      if (channel.lostHead || channel.firstSeq > 0) {
        await send({ type: "gap" });
        next = channel.firstSeq;
      }
      while (open) {
        if (next < channel.firstSeq) {
          next = channel.firstSeq;
          await send({ type: "gap" });
        } else if (next < channel.firstSeq + channel.events.length) {
          const event = channel.events[next - channel.firstSeq]!;
          next++;
          await send(event);
          if (event.type === "end") break;
        } else if (this.channels.get(key) !== channel) {
          // Forgotten while waiting: nothing more will come.
          break;
        } else {
          // Wait for the next event, with a timer of this call's own pending
          // so the runtime does not take the wait for a hang, and an empty
          // line now and then, which fails once the reader has gone.
          let wake = (): void => {};
          const arrived = new Promise<boolean>((resolve) => {
            wake = () => resolve(true);
            channel.waiting.add(wake);
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const quiet = new Promise<boolean>((resolve) => {
            timer = setTimeout(
              () => resolve(false),
              Math.min(HEARTBEAT_MS, channel.replayMs),
            );
          });
          const came = await Promise.race([arrived, quiet]);
          clearTimeout(timer);
          channel.waiting.delete(wake);
          if (!came) {
            this.forgetQuiet();
            await send(null);
          }
        }
      }
    };
    this.ctx.waitUntil(
      pump()
        .catch(() => {
          // The reader went away: nothing to tell anyone.
        })
        .finally(() => writer.close().catch(() => {})),
    );
    return new Response(readable, {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      },
    });
  }

  /* ---- Expiry ---- */

  /** Make sure the alarm runs after `at`. */
  private async expireBy(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const wanted = at + ALARM_SLACK_MS;
    if (current === null || current < wanted) {
      await this.ctx.storage.setAlarm(wanted);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let latest = 0;
    const gone: string[] = [];
    for (const [name, entry] of await this.ctx.storage.list<unknown>()) {
      const expires = name.startsWith(LEASE)
        ? (entry as Held).until
        : name.startsWith(VALUE)
          ? (entry as Stored).expiresAt
          : name.startsWith(MARKER)
            ? (entry as number)
            : 0;
      if (expires <= now) gone.push(name);
      else latest = Math.max(latest, expires);
    }
    this.forgetQuiet();
    if (latest === 0 && this.channels.size === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    // delete() takes at most 128 keys at a time.
    for (let at = 0; at < gone.length; at += 128) {
      await this.ctx.storage.delete(gone.slice(at, at + 128));
    }
    await this.ctx.storage.setAlarm(
      Math.max(latest, now + REPLAY_MS) + ALARM_SLACK_MS,
    );
  }
}
