import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileStore,
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
