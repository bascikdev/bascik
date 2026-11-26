# Running on Several Servers

`createChat` keeps a few things in one server's memory, and that is correct when you run one server. Behind a load balancer with several, those things have to be shared. This page says when, what, and how: one option, and an interface small enough to write over Redis, Postgres, or your platform's own primitives.

## When you need this

If you run one server, you need nothing here. Do not set the option. A single process, a single serverless instance that handles every request, and `bascik --server` on one machine all work as they are.

You need it when two requests for one conversation can reach different server processes: two containers behind a load balancer, several workers, or a platform that scales out under load. Without it, three things go wrong:

- A reply is being written by server A, and the reader reloads onto server B. B sees a message waiting and no reply, so it starts a second one. The reader gets two model calls and two stored answers.
- The reader presses Stop and the request lands on B. B has no reply to stop, so it answers 404 and A writes on.
- A voice call's tool calls land on different servers. The second server has no record of the first call's turn, so the stored turn comes out in pieces.

You also need a [conversation store](/ai/quick-start) that every server reaches. `memoryStore` and `fileStore` belong to one machine. Use a store over a database, which is the same `ConversationStore` interface.

Sticky sessions would hide the problem for a reload, but not for a second tab, a phone and a laptop, or a server that restarts. This design needs no stickiness.

## What is shared, and why

Four pieces of state were one process's memory. Each has a different shape, so the interface has three small parts.

| State                                                                      | Why it has to be shared                                                                          | Part of the interface |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------- |
| Who is writing the reply for a conversation                                | Exactly one server may call the model, and a crashed server's claim has to end on its own        | A lease               |
| The reply as it is written                                                 | A page on any server shows the reply from its first chunk, however late it joined                | A channel             |
| The stop signal                                                            | Stop pressed on one server has to reach the server that is writing                               | A key-value store     |
| The voice call's recorded turn, its views, and the relay's one-use tickets | A call's tool calls, and the ticket and the connection that uses it, may be on different servers | A key-value store     |

The server that holds the lease runs the model and the tools, and writes the stored message. Every other server only relays: it reads the reply from the channel into a stream of its own, so any number of pages on that server read it, and the server holds one subscription per reply.

A page that finds no reply being written, and a message waiting, starts the reply: it claims the lease first. Of two servers that try at the same moment, one wins and the other joins.

## The one option

```ts
import { createChat } from "@bascik/ai/app";
import { redisShared } from "./redis-shared.ts"; // the adapter below

export const chat = createChat({
  store: databaseStore,
  catalog,
  model,
  system: "You help readers find books.",
  shared: redisShared(redis),
});
```

`shared` defaults to `inProcessShared()`, which is the old behavior: maps in this process, timers that do not keep it alive. Passing it explicitly changes nothing for one server.

## Hosts without shared memory

Some hosts run many requests in one process but do not let one request touch another request's I/O. On Cloudflare Workers, a request that waits on a stream or a promise another request created is canceled as hung. By default the kit does exactly that on one server: a reload reads the reply from the writing request's memory. On such a host, set `followLocally: false` and pass the host's context to `thread`:

```ts
export const chat = createChat({
  store: databaseStore,
  catalog,
  model,
  system: "You help readers find books.",
  shared: durableObjectShared(env), // your adapter, over a store every request reaches
  followLocally: false,
});

// In the route that streams the reply:
const { turn } = await chat.thread(request, context);
```

With `followLocally: false`, each request that did not start the reply follows it through `shared.subscribe` and the turn record, as a second server would. While it waits for the next piece, it keeps a one-second timer of its own pending, so the host does not take it for hung. Stop goes through the shared store, and the kit does not queue writes to one conversation in memory, so the conversation store has to settle two writes at once. `context.waitUntil` keeps the reply running after the reader leaves; see [the host's context](/ai/server-kit#the-hosts-context).

Two smaller things matter there too. Timers may be plain numbers, which the kit handles. And with the default, a reply whose writing request was canceled is dropped from memory once it has gone quiet and its turn record is missing on two looks, so a later page starts it again instead of waiting on it forever. The dropped writer is told to stop, in case it was still running.

## Writing an adapter

### The interface

Import the types from `@bascik/ai/shared`. Everything that crosses the interface is a string or a plain object of strings, so none of it needs a serializer of your own.

```ts
// All exported from "@bascik/ai/shared".
type ChannelEvent =
  | { type: "data"; data: string } // the next piece of the reply's HTML
  | { type: "end" }; // the reply is finished and stored

// What a subscriber receives: those, and "gap" first when the channel no
// longer holds the start of the reply.
type ChannelDelivery = ChannelEvent | { type: "gap" };

interface Lease {
  renew(): Promise<boolean>; // false when it is no longer held
  release(): Promise<void>;
}

interface Shared {
  claim(key: string, ttlMs: number): Promise<Lease | null>;
  publish(key: string, event: ChannelEvent): Promise<void>;
  subscribe(
    key: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ChannelDelivery>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  take(key: string): Promise<string | undefined>;
}
```

What each member must do:

- **`claim`** takes `key` for `ttlMs` if no one holds it and answers a handle, or answers `null`. `renew` extends the claim by the same `ttlMs` and answers `false` when it is no longer this holder's, which includes an expired claim another holder took. `release` of a claim that is no longer yours does nothing. The holder renews every five seconds against a fifteen second claim, so a crashed holder's claim ends within fifteen seconds.
- **`publish` and `subscribe`** are a replayable log per key. `subscribe` yields every retained event from the first, then new ones as they arrive, and finishes after it has yielded `end`, or when `signal` aborts. Keep the events of a reply for as long as a late reader might ask, and bound them. When the bound has dropped the start, yield `{ type: "gap" }` first, and the page says part of the reply is not shown until it is finished.
- **`get`, `set`, and `delete`** are a string store whose entries disappear after `ttlMs`.
- **`take`** reads and deletes in one step. Of two callers, one gets the value. This is what makes a ticket work once across servers.

`inProcessShared()` is a complete implementation in about two hundred lines. Read it, and `shared.test.ts` beside it, before writing your own.

### A Redis sketch

> This is an illustration, not a package. It shows that the interface fits Redis, with each member as the Redis commands that do it. It has not been run against a server, it ignores reconnection, and it does not detect a trimmed stream. Treat it as a starting point and test your own.

```ts
import { randomUUID } from "node:crypto";
import type { ChannelDelivery, ChannelEvent, Shared } from "@bascik/ai/shared";

/** The part of a Redis client the adapter uses: any client that can send a command by name. */
interface Redis {
  sendCommand(args: string[]): Promise<unknown>;
  /** A second connection, for the blocking read. */
  duplicate(): Redis;
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

// A claim is a key holding a random token. Renew and release must check it,
// so a holder whose claim expired cannot touch the next holder's.
const RENEW = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1]) else return 0 end`;

export function redisShared(
  redis: Redis,
  options: { replayEvents?: number; replayMs?: number } = {},
): Shared {
  const { replayEvents = 20_000, replayMs = 120_000 } = options;
  const run = (...args: (string | number)[]) =>
    redis.sendCommand(args.map(String));

  return {
    // SET key token NX PX ttl: set only if absent, and expire.
    async claim(key, ttlMs) {
      const token = randomUUID();
      if ((await run("SET", key, token, "NX", "PX", ttlMs)) !== "OK") {
        return null;
      }
      return {
        renew: async () =>
          (await run("EVAL", RENEW, 1, key, token, ttlMs)) === 1,
        release: async () => {
          await run("EVAL", RELEASE, 1, key, token);
        },
      };
    },

    // A stream is the replayable log. XADD appends and trims to a bound;
    // PEXPIRE lets the whole reply go once nobody can want it.
    async publish(key, event) {
      await run(
        "XADD",
        key,
        "MAXLEN",
        "~",
        replayEvents,
        "*",
        "event",
        JSON.stringify(event),
      );
      await run("PEXPIRE", key, replayMs);
    },

    // XREAD from "0" gives every retained event, then blocks for new ones.
    // The blocking read gets its own connection, and times out every second
    // so the signal is looked at.
    async *subscribe(key, { signal } = {}) {
      const reader = redis.duplicate();
      await reader.connect();
      try {
        let last = "0";
        while (!signal?.aborted) {
          const reply = (await reader.sendCommand([
            "XREAD",
            "BLOCK",
            "1000",
            "STREAMS",
            key,
            last,
          ])) as [string, [string, string[]][]][] | null;
          for (const [id, fields] of reply?.[0]?.[1] ?? []) {
            last = id;
            const event = JSON.parse(fields[1]!) as ChannelEvent;
            yield event satisfies ChannelDelivery;
            if (event.type === "end") return;
          }
        }
      } finally {
        await reader.disconnect();
      }
    },

    // PUBLISH on a channel per key, with the stream as the replay, is the
    // alternative to the blocking read when many servers follow one reply.

    async get(key) {
      return ((await run("GET", key)) as string | null) ?? undefined;
    },
    async set(key, value, ttlMs) {
      await run("SET", key, value, "PX", ttlMs);
    },
    async delete(key) {
      await run("DEL", key);
    },
    // GETDEL reads and deletes in one command, so a ticket is used once.
    async take(key) {
      return ((await run("GETDEL", key)) as string | null) ?? undefined;
    },
  };
}
```

With a Postgres adapter the lease is a row with an `expires` column and an insert that fails on a conflict, the channel is a table of events with `LISTEN` and `NOTIFY` to wake readers, and `take` is `DELETE ... RETURNING`. With a platform that has its own primitives (a Durable Object per conversation, for one), the lease and the channel are what that object already is.

## The Azure relay

An Azure Voice Live call is a WebSocket from the browser to a relay in one server's process, and from there to Azure. That connection is one process's, and no store can move it: the call stays on the server the browser reached for its whole length.

What has to be known to every server is the ticket. The ticket is made on one server by `createSession` and used by the browser to open the WebSocket, which a load balancer may send to another. Give the provider the same store:

```ts
const voice = azureVoiceLiveVoice({
  relay: { publicUrl: "wss://example.com/voice" },
  shared: redisShared(redis),
});
// Every server starts its relay when it starts, not when it first makes a ticket.
await voice.listen();
```

The ticket is stored with `set` and taken with `take`, so of two servers one honors it, once, and within its minute. A load balancer needs nothing special beyond this:

- It sends the `wss://` address in `relay.publicUrl` to any server that runs the relay. The ticket works wherever it lands.
- It must carry WebSocket upgrades and keep the connection open for the call's length (`sessionSeconds`, fifteen minutes by default). An idle timeout shorter than that ends calls early.
- Every server must call `listen()` at startup. A server that has never made a ticket has no relay listening otherwise.

A ticket holds the session's instructions, so the store that keeps tickets must be private to your servers. Tickets are withdrawn from the store when a provider closes.

## Limits and failure behavior

Timings are fixed: a claim lasts 15 seconds and is renewed every 5, the writing server looks for a stop signal every half second, and a server following a reply asks whether its writer is still there after 2 seconds of silence.

| What happens                                                                                    | What the reader sees                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The server writing a reply crashes                                                              | A page that was following it shows what it had, then "The server writing this reply stopped. Reload the page to write it again." That takes up to about twenty seconds. The reload finds no holder and a message waiting, and starts the reply on another server. |
| The writing server loses its claim (a long pause, a network split) and another server took over | Its page shows "This reply moved to another server. Reload the page to see it." It stops the model, and does not store its partial reply, so the new holder's reply is stored once.                                                                               |
| A page joins late, on any server                                                                | The whole reply so far, then the rest, as if it had been there from the start.                                                                                                                                                                                    |
| A page joins after the replay bound dropped the start                                           | A line saying the start is no longer available, then the rest. The finished reply is complete: it is stored whole.                                                                                                                                                |
| Stop is pressed on another server                                                               | The reply ends within about a second and what was written is stored, as with Stop on the writing server.                                                                                                                                                          |
| The shared store cannot be reached when a reply would start                                     | No reply starts, and the error goes to `onError`. The message stays waiting, so a reload tries again. The kit does not guess: starting without the claim could write the reply twice.                                                                             |
| The shared store goes away during a reply                                                       | The writing server finishes and stores the reply, and other servers stop following it. If the store stays away for the whole length of the claim, the writing server gives up as above.                                                                           |

What remains one process's, on purpose:

- **The reply's model call, its tools, and its broadcast on the holding server.** One server runs a reply start to finish. The shared channel is a copy for others, so a store outage does not slow the readers on the writing server.
- **The Azure audio connection**, as above.
- **A voice call's tool calls run one at a time per conversation for their bookkeeping, not their work.** Each call runs on a copy of the turn and merges what it changed under a short lock, so two tools that overlap, on one server or two, both end up in the stored turn.

The shared channel carries what the page shows, which can include a tool's output. Keep the store as private as the conversation store.

For how the kit works around the interface, see [Tools & Approval](/ai/tools#a-reply-that-outlives-its-page) for the broadcast and [Voice & Captions](/ai/voice#azure-voice-live) for the relay.
