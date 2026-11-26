/**
 * What every `ConversationStore` has to do, as a suite: the in-memory and
 * file stores run it here. The suite is internal to this package and not
 * published; a store over another database (a Durable Object, SQL) elsewhere
 * copies it into its own tests.
 *
 * The Vitest functions are passed in, so this module loads nothing from
 * Vitest itself; it runs under Vitest or a runner with the same `describe`,
 * `it`, and `expect`.
 */
import type { describe, expect, it } from "vitest";
import {
  limitConversations,
  newConversation,
  type Conversation,
  type ConversationStore,
} from "./store.ts";

/** The test functions a contract registers its cases with. */
export interface ContractTest {
  describe: typeof describe;
  it: typeof it;
  expect: typeof expect;
}

export interface ConversationStoreContractOptions {
  /** False when the store has no `summaries`: its cases are left out. Default true. */
  summaries?: boolean;
  /** False when the store has no `delete`: its cases are left out. Default true. */
  delete?: boolean;
}

const READER = "11111111-1111-4111-8111-111111111111";
const OTHER = "someone-else";

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

const at = (updatedAt: number, text = "hi"): Conversation => ({
  ...newConversation(),
  updatedAt,
  messages: [{ role: "user", content: text }],
});

/**
 * Register the cases every conversation store passes. `make` returns a new,
 * empty store each time it is called.
 */
export function conversationStoreContract(
  name: string,
  make: () => ConversationStore | Promise<ConversationStore>,
  { describe, it, expect }: ContractTest,
  options: ConversationStoreContractOptions = {},
): void {
  const { summaries = true, delete: deletes = true } = options;

  describe(name, () => {
    it("loads what was saved, as a copy", async () => {
      const store = await make();
      const saved = at(5, "one");
      await store.save(READER, saved);
      const loaded = await store.load(READER, saved.id);
      expect(loaded).toEqual(saved);
      loaded!.messages.push({ role: "user", content: "changed, not saved" });
      expect((await store.load(READER, saved.id))!.messages).toHaveLength(1);
      saved.title = "changed after saving";
      expect((await store.load(READER, saved.id))!.title).toBe("New chat");
    });

    it("answers null for a conversation that is not there", async () => {
      const store = await make();
      expect(await store.load(READER, newConversation().id)).toBeNull();
    });

    it("replaces a conversation saved again", async () => {
      const store = await make();
      const saved = at(1);
      await store.save(READER, saved);
      await store.save(READER, { ...saved, title: "Renamed" });
      expect((await store.load(READER, saved.id))!.title).toBe("Renamed");
      expect(await store.list(READER)).toHaveLength(1);
    });

    it("lists a reader's conversations newest first", async () => {
      const store = await make();
      const [old, middle, recent] = [at(1), at(2), at(3)];
      for (const conversation of [middle, recent, old]) {
        await store.save(READER, conversation);
      }
      expect((await store.list(READER)).map((entry) => entry.id)).toEqual([
        recent.id,
        middle.id,
        old.id,
      ]);
    });

    if (summaries) {
      it("summarizes every conversation without its messages, in list's order", async () => {
        const store = await make();
        expect(store.summaries).toBeTypeOf("function");
        const saved = [at(2, "b"), at(3, "c"), at(1, "a")];
        for (const conversation of saved)
          await store.save(READER, conversation);
        const listed = await store.list(READER);
        expect(await store.summaries!(READER)).toEqual(
          listed.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
        );
        expect(await store.summaries!(OTHER)).toEqual([]);
        expect(await store.summaries!("../escape")).toEqual([]);
      });
    }

    if (deletes) {
      it("deletes a conversation, and a missing one without an error", async () => {
        const store = await make();
        expect(store.delete).toBeTypeOf("function");
        const [kept, gone] = [at(1), at(2)];
        await store.save(READER, kept);
        await store.save(READER, gone);
        await store.delete!(READER, gone.id);
        await store.delete!(READER, gone.id);
        await store.delete!(READER, newConversation().id);
        await store.delete!(OTHER, kept.id);
        expect(await store.load(READER, gone.id)).toBeNull();
        expect((await store.list(READER)).map((entry) => entry.id)).toEqual([
          kept.id,
        ]);
        for (const bad of HOSTILE) {
          await store.delete!(bad, kept.id);
          await store.delete!(READER, bad);
        }
        expect(await store.load(READER, kept.id)).toEqual(kept);
      });
    }

    it("keeps one reader's conversations from another", async () => {
      const store = await make();
      const mine = at(1);
      await store.save(READER, mine);
      expect(await store.load(OTHER, mine.id)).toBeNull();
      expect(await store.list(OTHER)).toEqual([]);
    });

    it("will not use a hostile id or reader as a key", async () => {
      const store = await make();
      const conversation = at(1);
      await store.save(READER, conversation);
      for (const bad of HOSTILE) {
        expect(await store.load(READER, bad), bad).toBeNull();
        expect(await store.load(bad, conversation.id), bad).toBeNull();
        expect(await store.list(bad), bad).toEqual([]);
        await expect(
          store.save(READER, { ...conversation, id: bad }),
          bad,
        ).rejects.toThrow();
        await expect(store.save(bad, conversation), bad).rejects.toThrow();
      }
    });

    describe("under limitConversations", () => {
      if (deletes) {
        it("keeps a reader to the cap by deleting their oldest", async () => {
          const store = limitConversations(await make(), 5);
          const saved = Array.from({ length: 8 }, (_, n) => at(n + 1));
          // Saved newest first: the oldest is the least updatedAt, not the first saved.
          for (const entry of [...saved].reverse()) {
            await store.save(READER, entry);
          }
          expect((await store.list(READER)).map((entry) => entry.id)).toEqual(
            [saved[7], saved[6], saved[5], saved[4], saved[0]].map(
              (entry) => entry!.id,
            ),
          );
        });
      }

      it("never deletes to save a conversation it already has", async () => {
        const store = limitConversations(await make(), 3);
        const saved = [at(1), at(2), at(3)];
        for (const entry of saved) await store.save(READER, entry);
        await store.save(READER, { ...saved[0]!, title: "Renamed" });
        expect(await store.list(READER)).toHaveLength(3);
        expect((await store.load(READER, saved[0]!.id))!.title).toBe("Renamed");
      });

      if (deletes) {
        it("holds the cap when new conversations arrive at once", async () => {
          const store = limitConversations(await make(), 4);
          await Promise.all(
            Array.from({ length: 20 }, (_, n) => store.save(READER, at(n + 1))),
          );
          expect(await store.list(READER)).toHaveLength(4);
        });

        it("counts each reader on their own", async () => {
          const store = limitConversations(await make(), 2);
          const others = [at(1), at(2)];
          for (const entry of others) await store.save(OTHER, entry);
          for (const n of [3, 4, 5]) await store.save(READER, at(n));
          expect((await store.list(OTHER)).map((entry) => entry.id)).toEqual([
            others[1]!.id,
            others[0]!.id,
          ]);
          expect(await store.list(READER)).toHaveLength(2);
        });
      }
    });
  });
}
