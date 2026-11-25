/**
 * The @bascik/ai contract suites, run against the ReaderData object through
 * the store clients, in local workerd. Each `make` gets readers of its own.
 */
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationStoreContract } from "../../../src/conversation-store.contract.ts";
import { fileStoreContract } from "../../../src/file-store.contract.ts";
import { memoryStoreContract } from "../../../src/memory-store.contract.ts";
import { readerStores } from "../src/lib/cf-stores.ts";
import type { Env } from "../src/lib/env.ts";
import { CHUNK_BYTES, type ReaderData } from "../do/reader-data.ts";

const bindings = env as unknown as Env;
let made = 0;
const fresh = () =>
  readerStores(bindings.READER, { prefix: `test-${++made}:` });

conversationStoreContract(
  "ReaderData conversations",
  () => fresh().conversations,
  {
    describe,
    it,
    expect,
  },
);
memoryStoreContract("ReaderData memories", () => fresh().memories, {
  describe,
  it,
  expect,
});
fileStoreContract("ReaderData files", () => fresh().files, {
  describe,
  it,
  expect,
});

const READER = "44444444-4444-4444-8444-444444444444";
const objectOf = (prefix: string) =>
  bindings.READER.get(bindings.READER.idFromName(`${prefix}${READER}`));

describe("ReaderData", () => {
  it("keeps a file of several pieces intact", async () => {
    const stores = readerStores(bindings.READER, { prefix: "pieces:" });
    const bytes = new Uint8Array(CHUNK_BYTES * 2 + 1234).map((_, n) => n % 251);
    await stores.files.put(READER, "file-1", {
      name: "big.bin",
      mediaType: "application/pdf",
      size: bytes.byteLength,
      bytes,
    });
    const back = await stores.files.get(READER, "file-1");
    expect(back?.size).toBe(bytes.byteLength);
    expect(back?.bytes).toEqual(bytes);
  });

  it("makes room for a new file by dropping the oldest past 3 MB", async () => {
    const stores = readerStores(bindings.READER, { prefix: "room:" });
    const file = (n: number) => ({
      name: `f${n}.pdf`,
      mediaType: "application/pdf",
      size: 1024 * 1024,
      bytes: new Uint8Array(1024 * 1024).fill(n),
    });
    for (const n of [1, 2, 3, 4]) {
      await stores.files.put(READER, `f${n}`, file(n));
      // Distinct creation times, so "oldest" is well defined.
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(await stores.files.get(READER, "f1")).toBeNull();
    expect((await stores.files.get(READER, "f4"))?.bytes[0]).toBe(4);
  });

  it("a read or a delete writes nothing: no alarm, no tables, no data", async () => {
    const stores = readerStores(bindings.READER, { prefix: "reads:" });
    expect(await stores.conversations.list(READER)).toEqual([]);
    expect(await stores.conversations.summaries!(READER)).toEqual([]);
    expect(await stores.conversations.load(READER, "c1")).toBeNull();
    expect(await stores.memories.list(READER)).toEqual([]);
    expect(await stores.memories.search(READER, "tea", 5)).toEqual([]);
    expect(await stores.files.get(READER, "f1")).toBeNull();
    await stores.conversations.delete!(READER, "c1");
    expect(await stores.memories.remove(READER, "m1")).toBe(false);
    await stores.files.remove(READER, "f1");
    await runInDurableObject(objectOf("reads:"), async (_, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
      // Making the tables would be a write: a visitor who only looks keeps nothing.
      const tables = state.storage.sql
        .exec<{
          name: string;
        }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name)
        .filter((name) => !name.startsWith("_cf_"));
      expect(tables).toEqual([]);
    });
    // The first write still makes them.
    await stores.memories.add(READER, { id: "m1", text: "tea", created: 1 });
    expect(await stores.memories.remove(READER, "m1")).toBe(true);
  });

  it("forgets everything 24 hours after the last write, and works again after", async () => {
    const stores = readerStores(bindings.READER, { prefix: "expiry:" });
    await stores.memories.add(READER, {
      id: "m1",
      text: "Likes tea",
      created: 1,
    });
    await runInDurableObject(objectOf("expiry:"), async (_, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    });
    expect(await runDurableObjectAlarm(objectOf("expiry:"))).toBe(true);
    expect(await stores.memories.list(READER)).toEqual([]);
    // The alarm's deleteAll dropped the tables: the next write makes them again.
    await stores.memories.add(READER, {
      id: "m2",
      text: "Likes jazz",
      created: 2,
    });
    expect((await stores.memories.list(READER)).map((m) => m.id)).toEqual([
      "m2",
    ]);
  });

  it("keeps a reader to 50 memories, dropping the oldest", async () => {
    const stores = readerStores(bindings.READER, { prefix: "many:" });
    for (let n = 1; n <= 52; n++) {
      await stores.memories.add(READER, {
        id: `m${n}`,
        text: `n${n}`,
        created: n,
      });
    }
    const listed = await stores.memories.list(READER);
    expect(listed).toHaveLength(50);
    expect(listed.at(-1)!.id).toBe("m3");
  });

  it("a Budget call that fails once does not refuse the reader's later writes", async () => {
    const object = objectOf("budget-fails:");
    await runInDurableObject(object, (instance) => {
      let calls = 0;
      const real = bindings.BUDGET;
      // The day's Budget object throws on its first charge, then answers.
      (instance as unknown as { env: Env }).env = {
        ...bindings,
        BUDGET: {
          idFromName: (name: string) => real.idFromName(name),
          get: (id: DurableObjectId) => ({
            charge: async (...args: [string, number, number]) => {
              if (++calls === 1) throw new Error("Budget is overloaded");
              return real.get(id).charge(...args);
            },
          }),
        } as unknown as Env["BUDGET"],
      };
    });
    const memory = { id: "m1", text: "tea", created: 1 };
    const failed = await object.addMemory(memory).then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(failed)).toMatch(/overloaded/);
    await object.addMemory(memory);
    expect((await object.listMemories()).map((m) => m.id)).toEqual(["m1"]);
  });

  it("is typed as the class the binding names", () => {
    const stub: DurableObjectStub<ReaderData> = objectOf("types:");
    expect(typeof stub.load).toBe("function");
  });
});
