import { describe, expect, it } from "vitest";
import { createChat, memoryStore, type Chat, type ChatOptions } from "./app.ts";
import { describeComponent, type Catalog } from "./catalog.ts";
import { inMemoryFiles, type FileStore } from "./files.ts";
import {
  filesOf,
  scriptedModel,
  type FilePart,
  type ModelRequest,
} from "./model.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<!-- @bascik One book. --><article><h3 data-bascik-prop-title></h3></article>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

const READER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
]);

const upload = (
  parts: { text?: string; files?: File[] },
  reader = READER,
  url = "http://localhost/api/send",
): Request => {
  const form = new FormData();
  if (parts.text !== undefined) form.set("text", parts.text);
  for (const file of parts.files ?? []) form.append("files", file);
  return new Request(url, {
    method: "POST",
    headers: { cookie: `visitor=${reader}` },
    body: form,
  });
};
const png = (name = "cover.png", type = "image/png") =>
  new File([PNG], name, { type });

const seen: ModelRequest[] = [];
function setup(options: Partial<ChatOptions> = {}): Chat {
  return createChat({
    id: "t",
    store: memoryStore(),
    catalog,
    model: () =>
      scriptedModel(
        (request) => {
          seen.push(request);
          return "Got it";
        },
        { delayMs: 0 },
      ),
    system: "You help.",
    page: "/books",
    files: inMemoryFiles(),
    onError: () => {},
    ...options,
  });
}

const conversationOf = async (chat: Chat, reader = READER) =>
  (await chat.list({ reader, conversationId: undefined }))[0]!;

describe("chat.send with files", () => {
  it("stores the files and puts file parts on the user message", async () => {
    const chat = setup();
    const response = await chat.send(
      upload({
        text: "Look at this",
        files: [
          png("../../cover.png"),
          new File(["# notes"], "n.md", { type: "" }),
        ],
      }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/books");
    const message = (await conversationOf(chat)).messages[0]!;
    expect(message.content).toBe("Look at this");
    expect(message.parts![0]).toEqual({ type: "text", text: "Look at this" });
    const files = filesOf(message);
    expect(files.map((one) => [one.name, one.mediaType, one.size])).toEqual([
      ["cover.png", "image/png", PNG.length],
      ["n.md", "text/markdown", 7],
    ]);
    // The bytes are in the store, under the reader.
    const stored = await chat.files!.get(READER, files[0]!.id);
    expect(stored!.bytes).toEqual(PNG);
  });

  it("makes the file ids itself", async () => {
    const chat = setup();
    const form = new FormData();
    form.set("text", "hi");
    form.set("id", "../../evil");
    form.append("files", png());
    await chat.send(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { cookie: `visitor=${READER}` },
        body: form,
      }),
    );
    const [file] = filesOf((await conversationOf(chat)).messages[0]!);
    expect(file!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("ignores an empty file input", async () => {
    const chat = setup();
    await chat.send(upload({ text: "just words", files: [new File([], "")] }));
    const message = (await conversationOf(chat)).messages[0]!;
    expect(message).toEqual({ role: "user", content: "just words" });
  });

  it("ignores uploads when the app has no file store", async () => {
    const chat = setup({ files: undefined });
    await chat.send(upload({ text: "hi", files: [png()] }));
    const message = (await conversationOf(chat)).messages[0]!;
    expect(message).toEqual({ role: "user", content: "hi" });
  });

  it("refuses a bad file with a page that names the reason and keeps the text", async () => {
    const chat = setup();
    const response = await chat.send(
      upload({
        text: "my <i>long</i> question",
        files: [new File(["<svg/>"], "a.svg", { type: "image/svg+xml" })],
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain('data-testid="attach-refused"');
    expect(body).toContain("HTML and SVG files are not allowed");
    expect(body).toContain("my &lt;i&gt;long&lt;/i&gt; question");
    expect(body).toContain('href="/books"');
    // Nothing was added or stored.
    expect(
      await chat.list({ reader: READER, conversationId: undefined }),
    ).toEqual([]);
  });

  it("stores nothing when one of several files is refused", async () => {
    const store = inMemoryFiles();
    const chat = setup({ files: store });
    const response = await chat.send(
      upload({
        text: "two",
        files: [
          png(),
          new File([new Uint8Array([0x61, 0, 0x62])], "bin.txt", {
            type: "text/plain",
          }),
        ],
      }),
    );
    expect(response.status).toBe(422);
    expect(
      await chat.list({ reader: READER, conversationId: undefined }),
    ).toEqual([]);
  });

  it("applies the limits the app sets", async () => {
    const chat = setup({ fileLimits: { maxFiles: 1, maxFileBytes: 5 } });
    const two = await chat.send(
      upload({ text: "a", files: [png(), png("b.png")] }),
    );
    expect(await two.text()).toContain("up to 1 file to one message");
    const big = await chat.send(upload({ text: "a", files: [png()] }));
    expect(await big.text()).toContain("is too large");
    const types = setup({ fileLimits: { types: ["text/plain"] } });
    const wrong = await types.send(upload({ text: "a", files: [png()] }));
    expect(await wrong.text()).toContain("Allowed types: plain text");
  });

  it("turns away a body far past the limits without reading it", async () => {
    const chat = setup({ fileLimits: { maxTotalBytes: 10 } });
    const request = upload({ text: "a" });
    const huge = new Request(request, {
      headers: { cookie: `visitor=${READER}`, "content-length": "999999999" },
    });
    expect((await chat.send(huge)).status).toBe(422);
  });

  it("removes what was stored when storing fails part way", async () => {
    const inner = inMemoryFiles();
    let puts = 0;
    const flaky: FileStore = {
      ...inner,
      async put(reader, id, file) {
        if (++puts === 2) throw new Error("disk full");
        await inner.put(reader, id, file);
      },
    };
    const chat = setup({ files: flaky });
    const response = await chat.send(
      upload({ text: "x", files: [png(), png("two.png")] }),
    );
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("could not be saved");
    expect(
      await chat.list({ reader: READER, conversationId: undefined }),
    ).toEqual([]);
  });

  it("lets a message be only files", async () => {
    const chat = setup();
    await chat.send(upload({ text: "", files: [png()] }));
    const conversation = await conversationOf(chat);
    expect(conversation.title).toBe("cover.png");
    expect(conversation.messages[0]!.parts).toHaveLength(1);
  });

  it("does not store files for a voice call's message", async () => {
    const chat = setup();
    const form = new FormData();
    form.set("text", "hi");
    form.set("voice", "1");
    form.append("files", png());
    const response = await chat.send(
      new Request("http://localhost/api/send", {
        method: "POST",
        headers: { cookie: `visitor=${READER}` },
        body: form,
      }),
    );
    expect(await response.json()).toEqual({ say: "hi" });
  });
});

describe("chat.file", () => {
  async function stored(chat: Chat): Promise<FilePart> {
    await chat.send(upload({ text: "x", files: [png()] }));
    return filesOf((await conversationOf(chat)).messages[0]!)[0]!;
  }
  const get = (id: string, reader = READER, method = "GET") =>
    new Request(`http://localhost/api/file?id=${encodeURIComponent(id)}`, {
      method,
      headers: { cookie: `visitor=${reader}` },
    });

  it("serves the file to its reader with the guard headers", async () => {
    const chat = setup();
    const file = await stored(chat);
    const response = await chat.file(get(file.id));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(response.headers.get("content-disposition")).toMatch(/^inline/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 to another reader, to no cookie, and to a made-up id", async () => {
    const chat = setup();
    const file = await stored(chat);
    expect((await chat.file(get(file.id, OTHER))).status).toBe(404);
    expect(
      (await chat.file(new Request(`http://localhost/api/file?id=${file.id}`)))
        .status,
    ).toBe(404);
    for (const id of [
      "nope",
      "../../etc/passwd",
      "",
      "a/b",
      `${file.id}.json`,
    ]) {
      expect((await chat.file(get(id))).status).toBe(404);
    }
    expect(
      (await chat.file(new Request("http://localhost/api/file"))).status,
    ).toBe(404);
  });

  it("answers 404 when the app has no file store, and 405 to a POST", async () => {
    expect((await setup({ files: undefined }).file(get("x"))).status).toBe(404);
    const chat = setup();
    const post = await chat.file(get((await stored(chat)).id, READER, "POST"));
    expect(post.status).toBe(405);
  });
});

describe("the model's request", () => {
  it("can read the bytes of an attached file, and only the reader's own", async () => {
    seen.length = 0;
    const chat = setup();
    await chat.send(upload({ text: "see", files: [png()] }));
    const page = new Request("http://x/books", {
      headers: {
        cookie: `visitor=${READER}; chat_t=${(await conversationOf(chat)).id}`,
      },
    });
    const state = await chat.thread(page);
    await state.turn?.over;
    const request = seen.at(-1)!;
    const [file] = filesOf(request.messages[0]!);
    expect(await request.readFile!(file!)).toEqual(PNG);
    // A file part pointing at someone else's file reads as gone.
    expect(
      await request.readFile!({ ...file!, id: "someone-elses" }),
    ).toBeNull();
  });

  it("has no readFile when the app takes no attachments", async () => {
    seen.length = 0;
    const chat = setup({ files: undefined });
    await chat.send(upload({ text: "see" }));
    const page = new Request("http://x/books", {
      headers: {
        cookie: `visitor=${READER}; chat_t=${(await conversationOf(chat)).id}`,
      },
    });
    await (
      await chat.thread(page)
    ).turn?.over;
    expect(seen.at(-1)!.readFile).toBeUndefined();
  });
});
