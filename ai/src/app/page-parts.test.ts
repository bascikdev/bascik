import { html } from "@bascik/bascik/html";
import { describe, expect, it } from "vitest";
import {
  chatProject,
  conversationList,
  conversationSearch,
  createChat,
  liveTurn,
  memoryList,
  memoryStore,
  modelMenu,
  newConversation,
  storedTurns,
  type Chat,
  type ChatOptions,
  type ChatProject,
} from "../app.ts";
import { describeComponent, type Catalog } from "../catalog.ts";
import { inMemoryMemories } from "../memory.ts";
import { scriptedModel, type ChatMessage } from "../model.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<!-- @bascik One book. --><article><h3 data-bascik-prop-title></h3></article>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

const READER = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

function setup(options: Partial<ChatOptions> = {}): Chat {
  return createChat({
    id: "t",
    store: memoryStore(),
    catalog,
    model: () => scriptedModel(() => "Hello there", { delayMs: 0 }),
    system: "You help.",
    onError: () => {},
    ...options,
  });
}

/** A page request from the reader, with a conversation open or none. */
const page = (path = "/", conversation: string | undefined = CONVERSATION) =>
  new Request(`http://x${path}`, {
    headers: {
      cookie: [`visitor=${READER}`, conversation && `chat_t=${conversation}`]
        .filter(Boolean)
        .join("; "),
    },
  });

async function seed(
  chat: Chat,
  messages: ChatMessage[],
  id = CONVERSATION,
  title = "A talk about books",
): Promise<void> {
  await chat.store.save(READER, {
    ...newConversation(),
    id,
    title,
    messages,
  });
}

const TALK: ChatMessage[] = [
  { role: "user", content: "Recommend a <b>book</b>" },
  { role: "assistant", content: "Read **Dune**." },
];

/** Everything a stream yields, as one string. */
async function collect(stream: AsyncIterable<unknown>): Promise<string> {
  let out = "";
  for await (const piece of stream) out += String(piece);
  return out;
}

describe("chatProject", () => {
  const chat = setup();

  it("takes the module import() returns, the module, or its default export", async () => {
    const project = { chat, app: "books" };
    for (const from of [
      Promise.resolve({ default: project }),
      { default: project },
      project,
    ]) {
      expect(await chatProject(from, page())).toBe(project);
    }
  });

  it("calls a function with the request and the platform's context", async () => {
    const seen: unknown[] = [];
    const source = (request: Request, context?: { env: string }) => {
      seen.push(request.url, context);
      return Promise.resolve({ chat, app: "docs" });
    };
    const project = await chatProject({ default: source }, page("/docs"), {
      env: "bindings",
    });
    expect(project.app).toBe("docs");
    expect(seen).toEqual(["http://x/docs", { env: "bindings" }]);
  });

  it("says what to create when the module is missing", async () => {
    const missing = Promise.reject(
      new Error(
        "Cannot find module '/site/src/lib/chat.ts' imported from data:text/javascript;charset=utf-8,import%20x",
      ),
    );
    const failure = await chatProject(missing, page()).catch(
      (error: Error) => error,
    );
    expect((failure as Error).message).toMatch(
      /could not be loaded: Cannot find module '\/site\/src\/lib\/chat\.ts'\nCreate src\/lib\/chat\.ts with a default export[\s\S]*createChat/,
    );
    // The script that imported it is noise: the reason stops before it.
    expect((failure as Error).message).not.toContain("data:text");
  });

  it("says what the default export must be when it is something else", async () => {
    for (const wrong of [
      {},
      { default: undefined },
      { default: {} },
      { default: { chat: {} } },
      { default: () => ({ chat: "no" }) },
      // A module that exports the chat itself, not a project.
      { default: chat },
    ]) {
      await expect(
        chatProject(wrong as { default?: unknown }, page()),
      ).rejects.toThrow(
        /default export of src\/lib\/chat\.ts is not a chat project[\s\S]*Create src\/lib\/chat\.ts/,
      );
    }
  });
});

describe("storedTurns", () => {
  it("prints the welcome for an empty conversation, with the project's words as text", async () => {
    const project: ChatProject = {
      chat: setup(),
      welcome: {
        heading: "What <next>?",
        tagline: "A shop & more",
        note: "Kept for a day.",
        suggestions: [{ label: "Pick <one>", say: 'Say "hi"' }],
      },
    };
    const out = await collect(storedTurns(project, page("/", undefined)));
    expect(out).toContain('data-bascik-prop-heading="What &lt;next&gt;?"');
    expect(out).toContain('data-bascik-prop-tagline="A shop &amp; more"');
    expect(out).toMatch(
      /<template data-bascik-slot="note"\s*><p>Kept for a day\.<\/p><\/template\s*>/,
    );
    expect(out).toMatch(
      /<ask-button data-bascik-prop-say="Say &quot;hi&quot;"\s*>Pick &lt;one&gt;<\/ask-button\s*>/,
    );
    expect(out).not.toContain("data-chat-part");
  });

  it("gives the welcome its own words with none set, and a note written as markup as it is", async () => {
    const chat = setup();
    const plain = await collect(storedTurns({ chat }, page("/", undefined)));
    expect(plain).toContain('data-bascik-prop-heading="How can I help?"');
    expect(plain).toContain('data-bascik-prop-tagline=""');
    expect(plain).not.toContain("data-bascik-slot");
    expect(plain).not.toContain("ask-button");
    const noted = await collect(
      storedTurns(
        { chat, welcome: { note: html`<p data-testid="kept">A day.</p>` } },
        page("/", undefined),
      ),
    );
    expect(noted).toMatch(
      /<template data-bascik-slot="note"\s*><p data-testid="kept">A day\.<\/p><\/template\s*>/,
    );
  });

  it("prints no welcome when the project wants none", async () => {
    const out = await collect(
      storedTurns({ chat: setup(), welcome: false }, page("/", undefined)),
    );
    expect(out).toBe("");
  });

  it("prints each stored turn with the marks the thread styles, the reader's words as text", async () => {
    const chat = setup();
    await seed(chat, TALK);
    const pieces: string[] = [];
    for await (const piece of storedTurns({ chat }, page())) {
      pieces.push(String(piece));
    }
    // One piece per message, so each is sent as it is rendered.
    expect(pieces).toHaveLength(2);
    // Tight against its tags: the turn keeps the reader's own line breaks.
    expect(pieces[0]).toBe(
      '<p class="turn-user" data-chat-part="turn" data-role="user" data-testid="turn-user">Recommend a &lt;b&gt;book&lt;/b&gt;</p>',
    );
    expect(pieces[1]).toMatch(
      /<div\s+class="turn-assistant"\s+data-chat-part="turn"\s+data-role="assistant"\s+data-testid="turn-assistant"\s*>Read <strong>Dune<\/strong>\.<\/div\s*>/,
    );
    expect(pieces.join("")).not.toContain("chat-welcome");
  });

  it("links a message's files to the file route, the project's when it names one", async () => {
    const chat = setup();
    await seed(chat, [
      {
        role: "user",
        content: "Look",
        parts: [
          { type: "text", text: "Look" },
          {
            type: "file",
            id: "file_1",
            name: 'a "cover".png',
            mediaType: "image/png",
            size: 2048,
          },
          {
            type: "file",
            id: "file_2",
            name: "notes.txt",
            mediaType: "text/plain",
            size: 12,
          },
        ],
      },
      { role: "assistant", content: "Seen." },
    ]);
    const out = await collect(storedTurns({ chat }, page()));
    expect(out).toContain('data-chat-part="files"');
    expect(out).toContain('data-bascik-prop-href="/api/file?id=file_1"');
    // An image is its own preview; another file has none.
    expect(out).toContain('data-bascik-prop-thumb="/api/file?id=file_1"');
    expect(out).not.toContain('data-bascik-prop-thumb="/api/file?id=file_2"');
    expect(out).toContain('data-bascik-prop-name="a &quot;cover&quot;.png"');
    const moved = await collect(
      storedTurns({ chat, routes: { file: "/files/get?kind=chat" } }, page()),
    );
    expect(moved).toContain(
      'data-bascik-prop-href="/files/get?kind=chat&amp;id=file_2"',
    );
  });

  it("shows the last 40 messages with a link to the rest, and all of them when asked", async () => {
    const chat = setup();
    const long: ChatMessage[] = [];
    for (let index = 0; index < 23; index++) {
      long.push(
        { role: "user", content: `Question ${index}` },
        { role: "assistant", content: `Answer ${index}` },
      );
    }
    await seed(chat, long);
    const recent = await collect(storedTurns({ chat }, page()));
    expect(recent).toMatch(
      /href="\?all"\s+data-chat-part="earlier"\s+data-testid="chat-earlier"\s*>Show 6 earlier messages</,
    );
    expect(recent).not.toContain("Question 2<");
    expect(recent).toContain("Question 3<");
    const all = await collect(storedTurns({ chat }, page("/?all")));
    expect(all).not.toContain("chat-earlier");
    expect(all).toContain("Question 0<");
    const worded = await collect(
      storedTurns(
        { chat, words: { earlier: (count) => `${count} ältere <zeigen>` } },
        page(),
      ),
    );
    expect(worded).toMatch(/>6 ältere &lt;zeigen&gt;<\/a/);
  });

  it("hands the host's context to the chat", async () => {
    const chat = setup();
    const seen: unknown[] = [];
    const host = { waitUntil: () => {} };
    const watched: Chat = {
      ...chat,
      thread: (request, context) => {
        seen.push(context);
        return chat.thread(request, context);
      },
    };
    await collect(storedTurns({ chat: watched, host }, page("/", undefined)));
    await collect(liveTurn({ chat: watched, host }, page("/", undefined)));
    expect(seen).toEqual([host, host]);
  });

  it("says in the thread that the chat is not set up, then fails with what to create", async () => {
    const pieces: string[] = [];
    const run = (async () => {
      const missing = Promise.reject(new Error("Cannot find module"));
      for await (const piece of storedTurns(missing, page())) {
        pieces.push(String(piece));
      }
    })();
    await expect(run).rejects.toThrow(/Create src\/lib\/chat\.ts/);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toContain('data-chat-part="failed"');
    expect(pieces[0]).toContain("not set up");
    // Nothing about the server reaches the page.
    expect(pieces[0]).not.toContain("Cannot find module");
  });

  it("leaves no unhandled failure when a stream is never read", async () => {
    const unhandled: unknown[] = [];
    const note = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", note);
    try {
      storedTurns(Promise.reject(new Error("gone")), page());
      liveTurn(Promise.reject(new Error("gone")), page());
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", note);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("liveTurn", () => {
  it("is nothing when no reply is being written", async () => {
    const chat = setup();
    await seed(chat, TALK);
    expect(await collect(liveTurn({ chat }, page()))).toBe("");
  });

  it("is the writing marker, the reply from its start, then the done marker", async () => {
    const chat = setup();
    await seed(chat, [{ role: "user", content: "Hi" }]);
    // The page's first script reads the thread first, which starts the reply.
    const stored = await collect(storedTurns({ chat }, page()));
    expect(stored).toContain("turn-user");
    expect(stored).not.toContain("Hello there");
    const pieces: string[] = [];
    for await (const piece of liveTurn({ chat }, page())) pieces.push(piece);
    expect(pieces[0]).toBe(
      '<span class="writing" data-chat-part="writing" data-testid="turn-writing"></span>',
    );
    expect(pieces.at(-1)).toBe(
      '<span class="done" data-chat-part="done" data-testid="turn-done"></span>',
    );
    expect(pieces.slice(1, -1).join("")).toContain("Hello there");
  });
});

describe("conversationList", () => {
  it("lists the reader's conversations that hold a message, the open one marked", async () => {
    const chat = setup();
    await seed(chat, TALK, CONVERSATION, "Books & <more>");
    await seed(chat, TALK, OTHER, "Another talk");
    await seed(chat, [], "66666666-6666-4666-8666-666666666666", "Empty");
    const out = String(
      await conversationList({ chat, app: "books" }, page("/", OTHER)),
    );
    expect(out).toMatch(/^<conversation-list>[\s\S]*<\/conversation-list>$/);
    // The items post to their own default route unless the project names one.
    expect(out).not.toContain("data-bascik-prop-route");
    expect(out).not.toContain("data-bascik-prop-label");
    expect(out.match(/<conversation-item/g)).toHaveLength(2);
    expect(out).toContain('data-bascik-prop-title="Books &amp; &lt;more&gt;"');
    expect(out).not.toContain("Empty");
    expect(out).toMatch(
      new RegExp(
        `data-bascik-prop-app="books"\\s+data-bascik-prop-conversation="${OTHER}"\\s+data-bascik-prop-title="Another talk"\\s+data-bascik-prop-current="true"`,
      ),
    );
    expect(out).toMatch(
      new RegExp(
        `data-bascik-prop-conversation="${CONVERSATION}"\\s+data-bascik-prop-title="[^"]*"\\s+data-bascik-prop-current="false"`,
      ),
    );
  });

  it("is an empty list for a reader with none, and the same list on an address with ?q=", async () => {
    const chat = setup();
    expect(
      String(await conversationList({ chat }, page())).replace(/\s+/g, ""),
    ).toBe("<conversation-list></conversation-list>");
    await seed(chat, TALK);
    // The page may have no search part, or use `q` for a search of its own.
    const plain = String(await conversationList({ chat }, page()));
    expect(plain.match(/<conversation-item/g)).toHaveLength(1);
    expect(String(await conversationList({ chat }, page("/?q=dune")))).toBe(
      plain,
    );
    expect(String(await conversationList({ chat }, page("/?q=")))).toBe(plain);
  });

  it("gives the list the project's name for it, and the items its open route", async () => {
    const chat = setup();
    await seed(chat, TALK);
    const out = String(
      await conversationList(
        {
          chat,
          routes: { open: '/chat/api/open?"x"' },
          words: { conversations: "Gespräche <alle>" },
        },
        page(),
      ),
    );
    expect(out).toContain(
      '<conversation-list data-bascik-prop-label="Gespräche &lt;alle&gt;">',
    );
    expect(out).toContain(
      'data-bascik-prop-route="/chat/api/open?&quot;x&quot;"',
    );
  });
});

describe("conversationSearch", () => {
  it("is only the box when the page shows no search", async () => {
    const out = String(
      await conversationSearch({ chat: setup(), page: "/books" }, page()),
    );
    expect(out).toBe(
      '<chat-search data-bascik-prop-route="/books" data-bascik-prop-query=""></chat-search>',
    );
  });

  it("leaves the box and Clear on the page they are on unless the project names one", async () => {
    const chat = setup();
    // A chat on /chat, made with `page: "/chat"`, with no `page` in the module.
    const box = String(await conversationSearch({ chat }, page("/chat")));
    expect(box).toBe('<chat-search data-bascik-prop-query=""></chat-search>');
    const found = String(
      await conversationSearch({ chat }, page("/chat?q=dune")),
    );
    expect(found).toContain(
      '<chat-search data-bascik-prop-query="dune"></chat-search>',
    );
    expect(found).toContain('<search-results data-bascik-prop-clear="/chat">');
    expect(found).not.toContain("data-bascik-prop-route");
  });

  it("says everything in the project's words, and posts results to its open route", async () => {
    const chat = setup();
    await seed(chat, [
      { role: "user", content: "Tell me about lighthouses" },
      { role: "assistant", content: "They guide ships." },
    ]);
    const project: ChatProject = {
      chat,
      routes: { open: "/chat/api/open" },
      words: {
        search: "Gespräche durchsuchen",
        searchPlaceholder: "Suchen",
        searchGo: "Los",
        searchClear: "Zurück",
        searchTooShort: "Mindestens 2 Zeichen.",
        searchEmpty: (query) => `Nichts zu <${query}>.`,
        searchFound: (count) => `${count} gefunden`,
      },
    };
    const found = String(
      await conversationSearch(project, page("/?q=lighthouses")),
    );
    expect(found).toContain(
      '<chat-search data-bascik-prop-query="lighthouses" data-bascik-prop-label="Gespräche durchsuchen" data-bascik-prop-placeholder="Suchen" data-bascik-prop-go-label="Los"></chat-search>',
    );
    expect(found).toContain(
      '<search-results data-bascik-prop-clear="/" data-bascik-prop-clear-label="Zurück">',
    );
    expect(found).toMatch(/>1 gefunden<\/template/);
    expect(found).toContain('data-bascik-prop-route="/chat/api/open"');
    const none = String(
      await conversationSearch(project, page("/?q=zeppelins")),
    );
    expect(none).toContain("Nichts zu &lt;zeppelins&gt;.");
    expect(none).not.toContain("No conversation mentions");
    const short = String(await conversationSearch(project, page("/?q=a")));
    expect(short).toContain("Mindestens 2 Zeichen.");
  });

  it("prints what was found, the matched words marked and everything else as text", async () => {
    const chat = setup();
    await seed(chat, [
      { role: "user", content: "Tell me about <i>lighthouses</i>" },
      { role: "assistant", content: "They guide ships." },
    ]);
    const out = String(
      await conversationSearch({ chat, app: "books" }, page("/?q=lighthouses")),
    );
    expect(out).toContain('data-bascik-prop-query="lighthouses"');
    expect(out).toContain('<search-results data-bascik-prop-clear="/">');
    expect(out).toMatch(
      /<template data-bascik-slot="note"\s*>1 found<\/template\s*>/,
    );
    expect(out).toContain(
      `<search-result data-bascik-prop-app="books" data-bascik-prop-conversation="${CONVERSATION}" data-bascik-prop-title="A talk about books">`,
    );
    expect(out).toContain("<mark>lighthouses</mark>");
    expect(out).toContain("&lt;i&gt;");
    expect(out).not.toContain("<i>");
  });

  it("says when nothing matched, or the words are too short, with no result", async () => {
    const chat = setup();
    await seed(chat, TALK);
    const none = String(
      await conversationSearch({ chat }, page("/?q=<zeppelins>")),
    );
    expect(none).toContain('<span data-testid="chat-sidebar-search-empty"');
    expect(none).toContain("No conversation mentions “&lt;zeppelins&gt;”.");
    expect(none).not.toContain("<search-result ");
    const short = String(await conversationSearch({ chat }, page("/?q=a")));
    expect(short).toContain("Type at least 2 characters.");
    expect(short).not.toContain("<search-result ");
  });
});

describe("modelMenu", () => {
  const chat = setup();

  it("is nothing for a project that offers no model", async () => {
    expect(await modelMenu({ chat }, page())).toBe("");
    expect(await modelMenu({ chat, models: { options: [] } }, page())).toBe("");
  });

  it("lists the models, ungrouped first, then under their groups, the one in use selected", async () => {
    const out = String(
      await modelMenu(
        {
          chat,
          app: "books",
          models: {
            options: [
              { id: "local:a", name: "A <small>", group: "This machine" },
              { id: "offline", name: "Offline script" },
              { id: "cloud:b", name: "B", group: "Cloud" },
              { id: "local:c", name: "C", group: "This machine" },
            ],
            chosen: "local:c",
          },
        },
        page(),
      ),
    ).replace(/\s+/g, " ");
    expect(out).toContain(
      '<model-picker data-bascik-prop-app="books" data-bascik-prop-label="Model">',
    );
    expect(out).toContain('<option value="offline">Offline script</option>');
    expect(out).toContain(
      '<optgroup label="This machine"> <option value="local:a">A &lt;small&gt;</option><option value="local:c" selected>C</option> </optgroup>',
    );
    expect(out.indexOf("Offline script")).toBeLessThan(
      out.indexOf("This machine"),
    );
    expect(out.indexOf("This machine")).toBeLessThan(out.indexOf("Cloud"));
    expect(out.match(/ selected/g)).toHaveLength(1);
    expect(out).not.toContain("data-bascik-slot");
  });

  it("asks a function for the list with the request, and prints its label and notes", async () => {
    let asked = 0;
    const context = { env: {} };
    const out = String(
      await modelMenu(
        {
          chat,
          routes: { model: "/chat/api/model" },
          // The reader's choice is theirs alone: it is read from the request.
          models: async (request, given) => {
            asked++;
            expect(given).toBe(context);
            return {
              options: [
                { id: "one", name: "One" },
                { id: "two", name: "Two" },
              ],
              chosen: /model=(\w+)/.exec(
                request.headers.get("cookie") ?? "",
              )?.[1],
              useLabel: "Nehmen",
              label: "Model for typed chat",
              notes: [
                "Plain <text>.",
                html`<p data-testid="note">Written as markup.</p>`,
              ],
            };
          },
        },
        new Request("http://x/", { headers: { cookie: "model=two" } }),
        context,
      ),
    );
    expect(asked).toBe(1);
    expect(out).toContain('<option value="two" selected>Two</option>');
    expect(out).toContain('data-bascik-prop-label="Model for typed chat"');
    expect(out).toContain('data-bascik-prop-use-label="Nehmen"');
    expect(out).toContain('data-bascik-prop-route="/chat/api/model"');
    expect(out).toMatch(
      /<template data-bascik-slot="note"\s*><p>Plain &lt;text&gt;\.<\/p><p data-testid="note">Written as markup\.<\/p><\/template\s*>/,
    );
  });
});

describe("memoryList", () => {
  it("lists what the chat remembers, each sent back to the page it is on", async () => {
    const memory = inMemoryMemories();
    await memory.add(READER, {
      id: "m1",
      text: "Likes <short> books",
      created: Date.UTC(2026, 10, 27, 12),
    });
    const chat = setup({ memory });
    const out = String(
      await memoryList({ chat, app: "books" }, page("/memory?app=books")),
    );
    expect(out).toMatch(/^<memory-list\s*>[\s\S]*<\/memory-list\s*>$/);
    expect(out).toContain(
      '<memory-item data-bascik-prop-app="books" data-bascik-prop-memory="m1" data-bascik-prop-saved="2026-11-27" data-bascik-prop-back="/memory?app=books">Likes &lt;short&gt; books</memory-item>',
    );
    const moved = String(
      await memoryList(
        { chat, routes: { forget: "/chat/api/forget" } },
        page("/memory"),
      ),
    );
    expect(moved).toContain('data-bascik-prop-route="/chat/api/forget"');
  });

  it("is an empty list for a chat with no memory", async () => {
    const out = String(await memoryList({ chat: setup() }, page("/memory")));
    expect(out.replace(/\s+/g, "")).toBe("<memory-list></memory-list>");
  });
});
