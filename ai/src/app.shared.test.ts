/**
 * Two servers in one process: two `createChat` over one `Shared` and one
 * conversation store, which is what a load balancer in front of two servers
 * with a shared store looks like to the kit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChat,
  memoryStore,
  newConversation,
  type Chat,
  type ChatOptions,
  type ConversationStore,
} from "./app.ts";
import { describeComponent, type Catalog } from "./catalog.ts";
import type { ChatMessage, Model, Tool } from "./model.ts";
import { inProcessShared, type Shared } from "./shared.ts";

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

const cookie = `visitor=${READER}; chat_t=${CONVERSATION}`;
const page = (): Request =>
  new Request("http://x/books", { headers: { cookie } });
const posted = (fields: Record<string, string>): Request =>
  new Request("http://x/api/x", {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams(fields),
  });

/**
 * A model that says its first words at once and the rest when told to, and
 * stops when its request is aborted, like a real one.
 */
function gatedModel() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const calls: string[] = [];
  const model: Model = async function* (request) {
    calls.push("call");
    yield "first ";
    await Promise.race([
      gate,
      new Promise<void>((resolve) =>
        request.signal?.addEventListener("abort", () => resolve()),
      ),
    ]);
    if (request.signal?.aborted) return;
    yield "second";
  };
  return { model, open, calls };
}

/** A server that is gone: it reads nothing, writes nothing, and renews nothing. */
function mortal(inner: Shared) {
  const state = { dead: false };
  const shared: Shared = {
    async claim(key, ttlMs) {
      const lease = await inner.claim(key, ttlMs);
      return (
        lease && {
          renew: async () => (state.dead ? true : lease.renew()),
          release: async () => {
            if (!state.dead) await lease.release();
          },
        }
      );
    },
    publish: async (key, event) => {
      if (!state.dead) await inner.publish(key, event);
    },
    subscribe: (key, options) => inner.subscribe(key, options),
    get: async (key) => (state.dead ? undefined : inner.get(key)),
    set: async (key, value, ttlMs) => {
      if (!state.dead) await inner.set(key, value, ttlMs);
    },
    delete: async (key) => {
      if (!state.dead) await inner.delete(key);
    },
    take: async (key) => (state.dead ? undefined : inner.take(key)),
  };
  return { shared, state };
}

const SEEDED: ChatMessage[] = [{ role: "user", content: "hi" }];

function fixture() {
  const store: ConversationStore = memoryStore();
  const shared = inProcessShared();
  const errors: string[] = [];
  const server = (model: Model, options: Partial<ChatOptions> = {}): Chat =>
    createChat({
      id: "t",
      store,
      catalog,
      shared,
      model: () => model,
      system: "You help.",
      page: "/books",
      onError: (_error, what) => errors.push(what),
      ...options,
    });
  const seed = async (messages: ChatMessage[] = SEEDED) =>
    store.save(READER, { ...newConversation(), id: CONVERSATION, messages });
  const stored = async () => (await store.load(READER, CONVERSATION))!;
  return { store, shared, server, seed, stored, errors };
}

async function chunksOf(
  turn: { html: { subscribe(): AsyncIterable<string> } } | undefined,
): Promise<string> {
  let all = "";
  for await (const chunk of turn!.html.subscribe()) all += chunk;
  return all;
}

describe("two servers, one conversation", () => {
  it("follows a reply from its first event to its end on the other server", async () => {
    const { server, seed, stored } = fixture();
    const { model, open, calls } = gatedModel();
    const a = server(model);
    const b = server(model);
    await seed();
    const onA = await a.thread(page());
    // A has said its first words before B's page arrives.
    const firstOnA = onA.turn!.html.subscribe();
    await firstOnA.next();
    const onB = await b.thread(page());
    expect(onB.turn).toBeDefined();
    expect(onB.turn).not.toBe(onA.turn);
    expect(onB.messages).toEqual(SEEDED);
    const followed = chunksOf(onB.turn);
    open();
    await onA.turn!.over;
    const written = await chunksOf(onA.turn);
    expect(await followed).toBe(written);
    expect(written).toContain("first second");
    await onB.turn!.over;
    expect(calls).toHaveLength(1);
    const { messages } = await stored();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[1]!.content).toBe("first second");
  });

  it("does not start a second model call when a page loads on the other server", async () => {
    const { server, seed, stored } = fixture();
    const { model, open, calls } = gatedModel();
    const a = server(model);
    const b = server(model);
    await seed();
    const onA = await a.thread(page());
    // Reloads, a second tab, and a page that lands on either server.
    const more = await Promise.all([
      b.thread(page()),
      b.thread(page()),
      a.thread(page()),
      b.thread(page()),
    ]);
    expect(more.every((state) => state.turn !== undefined)).toBe(true);
    // One server follows each reply once, however many pages read it.
    expect(new Set([more[0]!.turn, more[1]!.turn, more[3]!.turn]).size).toBe(1);
    expect(more[2]!.turn).toBe(onA.turn);
    open();
    await onA.turn!.over;
    expect(calls).toHaveLength(1);
    expect((await stored()).messages).toHaveLength(2);
  });

  it("starts one reply when pages on both servers ask at the same moment", async () => {
    const { server, seed, stored } = fixture();
    const { model, open, calls } = gatedModel();
    const a = server(model);
    const b = server(model);
    await seed();
    const states = await Promise.all([
      a.thread(page()),
      b.thread(page()),
      a.thread(page()),
      b.thread(page()),
    ]);
    expect(states.every((state) => state.turn)).toBe(true);
    open();
    await Promise.all(states.map((state) => state.turn!.over));
    expect(calls).toHaveLength(1);
    expect((await stored()).messages).toHaveLength(2);
  });

  it("ends the reply on the writing server when Stop reaches the other one", async () => {
    const { server, seed, stored } = fixture();
    const { model, calls } = gatedModel();
    const a = server(model);
    const b = server(model);
    await seed();
    const onA = await a.thread(page());
    await onA.turn!.html.subscribe().next();
    // B has followed the reply, then is asked to stop it.
    const onB = await b.thread(page());
    const response = await b.stop(posted({}));
    expect(response.status).toBe(204);
    await onA.turn!.over;
    await onB.turn!.over;
    expect(calls).toHaveLength(1);
    const { messages } = await stored();
    expect(messages).toHaveLength(2);
    // What was written before Stop is kept.
    expect(messages[1]!.content).toBe("first");
    // Nothing is being written now, here or there.
    expect((await b.stop(posted({}))).status).toBe(404);
    expect((await a.stop(posted({}))).status).toBe(404);
  });

  it("stops a reply it has not followed, and answers 404 when none is written", async () => {
    const { server, seed, stored } = fixture();
    const { model } = gatedModel();
    const a = server(model);
    const b = server(model);
    await seed();
    expect((await b.stop(posted({}))).status).toBe(404);
    const onA = await a.thread(page());
    await onA.turn!.html.subscribe().next();
    expect(await b.stopTurn(CONVERSATION)).toBe(true);
    await onA.turn!.over;
    expect((await stored()).messages[1]!.content).toBe("first");
  });

  it("answers a message waiting after a reply, on either server", async () => {
    const { server, seed, stored } = fixture();
    const a = server(async function* () {
      yield "one";
    });
    const b = server(async function* () {
      yield "two";
    });
    await seed();
    await (
      await a.thread(page())
    ).turn!.over;
    await b.addMessage(
      { reader: READER, conversationId: CONVERSATION },
      "again",
    );
    await (
      await b.thread(page())
    ).turn!.over;
    const { messages } = await stored();
    expect(messages.map((message) => message.content)).toEqual([
      "hi",
      "one",
      "again",
      "two",
    ]);
  });
});

describe("a server that stops", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loses its claim when it stops renewing, and the pending message is picked up", async () => {
    const { server, seed, stored, shared } = fixture();
    const dying = mortal(shared);
    const stuck: Model = async function* () {
      await new Promise(() => {});
    };
    const a = server(stuck, { shared: dying.shared });
    const bModel = vi.fn<Model>(async function* () {
      yield "from B";
    });
    const b = server(bModel);
    await seed();
    const onA = await a.thread(page());
    expect(onA.turn).toBeDefined();
    // B follows the reply A is writing.
    const onB = await b.thread(page());
    const followed = chunksOf(onB.turn);
    dying.state.dead = true;
    // A claim lasts 15 seconds without a renewal; those following notice soon after.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await followed).toContain("turn-failed");
    expect(bModel).not.toHaveBeenCalled();

    // The reader reloads: no one holds the conversation, so B writes the reply.
    const again = await b.thread(page());
    await again.turn!.over;
    expect(bModel).toHaveBeenCalledOnce();
    const { messages } = await stored();
    expect(messages.map((message) => message.content)).toEqual([
      "hi",
      "from B",
    ]);
  });

  it("gives up a reply whose claim another server took, and does not store it twice", async () => {
    const { server, seed, stored, shared, errors } = fixture();
    const pausing = mortal(shared);
    const a = server(gatedModel().model, { shared: pausing.shared });
    const second = gatedModel();
    const b = server(second.model);
    await seed();
    const onA = await a.thread(page());
    await onA.turn!.html.subscribe().next();
    // A stalls (a long pause, a lost network) past its claim.
    pausing.state.dead = true;
    await vi.advanceTimersByTimeAsync(16_000);
    const onB = await b.thread(page());
    await onB.turn!.html.subscribe().next();
    // A wakes up, finds the claim gone, and tells its readers.
    pausing.state.dead = false;
    await vi.advanceTimersByTimeAsync(6000);
    await onA.turn!.over;
    expect(await chunksOf(onA.turn)).toContain("moved to another server");
    expect((await stored()).messages).toHaveLength(1);

    // B's reply is the one that is written, once.
    second.open();
    await onB.turn!.over;
    const { messages } = await stored();
    expect(messages.map((message) => message.content)).toEqual([
      "hi",
      "first second",
    ]);
    expect(errors).toEqual([]);
  });

  it("starts no reply when the shared store cannot be reached", async () => {
    const { server, seed, stored, shared, errors } = fixture();
    const down: Shared = {
      ...shared,
      claim: () => Promise.reject(new Error("unreachable")),
      get: () => Promise.reject(new Error("unreachable")),
    };
    const model = vi.fn<Model>(async function* () {
      yield "never";
    });
    const a = server(model, { shared: down });
    await seed();
    const state = await a.thread(page());
    expect(state.turn).toBeUndefined();
    expect(state.messages).toEqual(SEEDED);
    expect(model).not.toHaveBeenCalled();
    expect(errors).toContain("the shared store did not answer");
    expect(errors).toContain("no reply could be started");
    expect((await stored()).messages).toEqual(SEEDED);
  });
});

describe("a voice call across two servers", () => {
  const slow: Tool = {
    name: "slow_lookup",
    description: "Look a title up slowly.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    run: (input) =>
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(`Found ${input.title}`), 20),
      ),
  };
  const voiced = () => {
    const f = fixture();
    const run = vi.fn(
      (input: Record<string, unknown>) => `Held ${input.title}`,
    );
    const tools = [{ ...hold, run }, slow];
    // The voice handlers answer 404 on a server with no voice provider.
    const voice = {
      protocol: "fake",
      createSession: async () => ({ protocol: "fake", url: "", setup: null }),
    };
    return {
      ...f,
      run,
      a: f.server(gatedModel().model, { tools, voice }),
      b: f.server(gatedModel().model, { tools, voice }),
    };
  };
  const call = (fields: Record<string, string>) =>
    posted({ id: "c1", name: "show", ...fields });
  const show = (id: string, title: string) =>
    call({
      id,
      input: JSON.stringify({ markup: `<book-card title="${title}" />` }),
    });

  it("ends in one stored turn when the tool calls land on different servers", async () => {
    const { a, b, run, seed, stored } = voiced();
    await seed([]);
    const shown = await a.voiceTool(show("c1", "Dune"));
    expect(await shown.json()).toMatchObject({ state: "done", view: true });
    const asked = call({
      id: "c2",
      name: "place_hold",
      input: '{"title":"Emma"}',
    });
    expect(await (await b.voiceTool(asked)).json()).toMatchObject({
      state: "approval-requested",
    });
    // The reader's answer lands on the other server from the question.
    const answered = call({
      id: "c2",
      name: "place_hold",
      input: '{"title":"Emma"}',
      decision: "approve",
    });
    expect(await (await a.voiceTool(answered)).json()).toMatchObject({
      state: "done",
      output: "Held Emma",
    });
    expect(run).toHaveBeenCalledOnce();
    const last = await b.voiceTool(show("c3", "Persuasion"));
    expect(await last.json()).toMatchObject({ state: "done" });

    // The views are readable from either server.
    expect(await a.voiceView(page(), "c3")).toContain("Persuasion");
    expect(await b.voiceView(page(), "c1")).toContain("Dune");
    expect(await b.voiceView(page(), "nothing")).toBe("");

    const spoken = posted({ reader: "Show me books", model: "Here." });
    expect((await b.voiceTurn(spoken)).status).toBe(204);
    const { messages } = await stored();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    const parts = JSON.stringify(messages[1]!.parts);
    for (const word of ["Dune", "Emma", "Persuasion", "Here."]) {
      expect(parts).toContain(word);
    }
    // The turn was taken: the next one starts empty, on either server.
    await a.voiceTurn(posted({ reader: "Thanks", model: "" }));
    expect((await stored()).messages.map((message) => message.content)).toEqual(
      ["Show me books", "Here.", "Thanks"],
    );
  });

  it("keeps every call when calls overlap across the servers", async () => {
    const { a, b, seed, stored } = voiced();
    await seed([]);
    const titles = ["one", "two", "three", "four"];
    const responses = await Promise.all(
      titles.map((title, at) =>
        (at % 2 ? a : b).voiceTool(
          call({
            id: `s${at}`,
            name: "slow_lookup",
            input: JSON.stringify({ title }),
          }),
        ),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    await a.voiceTurn(posted({ reader: "go", model: "done" }));
    const parts = JSON.stringify((await stored()).messages.at(-1)!.parts);
    for (const title of titles) expect(parts).toContain(`Found ${title}`);
  });
});
