/**
 * What every `Shared` has to do, as a suite: `inProcessShared` runs it here.
 * The suite is internal to this package and not published; an adapter over
 * Redis, Postgres, or Durable Objects elsewhere copies it into its own tests.
 *
 * The Vitest functions are passed in, so this module loads nothing from
 * Vitest itself (a runner with Vitest's `describe`, `it`, and `expect` can
 * run it). Time is passed in too: `advance` moves the implementation's
 * clock, by fake timers for one in this process, or by waiting for one whose
 * clock cannot be faked. The cases leave hundreds of milliseconds of margin
 * around every deadline, so a real wait and the time calls take still pass.
 */
import type { ContractTest } from "./conversation-store.contract.ts";
import type {
  ChannelDelivery,
  ChannelEvent,
  InProcessSharedOptions,
  Shared,
} from "./shared.ts";

export interface SharedContractOptions {
  /**
   * Move time on by `ms`, letting any timers that fall due run. The cases
   * use leases, values, and channel retention of a second, and wait at most
   * two seconds plus `sweepMs` in one case.
   */
  advance(ms: number): Promise<void>;
  /**
   * How long past `replayMs` the implementation may still keep a channel
   * before it forgets it, such as its sweep interval. Default 0.
   */
  sweepMs?: number;
}

/** A case's own time limit: its waits, plus room for the calls around them. */
const timeoutFor = (waitMs: number): number => waitMs + 5000;

/**
 * The retention a case asks `make` for. An implementation keeps at most
 * `replayEvents` events of a channel, and forgets a channel `replayMs` after
 * its last event; a case that does not name one takes the default.
 */
export type SharedBounds = InProcessSharedOptions;

const data = (text: string): ChannelEvent => ({ type: "data", data: text });
const END: ChannelEvent = { type: "end" };

/** Read a channel until it ends or aborts. */
async function drain(
  shared: Shared,
  key: string,
  signal?: AbortSignal,
): Promise<ChannelDelivery[]> {
  const seen: ChannelDelivery[] = [];
  for await (const event of shared.subscribe(key, { signal })) {
    seen.push(event);
  }
  return seen;
}

/**
 * Register the cases every `Shared` passes. `make` returns a new, empty one
 * each time it is called, with the retention it is given.
 */
export function sharedContract(
  name: string,
  make: (bounds?: SharedBounds) => Shared | Promise<Shared>,
  { describe, it, expect }: ContractTest,
  { advance, sweepMs = 0 }: SharedContractOptions,
): void {
  describe(name, () => {
    describe("lease", () => {
      it("gives a key to one holder at a time", async () => {
        const shared = await make();
        const first = await shared.claim("a", 1000);
        expect(first).not.toBeNull();
        expect(await shared.claim("a", 1000)).toBeNull();
        // Another key is another lease.
        expect(await shared.claim("b", 1000)).not.toBeNull();
        await first!.release();
        expect(await shared.claim("a", 1000)).not.toBeNull();
      });

      it("expires when it is not renewed, and renewing keeps it", async () => {
        const shared = await make();
        const lease = (await shared.claim("a", 1000))!;
        await advance(500);
        expect(await lease.renew()).toBe(true);
        // Past the first claim's second, inside the renewed one.
        await advance(500);
        expect(await shared.claim("a", 1000)).toBeNull();
        await advance(1000);
        const next = await shared.claim("a", 1000);
        expect(next).not.toBeNull();
        // The one that lapsed cannot renew or release the new holder's claim.
        expect(await lease.renew()).toBe(false);
        await lease.release();
        expect(await shared.claim("a", 1000)).toBeNull();
        expect(await next!.renew()).toBe(true);
      });

      it("cannot renew a claim once it is released", async () => {
        const shared = await make();
        const lease = (await shared.claim("a", 1000))!;
        await lease.release();
        expect(await lease.renew()).toBe(false);
        // Releasing again does nothing, and the key is free.
        await lease.release();
        expect(await shared.claim("a", 1000)).not.toBeNull();
      });
    });

    describe("channel", () => {
      it("replays from the first event to a late subscriber, and ends at the end event", async () => {
        const shared = await make();
        await shared.publish("c", data("one"));
        await shared.publish("c", data("two"));
        const early = drain(shared, "c");
        await shared.publish("c", data("three"));
        await shared.publish("c", END);
        const expected = [data("one"), data("two"), data("three"), END];
        expect(await early).toEqual(expected);
        // Joining after the end still gets all of it.
        expect(await drain(shared, "c")).toEqual(expected);
      });

      it("starts a subscriber that came first when the first event arrives", async () => {
        const shared = await make();
        const waiting = drain(shared, "c");
        await shared.publish("c", data("x"));
        await shared.publish("c", END);
        expect(await waiting).toEqual([data("x"), END]);
      });

      it("keeps channels apart", async () => {
        const shared = await make();
        await shared.publish("a", data("A"));
        await shared.publish("a", END);
        await shared.publish("b", data("B"));
        await shared.publish("b", END);
        expect(await drain(shared, "a")).toEqual([data("A"), END]);
        expect(await drain(shared, "b")).toEqual([data("B"), END]);
      });

      it("keeps a bounded replay and says when the start is gone", async () => {
        const shared = await make({ replayEvents: 3 });
        for (const text of ["1", "2", "3", "4", "5"]) {
          await shared.publish("c", data(text));
        }
        await shared.publish("c", END);
        expect(await drain(shared, "c")).toEqual([
          { type: "gap" },
          data("4"),
          data("5"),
          END,
        ]);
        // A subscriber that is behind when the bound passes it learns of the gap too.
        const slow = shared.subscribe("d")[Symbol.asyncIterator]();
        await shared.publish("d", data("a"));
        expect(await slow.next()).toEqual({ done: false, value: data("a") });
        for (const text of ["b", "c", "d", "e"]) {
          await shared.publish("d", data(text));
        }
        expect(await slow.next()).toEqual({
          done: false,
          value: { type: "gap" },
        });
        expect(await slow.next()).toEqual({ done: false, value: data("c") });
      });

      it("stops a subscriber when its signal aborts", async () => {
        const shared = await make();
        const stop = new AbortController();
        const reading = shared
          .subscribe("c", { signal: stop.signal })
          [Symbol.asyncIterator]();
        await shared.publish("c", data("x"));
        // However long delivery takes, the event arrives before the abort.
        expect(await reading.next()).toEqual({ done: false, value: data("x") });
        stop.abort();
        expect(await reading.next()).toEqual({ done: true, value: undefined });
      });

      const forgetWait = 2000 + sweepMs;
      it(
        "forgets a channel nobody wrote to for a while, and lets its readers go",
        async () => {
          const shared = await make({ replayMs: 1000 });
          await shared.publish("c", data("x"));
          const reading = drain(shared, "c");
          await advance(forgetWait);
          expect(await reading).toEqual([data("x")]);
          // A new subscriber finds nothing left to replay: only what comes next.
          await shared.publish("c", END);
          expect(await drain(shared, "c")).toEqual([END]);
        },
        timeoutFor(forgetWait),
      );
    });

    describe("values", () => {
      it("stores, replaces, and deletes", async () => {
        const shared = await make();
        expect(await shared.get("k")).toBeUndefined();
        await shared.set("k", "one", 1000);
        await shared.set("k", "two", 1000);
        expect(await shared.get("k")).toBe("two");
        await shared.delete("k");
        expect(await shared.get("k")).toBeUndefined();
      });

      it("forgets a value after its time", async () => {
        const shared = await make();
        await shared.set("k", "v", 1000);
        await advance(500);
        expect(await shared.get("k")).toBe("v");
        await advance(1000);
        expect(await shared.get("k")).toBeUndefined();
      });

      it("gives a value to one taker", async () => {
        const shared = await make();
        await shared.set("ticket", "v", 1000);
        const takers = await Promise.all([
          shared.take("ticket"),
          shared.take("ticket"),
          shared.take("ticket"),
        ]);
        expect(takers.filter((value) => value === "v")).toHaveLength(1);
        expect(await shared.get("ticket")).toBeUndefined();
      });

      it("gives nothing for an expired value", async () => {
        const shared = await make();
        await shared.set("ticket", "v", 1000);
        await advance(2000);
        expect(await shared.take("ticket")).toBeUndefined();
      });
    });
  });
}
