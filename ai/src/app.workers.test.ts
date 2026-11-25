/**
 * What a host without shared memory between requests (Cloudflare Workers)
 * needs from the kit: timers that may be plain numbers, `waitUntil`, never
 * following another request's reply from memory, and the knobs and keys a
 * host sets itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cookieSessions,
  createChat,
  memoryStore,
  newConversation,
  sharedKeys,
  type Chat,
  type ChatOptions,
  type LiveTurn,
} from "./app.ts";
import { sharedKeys as sharedKeysFromRoot } from "./index.ts";
import { describeComponent, type Catalog } from "./catalog.ts";
import type { ChatMessage, Model, ModelRequest, Tool } from "./model.ts";
import { inProcessShared } from "./shared.ts";

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

const page = (): Request =>
  new Request("http://x/books", {
    headers: { cookie: `visitor=${READER}; chat_t=${CONVERSATION}` },
  });

/** A model that writes `text` once `open()` is called, and stops on abort. */
function gatedModel(text = "Hello there"): {
  model: Model;
  open: () => void;
  calls: () => number;
} {
  let open = (): void => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let calls = 0;
  const model: Model = async function* (request: ModelRequest) {
    calls++;
    await new Promise<void>((resolve, reject) => {
      gate.then(resolve);
      request.signal?.addEventListener("abort", () =>
        reject(new Error("aborted")),
      );
    });
    yield text;
  };
  return { model, open: () => open(), calls: () => calls };
}

function setup(options: Partial<ChatOptions> = {}): Chat {
  return createChat({
    id: "t",
    store: memoryStore(),
    catalog,
    model: () =>
      async function* () {
        yield "Hello there";
      },
    system: "You help.",
    page: "/books",
    onError: () => {},
    ...options,
  });
}

async function seed(chat: Chat, messages: ChatMessage[]): Promise<void> {
  await chat.store.save(READER, {
    ...newConversation(),
    id: CONVERSATION,
    messages,
  });
}

const asked: ChatMessage[] = [{ role: "user", content: "Hi" }];

async function readAll(turn: LiveTurn): Promise<string> {
  let html = "";
  for await (const chunk of turn.html.subscribe()) html += chunk;
  return html;
}

const lastMessage = async (chat: Chat): Promise<ChatMessage | undefined> =>
  (await chat.store.load(READER, CONVERSATION))?.messages.at(-1);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("timers that are plain numbers (C1)", () => {
  it("inProcessShared sweeps with a timer that has no unref", async () => {
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (() => 7) as unknown as typeof setInterval,
    );
    const shared = inProcessShared();
    await expect(shared.set("k", "v", 1000)).resolves.toBeUndefined();
    await expect(shared.get("k")).resolves.toBe("v");
    expect(setInterval).toHaveBeenCalled();
  });

  it("a reply is written and stored when setInterval and setTimeout return numbers", async () => {
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (() => 11) as unknown as typeof setInterval,
    );
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      ms?: number,
    ) => {
      realTimeout(callback, ms);
      return 12;
    }) as unknown as typeof setTimeout);
    const chat = setup();
    await seed(chat, asked);
    const { turn } = await chat.thread(page());
    expect(await readAll(turn!)).toContain("Hello there");
    await turn!.over;
    expect((await lastMessage(chat))?.content).toBe("Hello there");
  });
});

describe("waitUntil (C2)", () => {
  it("gets the promise that settles once the turn is stored", async () => {
    const gated = gatedModel();
    const chat = setup({ model: () => gated.model });
    await seed(chat, asked);
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const { turn } = await chat.thread(page(), { waitUntil });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const handed = waitUntil.mock.calls[0]![0];
    expect(handed).toBe(turn!.over);
    let settled = false;
    void handed.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    gated.open();
    await handed;
    expect((await lastMessage(chat))?.content).toBe("Hello there");
  });

  it("is called as a method, so a host context keeps its this", async () => {
    const chat = setup();
    await seed(chat, asked);
    const host = {
      handed: [] as Promise<unknown>[],
      waitUntil(promise: Promise<unknown>) {
        this.handed.push(promise);
      },
    };
    const { turn } = await chat.thread(page(), host);
    expect(host.handed).toEqual([turn!.over]);
    await turn!.over;
  });

  it("is not called when no turn starts, and handlers take the context", async () => {
    const chat = setup();
    await seed(chat, [...asked, { role: "assistant", content: "Done." }]);
    const waitUntil = vi.fn();
    const { turn } = await chat.thread(page(), { waitUntil });
    expect(turn).toBeUndefined();
    expect(waitUntil).not.toHaveBeenCalled();
    const response = await chat.stop(page(), { waitUntil });
    expect(response.status).toBe(404);
  });
});

describe("followLocally: false (C3)", () => {
  it("a second request follows through shared.subscribe, never the live Map, and gets the reply", async () => {
    const shared = inProcessShared();
    const subscribe = vi.spyOn(shared, "subscribe");
    const gated = gatedModel();
    const chat = setup({
      shared,
      followLocally: false,
      model: () => gated.model,
    });
    await seed(chat, asked);
    const writer = await chat.thread(page());
    expect(subscribe).not.toHaveBeenCalled();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const follower = await chat.thread(page());
    expect(follower.turn).toBeDefined();
    expect(follower.turn).not.toBe(writer.turn);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]![0]).toMatch(
      /^genui:t:reply:44444444-4444-4444-8444-444444444444:/,
    );
    // The follower waits on a keepalive of its own while the writer is quiet.
    await new Promise((resolve) => setImmediate(resolve));
    expect(timeout.mock.calls.some(([, ms]) => ms === 1000)).toBe(true);
    // What the follower saw is the conversation above the reply.
    expect(follower.messages).toEqual(asked);
    gated.open();
    expect(await readAll(follower.turn!)).toContain("Hello there");
    await writer.turn!.over;
    await follower.turn!.over;
    expect((await lastMessage(chat))?.content).toBe("Hello there");
    expect(gated.calls()).toBe(1);
  });

  it("with the default, a second request reads the reply from memory", async () => {
    const shared = inProcessShared();
    const subscribe = vi.spyOn(shared, "subscribe");
    const gated = gatedModel();
    const chat = setup({ shared, model: () => gated.model });
    await seed(chat, asked);
    const writer = await chat.thread(page());
    const reader = await chat.thread(page());
    expect(reader.turn).toBe(writer.turn);
    expect(subscribe).not.toHaveBeenCalled();
    gated.open();
    await writer.turn!.over;
  });

  it("Stop reaches the writer through the shared store", async () => {
    const shared = inProcessShared();
    const set = vi.spyOn(shared, "set");
    const gated = gatedModel();
    const chat = setup({
      shared,
      followLocally: false,
      model: () => gated.model,
    });
    await seed(chat, asked);
    const writer = await chat.thread(page());
    expect(await chat.stopTurn(CONVERSATION)).toBe(true);
    expect(
      set.mock.calls.some(([key]) =>
        key.startsWith(`genui:t:stop:${CONVERSATION}:`),
      ),
    ).toBe(true);
    await writer.turn!.over;
    expect((await lastMessage(chat))?.role).toBe("assistant");
  });
});

describe("a writer that died (C3)", () => {
  it("is ended and dropped once its record runs out, so later readers do not hang on it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // The writer's watch never runs, as when a host cancels its request:
    // nothing renews its record.
    vi.spyOn(globalThis, "setInterval").mockImplementation(
      (() => 1) as unknown as typeof setInterval,
    );
    const hung: Model = async function* () {
      await new Promise(() => {});
      yield "never";
    };
    const chat = setup({ model: () => hung });
    await seed(chat, asked);
    const first = await chat.thread(page());
    const dead = first.turn!;
    // Still within its record: a reader joins it.
    expect((await chat.thread(page())).turn).toBe(dead);
    vi.setSystemTime(Date.now() + 16_000);
    const later = await chat.thread(page());
    expect(later.turn).not.toBe(dead);
    expect(dead.html.ended).toBe(true);
    expect(await readAll(dead)).toContain('data-testid="turn-failed"');
  });
});

describe("maxRounds (C4)", () => {
  const look: Tool = {
    name: "look",
    description: "Look again.",
    inputSchema: { type: "object", properties: {} },
    run: () => "Nothing new.",
  };
  const looping = (): { model: Model; calls: () => number } => {
    let calls = 0;
    return {
      calls: () => calls,
      model: async function* () {
        calls++;
        yield { type: "tool-call", name: "look", input: {} };
      },
    };
  };

  it("caps how many times one reply asks the model", async () => {
    const loop = looping();
    const chat = setup({
      tools: [look],
      maxRounds: 2,
      model: () => loop.model,
    });
    await seed(chat, asked);
    const { turn } = await chat.thread(page());
    await turn!.over;
    expect(loop.calls()).toBe(2);
    expect((await lastMessage(chat))?.content).toContain(
      "this reply needed too many tool calls",
    );
  });

  it("defaults to 8", async () => {
    const loop = looping();
    const chat = setup({ tools: [look], model: () => loop.model });
    await seed(chat, asked);
    const { turn } = await chat.thread(page());
    await turn!.over;
    expect(loop.calls()).toBe(8);
  });
});

describe("sharedKeys (C5)", () => {
  const SHAPE =
    /^genui:(?<chat>[^:]+):(?<kind>[a-z-]+):(?<conversation>[^:]+)(?::(?<more>.+))?$/;

  it("builds every key as genui:<chatId>:<kind>:<conversationId>[:<more>]", () => {
    const keys = sharedKeys("books");
    const cases: [string, string, string | undefined][] = [
      [keys.lease("c1"), "lease", undefined],
      [keys.turn("c1"), "turn", undefined],
      [keys.stop("c1", "t1"), "stop", "t1"],
      [keys.reply("c1", "t1"), "reply", "t1"],
      [keys.voice("c1"), "voice", undefined],
      [keys.voiceOpen("c1"), "voice-open", undefined],
      [keys.voiceLock("c1"), "voice-lock", undefined],
      [keys.view("c1", "call_1"), "view", "call_1"],
    ];
    expect(cases).toHaveLength(Object.keys(keys).length);
    for (const [key, kind, more] of cases) {
      const groups = SHAPE.exec(key)?.groups;
      expect(groups, key).toBeDefined();
      expect(groups!.chat).toBe("books");
      expect(groups!.kind).toBe(kind);
      expect(groups!.conversation).toBe("c1");
      expect(groups!.more).toBe(more);
    }
  });

  it("is exported from the package root too", () => {
    expect(sharedKeysFromRoot).toBe(sharedKeys);
  });

  it("names the keys a chat writes", async () => {
    const shared = inProcessShared();
    const set = vi.spyOn(shared, "set");
    const claim = vi.spyOn(shared, "claim");
    const publish = vi.spyOn(shared, "publish");
    const chat = setup({ shared });
    await seed(chat, asked);
    const { turn } = await chat.thread(page());
    await turn!.over;
    const keys = sharedKeys("t");
    expect(claim.mock.calls[0]![0]).toBe(keys.lease(CONVERSATION));
    expect(set.mock.calls[0]![0]).toBe(keys.turn(CONVERSATION));
    const record = JSON.parse(set.mock.calls[0]![1]) as { turn: string };
    expect(publish.mock.calls[0]![0]).toBe(
      keys.reply(CONVERSATION, record.turn),
    );
  });
});

describe("cookieSessions maxAgeSeconds (C6)", () => {
  const visitorCookie = (sessions: ReturnType<typeof cookieSessions>) =>
    sessions
      .remember({ reader: READER, conversationId: undefined }, CONVERSATION)
      .getSetCookie()
      .find((cookie) => cookie.startsWith("visitor="))!;

  it("sets the visitor cookie's Max-Age", () => {
    expect(visitorCookie(cookieSessions("t", { maxAgeSeconds: 3600 }))).toMatch(
      /; Max-Age=3600;/,
    );
  });

  it("defaults to one year", () => {
    expect(visitorCookie(cookieSessions("t"))).toMatch(/; Max-Age=31536000;/);
  });

  it("leaves the conversation cookie without a Max-Age", () => {
    const chatCookie = cookieSessions("t", { maxAgeSeconds: 60 })
      .remember({ reader: READER, conversationId: undefined }, CONVERSATION)
      .getSetCookie()
      .find((cookie) => cookie.startsWith("chat_t="))!;
    expect(chatCookie).not.toMatch(/Max-Age/);
  });

  it("refuses a Max-Age that is not a whole number of seconds", () => {
    expect(() => cookieSessions("t", { maxAgeSeconds: -1 })).toThrow(
      /maxAgeSeconds/,
    );
    expect(() => cookieSessions("t", { maxAgeSeconds: 1.5 })).toThrow(
      /maxAgeSeconds/,
    );
  });
});
