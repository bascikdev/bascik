import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileStore,
  limitConversations,
  MAX_CONVERSATIONS,
  memoryStore,
  newConversation,
  type Conversation,
  type ConversationStore,
} from "./store.ts";

const READER = "11111111-1111-4111-8111-111111111111";
const at = (updatedAt: number, text = "hi"): Conversation => ({
  ...newConversation(),
  updatedAt,
  messages: [{ role: "user", content: text }],
});

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

function behavesAsAStore(make: () => Promise<ConversationStore>): void {
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

  it("deletes a conversation, and a missing one without an error", async () => {
    const store = await make();
    const [kept, gone] = [at(1), at(2)];
    await store.save(READER, kept);
    await store.save(READER, gone);
    await store.delete!(READER, gone.id);
    await store.delete!(READER, gone.id);
    await store.delete!(READER, newConversation().id);
    await store.delete!("someone-else", kept.id);
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

  it("keeps one reader's conversations from another", async () => {
    const store = await make();
    const mine = at(1);
    await store.save(READER, mine);
    expect(await store.load("someone-else", mine.id)).toBeNull();
    expect(await store.list("someone-else")).toEqual([]);
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
}

describe("memoryStore", () => {
  behavesAsAStore(async () => memoryStore());

  it("is a store of its own each time", async () => {
    const saved = at(1);
    await memoryStore().save(READER, saved);
    expect(await memoryStore().load(READER, saved.id)).toBeNull();
  });
});

describe("fileStore", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(
      folders.splice(0).map((folder) => rm(folder, { recursive: true })),
    );
  });
  const folder = async (): Promise<string> => {
    const made = await mkdtemp(join(tmpdir(), "genui-store-"));
    folders.push(made);
    return made;
  };

  behavesAsAStore(async () => fileStore(await folder()));

  it("keeps one JSON file per conversation under the reader", async () => {
    const directory = await folder();
    const saved = at(1, "kept");
    await fileStore(directory).save(READER, saved);
    expect(await readdir(join(directory, READER))).toEqual([
      `${saved.id}.json`,
    ]);
    expect(
      JSON.parse(
        await readFile(join(directory, READER, `${saved.id}.json`), "utf8"),
      ),
    ).toEqual(saved);
    // A second store over the same folder sees it.
    expect(await fileStore(directory).load(READER, saved.id)).toEqual(saved);
  });

  it("writes nothing outside its folder for a hostile id", async () => {
    const directory = await folder();
    const inside = join(directory, "inside");
    const store = fileStore(inside);
    await expect(
      store.save(READER, { ...at(1), id: "../../escape" }),
    ).rejects.toThrow();
    await expect(store.save("../..", at(1))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("skips files in the folder that are not conversations", async () => {
    const directory = await folder();
    const store = fileStore(directory);
    const saved = at(1);
    await store.save(READER, saved);
    const own = join(directory, READER);
    await writeFile(join(own, "broken.json"), "{not json");
    await writeFile(
      join(own, "other.json"),
      JSON.stringify({ hello: "world" }),
    );
    await writeFile(join(own, "notes.txt"), "not a conversation");
    await mkdir(join(own, "folder.json"));
    expect((await store.list(READER)).map((entry) => entry.id)).toEqual([
      saved.id,
    ]);
    expect(await store.load(READER, "broken")).toBeNull();
    expect(await store.load(READER, "other")).toBeNull();
  });

  it("lists every conversation, newest first by updatedAt, not by file time", async () => {
    const directory = await folder();
    const own = join(directory, READER);
    await mkdir(own, { recursive: true });
    const total = 250;
    const saved = Array.from({ length: total }, (_, n) => at(n + 1));
    // File times that disagree with updatedAt, so they are not the answer.
    for (const [n, entry] of saved.entries()) {
      const file = join(own, `${entry.id}.json`);
      await writeFile(file, JSON.stringify(entry));
      const seconds = 1_700_000_000 + ((n * 37) % total);
      await utimes(file, seconds, seconds);
    }
    const listed = await fileStore(directory).list(READER);
    expect(listed.map((entry) => entry.updatedAt)).toEqual(
      saved.map((entry) => entry.updatedAt).reverse(),
    );
  });

  it("never opens a link or a pipe in the reader's folder", async () => {
    const directory = await folder();
    const store = fileStore(directory);
    const saved = at(1);
    await store.save(READER, saved);
    const own = join(directory, READER);
    await symlink(join(own, `${saved.id}.json`), join(own, "linked.json"));
    // Reading a pipe would wait forever for a writer.
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [join(own, "pipe.json")]);
    }
    expect((await store.list(READER)).map((entry) => entry.id)).toEqual([
      saved.id,
    ]);
  });

  it("brings an overfull folder back to the cap at the next new conversation", async () => {
    const directory = await folder();
    const own = join(directory, READER);
    await mkdir(own, { recursive: true });
    const old = Array.from({ length: 40 }, (_, n) => at(n + 1));
    for (const entry of old) {
      await writeFile(join(own, `${entry.id}.json`), JSON.stringify(entry));
    }
    const store = limitConversations(fileStore(directory), 10);
    const fresh = at(1000);
    await store.save(READER, fresh);
    expect(await readdir(own)).toHaveLength(10);
    expect((await store.list(READER)).map((entry) => entry.id)).toEqual([
      fresh.id,
      ...old
        .slice(-9)
        .map((entry) => entry.id)
        .reverse(),
    ]);
  });

  it("leaves no partial file behind", async () => {
    const directory = await folder();
    const store = fileStore(directory);
    await Promise.all(
      Array.from({ length: 10 }, (_, n) => store.save(READER, at(n))),
    );
    const files = await readdir(join(directory, READER));
    expect(files).toHaveLength(10);
    expect(files.every((file) => file.endsWith(".json"))).toBe(true);
  });
});

describe("limitConversations", () => {
  const folders: string[] = [];
  afterEach(async () => {
    await Promise.all(
      folders.splice(0).map((folder) => rm(folder, { recursive: true })),
    );
  });
  const stores: Array<[string, () => Promise<ConversationStore>]> = [
    ["memoryStore", async () => memoryStore()],
    [
      "fileStore",
      async () => {
        const made = await mkdtemp(join(tmpdir(), "genui-limit-"));
        folders.push(made);
        return fileStore(made);
      },
    ],
  ];

  for (const [name, make] of stores) {
    describe(name, () => {
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

      it("never deletes to save a conversation it already has", async () => {
        const store = limitConversations(await make(), 3);
        const saved = [at(1), at(2), at(3)];
        for (const entry of saved) await store.save(READER, entry);
        await store.save(READER, { ...saved[0]!, title: "Renamed" });
        expect(await store.list(READER)).toHaveLength(3);
        expect((await store.load(READER, saved[0]!.id))!.title).toBe("Renamed");
      });

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
        for (const entry of others) await store.save("someone-else", entry);
        for (const n of [3, 4, 5]) await store.save(READER, at(n));
        expect(
          (await store.list("someone-else")).map((entry) => entry.id),
        ).toEqual([others[1]!.id, others[0]!.id]);
        expect(await store.list(READER)).toHaveLength(2);
      });
    });
  }

  it("keeps MAX_CONVERSATIONS, 200, by default", async () => {
    expect(MAX_CONVERSATIONS).toBe(200);
    const store = limitConversations(memoryStore());
    for (let n = 0; n < MAX_CONVERSATIONS + 10; n += 1) {
      await store.save(READER, at(n));
    }
    expect(await store.list(READER)).toHaveLength(MAX_CONVERSATIONS);
  });

  it("refuses a new conversation at the cap when the store cannot delete", async () => {
    const { delete: _remove, ...inner } = memoryStore();
    const store = limitConversations(inner, 2);
    const [first, second] = [at(1), at(2)];
    await store.save(READER, first);
    await store.save(READER, second);
    await expect(store.save(READER, at(3))).rejects.toThrow(
      /already has 2 conversations/,
    );
    // What the reader has can still be saved: the refusal did not stick.
    await store.save(READER, { ...first, title: "Renamed" });
    expect(await store.list(READER)).toHaveLength(2);
    expect(store.delete).toBeUndefined();
  });

  it("passes search and delete through only when the store has them", async () => {
    const found = {
      id: "a",
      title: "t",
      updatedAt: 1,
      snippet: "s",
      marks: [],
    };
    const store = limitConversations({
      ...memoryStore(),
      search: async () => [found],
    });
    expect(await store.search!(READER, "dune", 5)).toEqual([found]);
    expect(store.delete).toBeTypeOf("function");
    expect(limitConversations(memoryStore()).search).toBeUndefined();
  });

  it("refuses a cap that is not a whole number of at least 1", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => limitConversations(memoryStore(), bad), String(bad)).toThrow(
        RangeError,
      );
    }
  });
});
