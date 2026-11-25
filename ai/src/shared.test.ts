import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  inProcessShared,
  type ChannelDelivery,
  type Shared,
} from "./shared.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const data = (text: string) => ({ type: "data" as const, data: text });

/** Read a channel until it ends, aborts, or goes quiet. */
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

describe("inProcessShared: lease", () => {
  it("gives a key to one holder at a time", async () => {
    const shared = inProcessShared();
    const first = await shared.claim("a", 1000);
    expect(first).not.toBeNull();
    expect(await shared.claim("a", 1000)).toBeNull();
    // Another key is another lease.
    expect(await shared.claim("b", 1000)).not.toBeNull();
    await first!.release();
    expect(await shared.claim("a", 1000)).not.toBeNull();
  });

  it("expires when it is not renewed, and renewing keeps it", async () => {
    const shared = inProcessShared();
    const lease = (await shared.claim("a", 1000))!;
    vi.advanceTimersByTime(800);
    expect(await lease.renew()).toBe(true);
    vi.advanceTimersByTime(800);
    expect(await shared.claim("a", 1000)).toBeNull();
    vi.advanceTimersByTime(300);
    const next = await shared.claim("a", 1000);
    expect(next).not.toBeNull();
    // The one that lapsed cannot renew or release the new holder's claim.
    expect(await lease.renew()).toBe(false);
    await lease.release();
    expect(await shared.claim("a", 1000)).toBeNull();
    expect(await next!.renew()).toBe(true);
  });
});

describe("inProcessShared: channel", () => {
  it("replays from the first event to a late subscriber, and ends at the end event", async () => {
    const shared = inProcessShared();
    await shared.publish("c", data("one"));
    await shared.publish("c", data("two"));
    const early = drain(shared, "c");
    await shared.publish("c", data("three"));
    await shared.publish("c", { type: "end" });
    const expected = [data("one"), data("two"), data("three"), { type: "end" }];
    expect(await early).toEqual(expected);
    // Joining after the end still gets all of it.
    expect(await drain(shared, "c")).toEqual(expected);
  });

  it("starts a subscriber that came first when the first event arrives", async () => {
    const shared = inProcessShared();
    const waiting = drain(shared, "c");
    await shared.publish("c", data("x"));
    await shared.publish("c", { type: "end" });
    expect(await waiting).toEqual([data("x"), { type: "end" }]);
  });

  it("keeps channels apart", async () => {
    const shared = inProcessShared();
    await shared.publish("a", data("A"));
    await shared.publish("a", { type: "end" });
    await shared.publish("b", data("B"));
    await shared.publish("b", { type: "end" });
    expect(await drain(shared, "a")).toEqual([data("A"), { type: "end" }]);
    expect(await drain(shared, "b")).toEqual([data("B"), { type: "end" }]);
  });

  it("keeps a bounded replay and says when the start is gone", async () => {
    const shared = inProcessShared({ replayEvents: 3 });
    for (const text of ["1", "2", "3", "4", "5"]) {
      await shared.publish("c", data(text));
    }
    await shared.publish("c", { type: "end" });
    expect(await drain(shared, "c")).toEqual([
      { type: "gap" },
      data("4"),
      data("5"),
      { type: "end" },
    ]);
    // A subscriber that is behind when the bound passes it learns of the gap too.
    const slow = shared.subscribe("d")[Symbol.asyncIterator]();
    await shared.publish("d", data("a"));
    expect(await slow.next()).toEqual({ done: false, value: data("a") });
    for (const text of ["b", "c", "d", "e"]) {
      await shared.publish("d", data(text));
    }
    expect(await slow.next()).toEqual({ done: false, value: { type: "gap" } });
    expect(await slow.next()).toEqual({ done: false, value: data("c") });
  });

  it("stops a subscriber when its signal aborts", async () => {
    const shared = inProcessShared();
    const stop = new AbortController();
    const reading = drain(shared, "c", stop.signal);
    await shared.publish("c", data("x"));
    stop.abort();
    expect(await reading).toEqual([data("x")]);
  });

  it("forgets a channel nobody wrote to for a while, and lets its readers go", async () => {
    const shared = inProcessShared({ replayMs: 10_000 });
    await shared.publish("c", data("x"));
    const reading = drain(shared, "c");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await reading).toEqual([data("x")]);
    // A new subscriber finds nothing left to replay.
    const stop = new AbortController();
    const late = drain(shared, "c", stop.signal);
    stop.abort();
    expect(await late).toEqual([]);
  });
});

describe("inProcessShared: values", () => {
  it("stores, replaces, and deletes", async () => {
    const shared = inProcessShared();
    expect(await shared.get("k")).toBeUndefined();
    await shared.set("k", "one", 1000);
    await shared.set("k", "two", 1000);
    expect(await shared.get("k")).toBe("two");
    await shared.delete("k");
    expect(await shared.get("k")).toBeUndefined();
  });

  it("forgets a value after its time", async () => {
    const shared = inProcessShared();
    await shared.set("k", "v", 1000);
    vi.advanceTimersByTime(999);
    expect(await shared.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(await shared.get("k")).toBeUndefined();
  });

  it("gives a value to one taker", async () => {
    const shared = inProcessShared();
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
    const shared = inProcessShared();
    await shared.set("ticket", "v", 1000);
    vi.advanceTimersByTime(1001);
    expect(await shared.take("ticket")).toBeUndefined();
  });

  it("sweeps what nobody used again, and stops sweeping when empty", async () => {
    const shared = inProcessShared();
    await shared.set("k", "v", 1000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(await shared.get("k")).toBeUndefined();
  });
});
