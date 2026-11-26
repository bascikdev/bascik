/**
 * The state that has to be the same on every server.
 *
 * One server needs none of this: `createChat` keeps a live reply, a Stop
 * request, and a voice call's turn in its own memory, and that is correct.
 * Behind a load balancer with several servers, a page served by one server
 * has to see the reply another one is writing, Stop has to reach the server
 * that is writing it, and a voice tool call has to find the turn its
 * predecessor recorded. `Shared` is the smallest interface that covers it,
 * and `inProcessShared()` is the implementation for one process.
 *
 * Everything that crosses it is a string or a plain object of strings, so an
 * adapter for Redis, Postgres, or a platform's own primitives is a small
 * file. The reference sketch is on the "Running on Several Servers" page.
 */

/** What a reply's writer says on a channel. Plain data: it crosses processes. */
export type ChannelEvent =
  /** The next piece of the reply's HTML. */
  | { type: "data"; data: string }
  /** The reply is finished and stored. Nothing follows. */
  | { type: "end" };

/**
 * What a subscriber receives: the published events, and `gap` first when
 * the channel no longer holds the start of the reply (its replay bound was
 * passed), so what follows is not all of it.
 */
export type ChannelDelivery = ChannelEvent | { type: "gap" };

/** A claim on a key. Held until it is released, or until `ttlMs` passes without a renewal. */
export interface Lease {
  /**
   * Hold the claim for another `ttlMs` (the one it was made with). False
   * when it is no longer held: it expired, or another holder has the key.
   */
  renew(): Promise<boolean>;
  /** Give the claim up. Does nothing when it is no longer held. */
  release(): Promise<void>;
}

export interface Shared {
  /* A lease: exactly one holder per key. */

  /**
   * Claim `key` for `ttlMs`. A lease handle when no one holds it (or the last
   * holder let it expire), `null` when someone does. A crashed holder stops
   * renewing, so its claim expires and another server can take over.
   */
  claim(key: string, ttlMs: number): Promise<Lease | null>;

  /* A channel: what the holder writes, every server reads. */

  /** Append `event` to the channel `key`. */
  publish(key: string, event: ChannelEvent): Promise<void>;
  /**
   * Every retained event of `key` from the first, then new ones as they are
   * published, until the `end` event (which it delivers) or until `signal`
   * aborts. A subscriber that joins late, or on another server, gets the
   * whole reply so far. Retention is bounded: see `ChannelDelivery`.
   */
  subscribe(
    key: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ChannelDelivery>;

  /* A small store with expiry: the stop signal, voice state, one-use tickets. */

  get(key: string): Promise<string | undefined>;
  /** Store `value`, replacing any, and forget it after `ttlMs`. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Read and delete in one step, so of two callers one gets the value. */
  take(key: string): Promise<string | undefined>;
}

export interface InProcessSharedOptions {
  /** The most events one channel keeps for late subscribers. Default 20 000. */
  replayEvents?: number;
  /** How long a channel is kept after its last event, ended or not. Default two minutes. */
  replayMs?: number;
}

interface Held {
  token: symbol;
  expires: number;
}

interface Channel {
  events: ChannelEvent[];
  /** How many events were dropped from the front. */
  dropped: number;
  touched: number;
  waiting: Set<() => void>;
}

const SWEEP_MS = 5000;

/**
 * `Shared` in this process's memory: what `createChat` uses unless it is
 * given another. Expiry is checked whenever a key is used, and a timer that
 * does not keep the process alive sweeps what nobody used again.
 */
export function inProcessShared(options: InProcessSharedOptions = {}): Shared {
  const { replayEvents = 20_000, replayMs = 120_000 } = options;
  const leases = new Map<string, Held>();
  const values = new Map<string, { value: string; expires: number }>();
  const channels = new Map<string, Channel>();
  let sweeper: ReturnType<typeof setInterval> | undefined;

  const wake = (channel: Channel): void => {
    for (const resolve of channel.waiting) resolve();
    channel.waiting.clear();
  };

  function sweep(): void {
    const now = Date.now();
    for (const [key, held] of leases) {
      if (held.expires <= now) leases.delete(key);
    }
    for (const [key, entry] of values) {
      if (entry.expires <= now) values.delete(key);
    }
    for (const [key, channel] of channels) {
      if (channel.touched + replayMs <= now) {
        channels.delete(key);
        // A subscriber still waiting on it is let go, not left hanging.
        wake(channel);
      }
    }
    if (!leases.size && !values.size && !channels.size) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  }

  const keepSwept = (): void => {
    if (sweeper) return;
    sweeper = setInterval(sweep, SWEEP_MS);
    // Housekeeping never keeps a finished process alive. Some hosts
    // (workerd) hand back a plain number, which has nothing to unref.
    (sweeper as { unref?: () => void }).unref?.();
  };

  const live = (key: string): Held | undefined => {
    const held = leases.get(key);
    if (held && held.expires <= Date.now()) {
      leases.delete(key);
      return undefined;
    }
    return held;
  };

  const channelFor = (key: string): Channel => {
    let channel = channels.get(key);
    if (!channel) {
      channel = {
        events: [],
        dropped: 0,
        touched: Date.now(),
        waiting: new Set(),
      };
      channels.set(key, channel);
    }
    return channel;
  };

  const read = (key: string): string | undefined => {
    const entry = values.get(key);
    if (entry && entry.expires <= Date.now()) {
      values.delete(key);
      return undefined;
    }
    return entry?.value;
  };

  return {
    async claim(key, ttlMs) {
      if (live(key)) return null;
      const token = Symbol(key);
      const hold = (): void => {
        leases.set(key, { token, expires: Date.now() + ttlMs });
      };
      hold();
      keepSwept();
      return {
        async renew() {
          if (live(key)?.token !== token) return false;
          hold();
          return true;
        },
        async release() {
          if (live(key)?.token === token) leases.delete(key);
        },
      };
    },

    async publish(key, event) {
      const channel = channelFor(key);
      channel.events.push(event);
      if (channel.events.length > replayEvents) {
        channel.events.shift();
        channel.dropped++;
      }
      channel.touched = Date.now();
      keepSwept();
      wake(channel);
    },

    async *subscribe(key, { signal } = {}) {
      const channel = channelFor(key);
      keepSwept();
      // The next event to deliver, counted from the first one ever published.
      let at = 0;
      let resolve = (): void => {};
      const onAbort = (): void => resolve();
      signal?.addEventListener("abort", onAbort);
      try {
        for (;;) {
          if (signal?.aborted) return;
          if (at < channel.dropped) {
            // What was there at `at` is gone: say so, and go on from what is left.
            at = channel.dropped;
            yield { type: "gap" };
          } else if (at - channel.dropped < channel.events.length) {
            const event = channel.events[at++ - channel.dropped]!;
            yield event;
            if (event.type === "end") return;
          } else if (channels.get(key) !== channel) {
            // Swept away while waiting: nothing more will come.
            return;
          } else {
            await new Promise<void>((done) => {
              resolve = done;
              channel.waiting.add(done);
            });
            channel.waiting.delete(resolve);
          }
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        channel.waiting.delete(resolve);
      }
    },

    async get(key) {
      return read(key);
    },
    async set(key, value, ttlMs) {
      values.set(key, { value, expires: Date.now() + ttlMs });
      keepSwept();
    },
    async delete(key) {
      values.delete(key);
    },
    async take(key) {
      const value = read(key);
      values.delete(key);
      return value;
    },
  };
}
