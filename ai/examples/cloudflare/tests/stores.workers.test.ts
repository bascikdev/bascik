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

  it("a read writes nothing: no alarm, no data", async () => {
    const stores = readerStores(bindings.READER, { prefix: "reads:" });
    expect(await stores.conversations.list(READER)).toEqual([]);
    expect(await stores.memories.list(READER)).toEqual([]);
    await runInDurableObject(objectOf("reads:"), async (_, state) => {
      expect(await state.storage.getAlarm()).toBeNull();
    });
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

  it("is typed as the class the binding names", () => {
    const stub: DurableObjectStub<ReaderData> = objectOf("types:");
    expect(typeof stub.load).toBe("function");
  });
});
