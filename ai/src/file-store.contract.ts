/**
 * What every `FileStore` has to do, as a suite any implementation can run:
 * the in-memory and disk stores here, and a store over object storage (R2, a
 * Durable Object) wherever its tests live.
 *
 * The Vitest functions are passed in, so this module loads nothing from
 * Vitest itself.
 */
import type { ContractTest } from "./conversation-store.contract.ts";
import type { FileStore, StoredFile } from "./files.ts";

const READER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "33333333-3333-4333-8333-333333333333";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

const stored = (name = "a.png"): StoredFile => ({
  name,
  mediaType: "image/png",
  size: PNG.length,
  bytes: PNG.slice(),
});

/** Readers and ids a store must refuse before it uses one as a key or a path. */
const HOSTILE = [
  "../x",
  "..",
  "a/b",
  "a\\b",
  "C:\\x",
  "a\0b",
  "",
  "a".repeat(129),
  "id.json",
];

/**
 * Register the cases every file store passes. `make` returns a new, empty
 * store each time it is called.
 */
export function fileStoreContract(
  name: string,
  make: () => FileStore | Promise<FileStore>,
  { describe, it, expect }: ContractTest,
): void {
  describe(name, () => {
    it("keeps a file for its reader and hands out copies", async () => {
      const store = await make();
      const put = stored("cover.png");
      await store.put(READER, ID, put);
      // Changing what was put, after it was put, changes nothing stored.
      put.bytes[0] = 0;
      const first = await store.get(READER, ID);
      expect(first).toEqual(stored("cover.png"));
      first!.bytes[0] = 0;
      expect((await store.get(READER, ID))!.bytes[0]).toBe(0x89);
    });

    it("never gives one reader's file to another", async () => {
      const store = await make();
      await store.put(READER, ID, stored());
      expect(await store.get(OTHER, ID)).toBeNull();
    });

    it("answers null for an unknown id and removes a file", async () => {
      const store = await make();
      expect(await store.get(READER, ID)).toBeNull();
      await store.put(READER, ID, stored());
      await store.remove(READER, ID);
      expect(await store.get(READER, ID)).toBeNull();
      await store.remove(READER, ID);
    });

    it.each(HOSTILE)("refuses the hostile id %j", async (hostile) => {
      const store = await make();
      await expect(store.put(READER, hostile, stored())).rejects.toThrow();
      await expect(store.put(hostile, ID, stored())).rejects.toThrow();
      expect(await store.get(READER, hostile)).toBeNull();
      expect(await store.get(hostile, ID)).toBeNull();
      await store.remove(READER, hostile);
    });
  });
}
