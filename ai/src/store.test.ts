import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChat } from "./app.ts";
import { scriptedModel, type ChatMessage } from "./model.ts";
import {
  fileStore,
  limitConversations,
  MAX_CONVERSATION_BYTES,
  MAX_CONVERSATIONS,
  memoryStore,
  newConversation,
  type Conversation,
  type ConversationStore,
} from "./store.ts";
import type { VoiceProvider } from "./voice.ts";

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

  it("summarizes every conversation without its messages, in list's order", async () => {
    const store = await make();
    const saved = [at(2, "b"), at(3, "c"), at(1, "a")];
    for (const conversation of saved) await store.save(READER, conversation);
    const listed = await store.list(READER);
    expect(await store.summaries!(READER)).toEqual(
      listed.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    );
    expect(await store.summaries!("someone-else")).toEqual([]);
    expect(await store.summaries!("../escape")).toEqual([]);
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

  it("summarizes from the start of each file, and reads all of one it did not write", async () => {
    const directory = await folder();
    const store = fileStore(directory);
    const long = at(2, "x".repeat(50_000));
    long.title = 'A "quoted" title \\ with ✓';
    await store.save(READER, long);
    const own = join(directory, READER);
    expect(
      (await readFile(join(own, `${long.id}.json`), "utf8")).startsWith(
        `{"id":${JSON.stringify(long.id)},"title":`,
      ),
    ).toBe(true);
    // Written by something else, with its fields in another order.
    const foreign = at(1);
    const { messages, ...rest } = foreign;
    await writeFile(
      join(own, `${foreign.id}.json`),
      JSON.stringify({ messages, ...rest }),
    );
    await writeFile(join(own, "broken.json"), "{");
    expect(await store.summaries!(READER)).toEqual([
      { id: long.id, title: long.title, updatedAt: 2 },
      { id: foreign.id, title: foreign.title, updatedAt: 1 },
    ]);
  });

  it("answers every one of many lists at once, a few at a time", async () => {
    const store = fileStore(await folder());
    const saved = Array.from({ length: 40 }, (_, n) => at(n + 1));
    for (const entry of saved) await store.save(READER, entry);
    const lists = await Promise.all(
      Array.from({ length: 12 }, () => store.list(READER)),
    );
    for (const listed of lists) expect(listed).toHaveLength(40);
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
      expect(
        () => limitConversations(memoryStore(), 5, bad),
        `bytes ${bad}`,
      ).toThrow(RangeError);
    }
  });

  it("counts with summaries, so a list that returns a page cannot lift the cap", async () => {
    const inner = memoryStore();
    const paged: ConversationStore = {
      ...inner,
      list: async (reader) => (await inner.list(reader)).slice(0, 50),
    };
    const store = limitConversations(paged, 100);
    for (let n = 0; n < 500; n += 1) await store.save(READER, at(n + 1));
    expect(await inner.summaries!(READER)).toHaveLength(100);
    expect(store.summaries).toBeTypeOf("function");
  });

  it("never reads whole conversations to save one", async () => {
    const inner = memoryStore();
    const read: string[] = [];
    const watched: ConversationStore = {
      ...inner,
      load: (reader, id) => (read.push("load"), inner.load(reader, id)),
      list: (reader) => (read.push("list"), inner.list(reader)),
    };
    const store = limitConversations(watched, 3);
    const first = at(1);
    for (const entry of [first, at(2), at(3), at(4)]) {
      await store.save(READER, entry);
    }
    await store.save(READER, { ...first, title: "Again" });
    expect(read).toEqual([]);
  });

  it("holds the cap across two chats over one store", async () => {
    const shared = memoryStore();
    const [a, b] = [
      limitConversations(shared, 5),
      limitConversations(shared, 5),
    ];
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        (n % 2 ? a : b).save(READER, at(n + 1)),
      ),
    );
    expect(await shared.list(READER)).toHaveLength(5);
  });

  it("still saves a new conversation when the count cannot be read", async () => {
    const inner = memoryStore();
    const { summaries: _summaries, ...rest } = inner;
    const broken: ConversationStore = {
      ...rest,
      list: async () => {
        throw new Error("the database is down");
      },
    };
    const store = limitConversations(broken, 2);
    const fresh = at(1);
    await store.save(READER, fresh);
    expect(await inner.load(READER, fresh.id)).not.toBeNull();
  });

  describe("how long one conversation grows", () => {
    const turn = (n: number, size: number): ChatMessage[] => [
      { role: "user", content: `${n} ${"y".repeat(size)}` },
      { role: "assistant", content: `${n} ${"z".repeat(size)}` },
    ];
    const bytes = (value: unknown): number =>
      Buffer.byteLength(JSON.stringify(value));

    it("keeps MAX_CONVERSATION_BYTES, 1 MiB, by default", () => {
      expect(MAX_CONVERSATION_BYTES).toBe(1024 * 1024);
    });

    it("drops the oldest messages to fit, starting at something the reader said", async () => {
      const inner = memoryStore();
      const store = limitConversations(inner, 5, 10_000);
      const conversation = at(1);
      conversation.messages = [];
      for (let n = 0; n < 40; n += 1) {
        conversation.messages.push(...turn(n, 1000));
        await store.save(READER, conversation);
      }
      // What the caller saved is not changed.
      expect(conversation.messages).toHaveLength(80);
      const kept = (await inner.load(READER, conversation.id))!;
      expect(bytes(kept)).toBeLessThanOrEqual(10_000);
      expect(kept.messages[0]!.role).toBe("user");
      expect(kept.messages.at(-1)!.content.startsWith("39 ")).toBe(true);
      // As few as it takes: one more turn would not have fitted.
      expect(
        bytes({ ...kept, messages: [...turn(38, 1000), ...kept.messages] }),
      ).toBeGreaterThan(10_000);
      expect(kept.messages.length).toBeGreaterThan(4);
    });

    it("keeps only the newest message when it alone is too long", async () => {
      const inner = memoryStore();
      const store = limitConversations(inner, 5, 1000);
      const conversation = at(1, "x".repeat(500));
      conversation.messages.push({
        role: "assistant",
        content: "y".repeat(2000),
      });
      await store.save(READER, conversation);
      expect(
        (await inner.load(READER, conversation.id))!.messages.map(
          (message) => message.role,
        ),
      ).toEqual(["assistant"]);
    });

    it("keeps what list returns within the cap times the bytes, however much is sent", async () => {
      const directory = await mkdtemp(join(tmpdir(), "genui-bytes-"));
      folders.push(directory);
      const store = limitConversations(fileStore(directory), 4, 8000);
      for (let c = 0; c < 10; c += 1) {
        const conversation = { ...newConversation(), updatedAt: c + 1 };
        for (let n = 0; n < 20; n += 1) {
          conversation.messages.push(...turn(n, 900));
          await store.save(READER, conversation);
        }
      }
      const listed = await store.list(READER);
      expect(listed).toHaveLength(4);
      for (const entry of listed) {
        expect(bytes(entry)).toBeLessThanOrEqual(8000);
      }
    });

    it("stays within the cap through the chat's voice turns, with no model call", async () => {
      const directory = await mkdtemp(join(tmpdir(), "genui-voice-"));
      folders.push(directory);
      let calls = 0;
      const voice: VoiceProvider = {
        protocol: "fake",
        async createSession() {
          return { protocol: "fake", url: "wss://example.test/", setup: null };
        },
      };
      const chat = createChat({
        id: "t",
        store: fileStore(directory),
        catalog: new Map(),
        model: () => {
          calls += 1;
          return scriptedModel(() => "never");
        },
        system: "You help.",
        voice,
        onError: () => {},
      });
      const opened = { ...newConversation(), messages: [] };
      await chat.store.save(READER, opened);
      const said = "y".repeat(8000);
      for (let n = 0; n < 60; n += 1) {
        const response = await chat.voiceTurn(
          new Request("http://localhost/api/voice-turn", {
            method: "POST",
            headers: { cookie: `visitor=${READER}; chat_t=${opened.id}` },
            body: new URLSearchParams({ reader: said, model: said }),
          }),
        );
        expect(response.status).toBe(204);
      }
      const file = join(directory, READER, `${opened.id}.json`);
      expect((await stat(file)).size).toBeLessThanOrEqual(
        MAX_CONVERSATION_BYTES,
      );
      const kept = (await chat.store.load(READER, opened.id))!.messages;
      expect(kept.length).toBeLessThan(120);
      expect(kept[0]!.role).toBe("user");
      expect(kept.at(-1)!.role).toBe("assistant");
      expect(calls).toBe(0);
    });
  });
});
