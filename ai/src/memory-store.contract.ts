/**
 * What every `MemoryStore` has to do, as a suite: the in-memory and file
 * stores run it here. The suite is internal to this package and not
 * published; a store over another database (a Durable Object, a vector
 * index) elsewhere copies it into its own tests.
 *
 * The Vitest functions are passed in, so this module loads nothing from
 * Vitest itself.
 */
import type { ContractTest } from "./conversation-store.contract.ts";
import type { Memory, MemoryStore } from "./memory.ts";

const READER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Readers and ids a store must never use as a key or a path. */
const HOSTILE = [
  "../escape",
  "..",
  ".",
  "a/b",
  "a\\b",
  "/etc/passwd",
  "C:\\x",
  "a\0b",
  "",
  "x".repeat(200),
  "%2e%2e",
];

const memory = (id: string, text: string, created: number): Memory => ({
  id,
  text,
  created,
});

/**
 * Register the cases every memory store passes. `make` returns a new, empty
 * store each time it is called.
 *
 * The search cases hold a store to the ranking `searchMemories` gives (shared
 * words, then recency). A store that ranks another way, by meaning, passes
 * `{ wordSearch: false }` and is checked only for what any search must do.
 */
export function memoryStoreContract(
  name: string,
  make: () => MemoryStore | Promise<MemoryStore>,
  { describe, it, expect }: ContractTest,
  options: { wordSearch?: boolean } = {},
): void {
  const { wordSearch = true } = options;

  describe(name, () => {
    it("lists what was added, newest first, as copies", async () => {
      const store = await make();
      await store.add(READER, memory("a", "Likes tea", 1));
      await store.add(READER, memory("b", "Likes jazz", 2));
      const listed = await store.list(READER);
      expect(listed.map((entry) => entry.id)).toEqual(["b", "a"]);
      listed[0]!.text = "changed, not saved";
      expect((await store.list(READER))[0]!.text).toBe("Likes jazz");
    });

    it("replaces a memory added again with the same id", async () => {
      const store = await make();
      await store.add(READER, memory("a", "one", 1));
      await store.add(READER, { ...memory("a", "two", 1), updated: 5 });
      expect(await store.list(READER)).toEqual([
        { id: "a", text: "two", created: 1, updated: 5 },
      ]);
    });

    it("removes one, and says whether there was one", async () => {
      const store = await make();
      await store.add(READER, memory("a", "one", 1));
      expect(await store.remove(READER, "a")).toBe(true);
      expect(await store.remove(READER, "a")).toBe(false);
      expect(await store.list(READER)).toEqual([]);
    });

    it("keeps each reader's memories apart", async () => {
      const store = await make();
      await store.add(READER, memory("a", "mine", 1));
      expect(await store.list(OTHER)).toEqual([]);
      expect(await store.search(OTHER, "mine", 5)).toEqual([]);
      expect(await store.remove(OTHER, "a")).toBe(false);
      expect(await store.list(READER)).toHaveLength(1);
    });

    if (wordSearch) {
      it("searches by shared words, then recency", async () => {
        const store = await make();
        await store.add(READER, memory("a", "Prefers short books", 1));
        await store.add(READER, memory("b", "Lives in Lisbon", 2));
        await store.add(
          READER,
          memory("c", "Likes short stories and short books", 3),
        );
        await store.add(READER, memory("d", "Prefers tea", 4));
        const found = await store.search(READER, "short books", 5);
        expect(found.map((entry) => entry.id)).toEqual(["c", "a"]);
        expect(await store.search(READER, "nothing like it", 5)).toEqual([]);
        expect(await store.search(READER, "short books", 1)).toHaveLength(1);
      });
    }

    it("answers the newest for an empty query", async () => {
      const store = await make();
      await store.add(READER, memory("a", "one", 1));
      await store.add(READER, memory("b", "two", 2));
      expect((await store.search(READER, "  ", 1)).map((m) => m.id)).toEqual([
        "b",
      ]);
    });

    it("never lets a reader or a memory id become a path or a key", async () => {
      const store = await make();
      for (const bad of HOSTILE) {
        await expect(store.add(bad, memory("a", "x", 1))).rejects.toThrow();
        expect(await store.list(bad)).toEqual([]);
        expect(await store.search(bad, "x", 5)).toEqual([]);
        expect(await store.remove(bad, "a")).toBe(false);
        await expect(store.add(READER, memory(bad, "x", 1))).rejects.toThrow();
      }
      expect(await store.remove(READER, "../a")).toBe(false);
      expect(await store.list(READER)).toEqual([]);
    });
  });
}
