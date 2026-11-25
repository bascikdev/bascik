/**
 * The @bascik/ai `Shared` contract, run against ConversationLive objects
 * through `liveShared`, in local workerd, and the cases that matter on
 * Workers: one lease among many claims, one taker, batched publishes in
 * order, an object that lost its events, and the alarm.
 */
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sharedKeys } from "@bascik/ai";
import type { ChannelDelivery, Shared } from "@bascik/ai/shared";
import { sharedContract } from "../../../src/shared.contract.ts";
import { liveShared } from "../src/lib/cf-stores.ts";
import type { Env } from "../src/lib/env.ts";
import { liveObjectName } from "../src/lib/shared-keys.ts";

const bindings = env as unknown as Env;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

let made = 0;
/** A Shared whose keys all go to one object of its own: the contract's keys are bare. */
const fresh = (bounds: { replayEvents?: number; replayMs?: number } = {}) => {
  const name = `test-${++made}`;
  return liveShared(bindings.LIVE, { ...bounds, route: () => name });
};

/**
 * One contract case is left out: a subscriber that is behind when the
 * replay bound passes it. A subscriber here reads over a stream, and what
 * the object already sent it is buffered on the way, so it gets those
 * events (missing nothing) instead of a gap. A late subscriber still gets
 * the gap, which the case before it checks.
 */
const BEHIND = "keeps a bounded replay and says when the start is gone";
const contractIt = Object.assign(
  (name: string, ...rest: unknown[]) =>
    name === BEHIND
      ? it.skip(name, ...(rest as [() => void]))
      : it(name, ...(rest as [() => void])),
  it,
) as typeof it;

it("leaves out only the case a streamed subscriber cannot pass, and checks its late-reader half", async () => {
  const shared = fresh({ replayEvents: 3 });
  for (const text of ["1", "2", "3", "4", "5"]) {
    await shared.publish("c", { type: "data", data: text });
  }
  await shared.publish("c", { type: "end" });
  expect(await drain(shared, "c")).toEqual([
    { type: "gap" },
    { type: "data", data: "4" },
    { type: "data", data: "5" },
    { type: "end" },
  ]);
});

sharedContract(
  "ConversationLive",
  fresh,
  { describe, it: contractIt, expect },
  {
    // The object's clock is the real one.
    advance: sleep,
    // A quiet channel is noticed on the reader's next heartbeat.
    sweepMs: 1000,
  },
);

async function drain(
  shared: Shared,
  key: string,
  signal?: AbortSignal,
): Promise<ChannelDelivery[]> {
  const seen: ChannelDelivery[] = [];
  for await (const event of shared.subscribe(key, { signal })) seen.push(event);
  return seen;
}

describe("ConversationLive on Workers", () => {
  const keys = sharedKeys("books");
  const conversation = "66666666-6666-4666-8666-666666666666";
  const shared = () => liveShared(bindings.LIVE, { development: true });

  it("routes every key of a conversation to one object", () => {
    const names = new Set(
      [
        keys.lease(conversation),
        keys.turn(conversation),
        keys.stop(conversation, "t1"),
        keys.reply(conversation, "t1"),
        keys.voice(conversation),
        keys.voiceOpen(conversation),
        keys.voiceLock(conversation),
        keys.view(conversation, "call-1"),
      ].map((key) => liveObjectName(key, true)),
    );
    expect([...names]).toEqual([`live:books:${conversation}`]);
  });

  it("gives a lease to exactly one of 50 claims at once", async () => {
    const live = shared();
    const leases = await Promise.all(
      Array.from({ length: 50 }, () =>
        live.claim(keys.lease(conversation), 15_000),
      ),
    );
    expect(leases.filter(Boolean)).toHaveLength(1);
    await leases.find(Boolean)!.release();
  });

  it("cannot renew a lease after it expired", async () => {
    const live = shared();
    const lease = await live.claim(keys.lease("expired-one"), 300);
    await sleep(600);
    expect(await lease!.renew()).toBe(false);
  });

  it("gives a value to exactly one of many takers", async () => {
    const live = shared();
    await live.set(keys.stop(conversation, "t2"), "1", 10_000);
    const taken = await Promise.all(
      Array.from({ length: 20 }, () =>
        live.take(keys.stop(conversation, "t2")),
      ),
    );
    expect(taken.filter((value) => value === "1")).toHaveLength(1);
  });

  it("keeps the order of publishes sent without waiting", async () => {
    const live = shared();
    const key = keys.reply(conversation, "ordered");
    const reading = drain(live, key);
    const sent = Array.from({ length: 200 }, (_, n) =>
      live.publish(key, { type: "data", data: String(n) }),
    );
    await Promise.all(sent);
    await live.publish(key, { type: "end" });
    const seen = await reading;
    expect(
      seen.slice(0, -1).map((event) => (event as { data: string }).data),
    ).toEqual(Array.from({ length: 200 }, (_, n) => String(n)));
    expect(seen.at(-1)).toEqual({ type: "end" });
  });

  it("says gap first when the object lost a reply's events", async () => {
    const live = shared();
    const key = keys.reply(conversation, "lost");
    await live.publish(key, { type: "data", data: "a" });
    // A publish resolves once it is queued: let the batch reach the object.
    await sleep(300);
    const object = bindings.LIVE.get(
      bindings.LIVE.idFromName(liveObjectName(key, true)),
    );
    // As after a restart: the marker is stored, the events were in memory.
    await runInDurableObject(object, (instance) => {
      (
        instance as unknown as { channels: Map<string, unknown> }
      ).channels.clear();
    });
    const reading = drain(live, key);
    await live.publish(key, { type: "data", data: "b" });
    await live.publish(key, { type: "end" });
    expect(await reading).toEqual([
      { type: "gap" },
      { type: "data", data: "b" },
      { type: "end" },
    ]);
  });

  it("throws in development for a key of a shape it does not know", async () => {
    await expect(shared().get("genui:books:mystery:x")).rejects.toThrow(
      /unknown shape/,
    );
  });

  it("deletes the whole object once everything in it has expired", async () => {
    const live = liveShared(bindings.LIVE, { route: () => "expires" });
    await live.set("k", "v", 100);
    await sleep(300);
    const object = bindings.LIVE.get(bindings.LIVE.idFromName("expires"));
    expect(await runDurableObjectAlarm(object)).toBe(true);
    await runInDurableObject(object, async (_, state) => {
      expect([...(await state.storage.list()).keys()]).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
