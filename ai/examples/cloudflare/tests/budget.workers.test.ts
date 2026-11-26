/**
 * Budget counts exactly under concurrency, forgets itself by alarm, and
 * turns away a new reader once the day's cap is reached.
 */
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { charge, readerStores } from "../src/lib/cf-stores.ts";
import { DEMO_FULL, utcDay, type Env } from "../src/lib/env.ts";

const bindings = env as unknown as Env;

describe("Budget", () => {
  it("counts 50 charges at once exactly, and refuses past the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        charge(bindings.BUDGET, "ip:test:1", "sends", 30, 60_000),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(30);
    const stub = bindings.BUDGET.get(bindings.BUDGET.idFromName("ip:test:1"));
    expect(await stub.count("sends")).toBe(30);
  });

  it("deletes its counters when the window is over", async () => {
    await charge(bindings.BUDGET, "ip:test:2", "sends", 30, 60_000);
    const stub = bindings.BUDGET.get(bindings.BUDGET.idFromName("ip:test:2"));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.count("sends")).toBe(0);
  });

  it("counts a new reader once, however many first writes arrive at once", async () => {
    const day = bindings.BUDGET.get(
      bindings.BUDGET.idFromName(`day:${utcDay()}`),
    );
    const before = await day.count("readers");
    const stores = readerStores(bindings.READER, { prefix: "eager:" });
    const reader = "88888888-8888-4888-8888-888888888888";
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        stores.memories.add(reader, { id: `m${n}`, text: "x", created: n }),
      ),
    );
    expect(await day.count("readers")).toBe(before + 1);
    // A later write by the same reader is not a first write.
    await stores.memories.add(reader, { id: "later", text: "y", created: 99 });
    expect(await day.count("readers")).toBe(before + 1);
  });

  it("refuses a new reader's first write once the day's cap is reached", async () => {
    // tests/wrangler.test.jsonc sets GENUI_DAILY_READERS to 400.
    const day = bindings.BUDGET.get(
      bindings.BUDGET.idFromName(`day:${utcDay()}`),
    );
    while (await day.charge("readers", 400, 60_000)) {
      // Fill the day up.
    }
    const stores = readerStores(bindings.READER, { prefix: "full:" });
    const reader = "55555555-5555-4555-8555-555555555555";
    await expect(
      stores.memories.add(reader, { id: "m1", text: "x", created: 1 }),
    ).rejects.toThrow(DEMO_FULL);
    expect(await stores.memories.list(reader)).toEqual([]);
  });
});
