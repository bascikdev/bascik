/**
 * The voice handlers under what goes wrong around a call: a provider that
 * fails, a call that was abandoned, a turn or a tool call sent twice, a
 * shared store that stops answering, and a post from another site's page.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createChat,
  memoryStore,
  newConversation,
  type Chat,
  type ChatOptions,
  type Conversation,
} from "./app.ts";
import { crossSite } from "./app/forms.ts";
import { describeComponent, type Catalog } from "./catalog.ts";
import {
  scriptedModel,
  type ChatMessage,
  type Tool,
  type ToolPart,
} from "./model.ts";
import { inProcessShared } from "./shared.ts";
import type { VoiceProvider, VoiceSessionConfig } from "./voice.ts";

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

const hold: Tool = {
  name: "place_hold",
  description: "Hold a copy.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  approval: true,
  run: (input) => `Held ${input.title}`,
};

/** A form post as a browser sends it, with any headers the test adds. */
function posted(
  fields: Record<string, string>,
  conversation: string | undefined = CONVERSATION,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: {
      cookie: [`visitor=${READER}`, conversation && `chat_t=${conversation}`]
        .filter(Boolean)
        .join("; "),
      ...headers,
    },
    body: new URLSearchParams(fields),
  });
}

const ticket = { protocol: "fake", url: "wss://example.test/", setup: null };

function voiced(options: Partial<ChatOptions> = {}) {
  const configs: VoiceSessionConfig[] = [];
  const provider: VoiceProvider = {
    protocol: "fake",
    async createSession(config) {
      configs.push(config);
      return ticket;
    },
  };
  const chat = createChat({
    id: "t",
    store: memoryStore(),
    catalog,
    model: () => scriptedModel(() => "Hello there", { delayMs: 0 }),
    system: "You help.",
    page: "/books",
    onError: () => {},
    voice: provider,
    tools: [hold],
    ...options,
  });
  return { chat, configs };
}

async function seed(chat: Chat, messages: ChatMessage[] = []): Promise<void> {
  await chat.store.save(READER, {
    ...newConversation(),
    id: CONVERSATION,
    messages,
  });
}

const messagesOf = async (chat: Chat): Promise<ChatMessage[]> =>
  (await chat.store.load(READER, CONVERSATION))!.messages;

/** A store that counts what is saved in it. */
function countingStore() {
  const inner = memoryStore();
  const saved: string[] = [];
  return {
    saved,
    store: {
      ...inner,
      async save(reader: string, conversation: Conversation) {
        saved.push(conversation.id);
        await inner.save(reader, conversation);
      },
    },
  };
}

describe("voiceSession", () => {
  it("stores no conversation when the provider gives no ticket", async () => {
    const { store, saved } = countingStore();
    const { chat } = voiced({
      store,
      voice: {
        protocol: "fake",
        createSession: async () => {
          throw new Error("refused");
        },
      },
    });
    for (let tries = 0; tries < 3; tries++) {
      expect((await chat.voiceSession(posted({}, undefined))).status).toBe(502);
    }
    expect(saved).toEqual([]);
  });

  it("stores the new conversation once there is a ticket, and opens it", async () => {
    const { store, saved } = countingStore();
    const { chat } = voiced({ store });
    const response = await chat.voiceSession(posted({}, undefined));
    expect(response.status).toBe(200);
    expect(saved).toHaveLength(1);
    expect(response.headers.getSetCookie().join()).toContain(saved[0]);
  });

  it("says whose session it is, so a relay can limit one reader's calls", async () => {
    const { chat, configs } = voiced();
    await chat.voiceSession(posted({}, undefined));
    expect(configs[0]!.owner).toBe(READER);
  });

  it("stores what an abandoned call left, so its waiting call cannot be approved in the next", async () => {
    const run = vi.fn(() => "Held");
    const { chat } = voiced({ tools: [{ ...hold, run }] });
    await seed(chat, [{ role: "user", content: "hi" }]);
    const asked = { id: "c1", name: "place_hold", input: '{"title":"Dune"}' };
    const waiting = await chat.voiceTool(posted(asked));
    expect(await waiting.json()).toMatchObject({ state: "approval-requested" });
    await chat.voiceTool(
      posted({
        id: "s1",
        name: "show",
        input: JSON.stringify({ markup: '<book-card title="Dune" />' }),
      }),
    );
    // The page is closed: no turn is stored. Later, a new call starts.
    expect((await chat.voiceSession(posted({}))).status).toBe(200);

    const late = await chat.voiceTool(
      posted({ ...asked, decision: "approve" }),
    );
    expect(await late.json()).toMatchObject({
      state: "failed",
      output: "Error: nothing is waiting.",
    });
    expect(run).not.toHaveBeenCalled();
    // The old call's turn is stored as ended, and is not the new call's.
    const before = await messagesOf(chat);
    expect(before).toHaveLength(2);
    const parts = before[1]!.parts!;
    expect(parts.find((part) => part.type === "tool")).toMatchObject({
      id: "c1",
      state: "denied",
    });
    expect(JSON.stringify(parts)).toContain("book-card");

    await chat.voiceTurn(posted({ reader: "Hello", model: "Hi." }));
    const after = await messagesOf(chat);
    expect(after.map((message) => message.content)).toEqual([
      "hi",
      "",
      "Hello",
      "Hi.",
    ]);
    expect(after[3]!.parts!.filter((part) => part.type === "tool")).toEqual([]);
  });

  it("stores nothing more when the last call left nothing", async () => {
    const { chat } = voiced();
    await seed(chat, [{ role: "user", content: "hi" }]);
    await chat.voiceTurn(posted({ reader: "One", model: "Two" }));
    await chat.voiceSession(posted({}));
    await chat.voiceSession(posted({}));
    expect((await messagesOf(chat)).map((message) => message.content)).toEqual([
      "hi",
      "One",
      "Two",
    ]);
  });
});

describe("voiceTurn", () => {
  it("stores a turn the browser names once, however often it is sent", async () => {
    const { chat } = voiced();
    await seed(chat);
    const turn = { reader: "Yes", model: "Done.", turn: "turn-1" };
    for (let sent = 0; sent < 3; sent++) {
      expect((await chat.voiceTurn(posted(turn))).status).toBe(204);
    }
    expect((await messagesOf(chat)).map((message) => message.content)).toEqual([
      "Yes",
      "Done.",
    ]);
    // The same words in another turn are another turn.
    await chat.voiceTurn(posted({ ...turn, turn: "turn-2" }));
    expect(await messagesOf(chat)).toHaveLength(4);
  });

  it("stores two of the same turn sent together once", async () => {
    const { chat } = voiced();
    await seed(chat);
    const turn = { reader: "Yes", model: "Done.", turn: "turn-1" };
    await Promise.all([
      chat.voiceTurn(posted(turn)),
      chat.voiceTurn(posted(turn)),
    ]);
    expect(await messagesOf(chat)).toHaveLength(2);
  });

  it("takes a named turn again when storing it failed", async () => {
    const inner = memoryStore();
    let failing = false;
    const { chat } = voiced({
      store: {
        ...inner,
        async save(reader: string, conversation: Conversation) {
          if (failing) {
            failing = false;
            throw new Error("transient");
          }
          await inner.save(reader, conversation);
        },
      },
    });
    await seed(chat);
    const turn = { reader: "Yes", model: "Done.", turn: "turn-1" };
    failing = true;
    await expect(chat.voiceTurn(posted(turn))).rejects.toThrow("transient");
    expect((await chat.voiceTurn(posted(turn))).status).toBe(204);
    expect(await messagesOf(chat)).toHaveLength(2);
  });

  it("uses no name that is not a short plain id", async () => {
    const { chat } = voiced();
    await seed(chat);
    const turn = { reader: "Yes", model: "Done.", turn: "not an id!" };
    await chat.voiceTurn(posted(turn));
    await chat.voiceTurn(posted(turn));
    expect(await messagesOf(chat)).toHaveLength(4);
  });
});

describe("voiceTool", () => {
  it("still answers with the tool's result when recording it fails", async () => {
    const inner = inProcessShared();
    let ran = false;
    const onError = vi.fn();
    const { chat } = voiced({
      onError,
      shared: {
        ...inner,
        async set(key, value, ttlMs) {
          if (ran) throw new Error("The voice call's state is busy.");
          await inner.set(key, value, ttlMs);
        },
      },
      tools: [
        {
          ...hold,
          approval: false,
          run: (input) => {
            ran = true;
            return `Held ${input.title}`;
          },
        },
      ],
    });
    await seed(chat);
    const response = await chat.voiceTool(
      posted({ id: "c1", name: "place_hold", input: '{"title":"Dune"}' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: "done",
      output: "Held Dune",
      view: false,
    });
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      "a voice tool's result was not recorded",
    );
  });
});

describe("a post from another site's page", () => {
  const request = (headers: Record<string, string>): Request =>
    new Request("http://books.test/api/x", { method: "POST", headers });

  it.each([
    ["no header says where it came from", {}, false],
    [
      "the browser says same-origin",
      { "sec-fetch-site": "same-origin" },
      false,
    ],
    ["the browser says same-site", { "sec-fetch-site": "same-site" }, false],
    ["the reader started it", { "sec-fetch-site": "none" }, false],
    ["the browser says cross-site", { "sec-fetch-site": "cross-site" }, true],
    [
      "the browser says cross-site, in capitals",
      { "sec-fetch-site": "Cross-Site" },
      true,
    ],
    ["the origin is this host", { origin: "http://books.test" }, false],
    [
      "the origin is the Host header",
      { origin: "https://shop.example", host: "shop.example" },
      false,
    ],
    [
      "the origin is the host a proxy forwarded",
      { origin: "https://shop.example", "x-forwarded-host": "shop.example" },
      false,
    ],
    ["the origin is another host", { origin: "https://evil.example" }, true],
    [
      "the origin is this host on another port",
      { origin: "http://books.test:8080" },
      true,
    ],
    ["the origin is null", { origin: "null" }, true],
    [
      "the browser says same-origin behind a proxy that renames the host",
      { "sec-fetch-site": "same-origin", origin: "https://shop.example" },
      false,
    ],
  ])("when %s", (_name, headers, refused) => {
    const answer = crossSite(request(headers));
    if (refused) expect(answer?.status).toBe(403);
    else expect(answer).toBeNull();
  });

  const handlers = [
    "voiceSession",
    "voiceTool",
    "voiceTurn",
    "send",
    "approve",
    "answer",
    "stop",
    "open",
    "forget",
  ] as const;

  it.each(handlers)("is refused by %s, which changes nothing", async (name) => {
    const run = vi.fn(() => "Held");
    const { store, saved } = countingStore();
    const { chat, configs } = voiced({ store, tools: [{ ...hold, run }] });
    await seed(chat, [
      { role: "user", content: "Hold Dune" },
      {
        role: "assistant",
        content: "",
        awaiting: "reader",
        parts: [
          {
            type: "tool",
            id: "call_1",
            name: "place_hold",
            input: { title: "Dune" },
            state: "approval-requested",
          } as ToolPart,
        ],
      },
    ]);
    await chat.voiceTool(
      posted({ id: "c1", name: "place_hold", input: '{"title":"Dune"}' }),
    );
    saved.length = 0;
    const fields = {
      id: name === "voiceTool" ? "c1" : "call_1",
      name: "place_hold",
      input: '{"title":"Dune"}',
      decision: "approve",
      text: "Hi",
      reader: "Yes",
      model: "Done.",
    };
    const fromElsewhere: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
    ];
    for (const headers of fromElsewhere) {
      const response = await chat[name](posted(fields, CONVERSATION, headers));
      expect(response.status).toBe(403);
    }
    expect(run).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(configs).toEqual([]);
  });

  it("is not what the page's own post is", async () => {
    const run = vi.fn(() => "Held");
    const { chat } = voiced({ tools: [{ ...hold, run }] });
    await seed(chat);
    const own = { "sec-fetch-site": "same-origin", origin: "http://localhost" };
    const fields = { id: "c1", name: "place_hold", input: '{"title":"Dune"}' };
    await chat.voiceTool(posted(fields, CONVERSATION, own));
    const approved = await chat.voiceTool(
      posted({ ...fields, decision: "approve" }, CONVERSATION, own),
    );
    expect(await approved.json()).toMatchObject({ state: "done" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      (await chat.voiceSession(posted({}, CONVERSATION, own))).status,
    ).toBe(200);
  });
});
