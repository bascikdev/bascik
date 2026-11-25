import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import { geminiLiveSetup, geminiLiveVoice } from "./gemini-live.ts";
import { createChat, memoryStore, newConversation } from "./app.ts";
import { scriptedModel, type Tool, type ToolPart } from "./model.ts";
import { renderMessage } from "./render-turn.ts";
import {
  MAX_VOICE_PARTS,
  MAX_VOICE_TURN_CHARS,
  MAX_VOICE_VIEWS,
  newVoiceTurn,
  runVoiceTool,
  FILL_TOOL,
  SHOW_TOOL,
  voiceMessages,
  voicePrompt,
  voiceTools,
} from "./voice.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<!-- @bascik One book. --><article><h3 data-bascik-prop-title></h3><span data-bascik-slot></span></article>`,
    )!,
    describeComponent(
      "tool-note.html",
      `<p><span data-bascik-slot></span></p>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

let held: string[] = [];
const tools: Tool[] = [
  {
    name: "place_hold",
    description: "Hold a copy.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "The title" } },
      required: ["title"],
    },
    approval: true,
    note: (input) => `<tool-note>Holding ${input.title}</tool-note>`,
    run: (input) => {
      held.push(String(input.title));
      return `Held ${input.title}`;
    },
  },
  {
    name: "list_books",
    description: "List the books.",
    inputSchema: { type: "object", properties: {} },
    run: () => `["Dune"]`,
  },
  {
    name: "local_time",
    description: "The reader's time.",
    inputSchema: { type: "object", properties: {} },
    client: true,
  },
];

describe("voiceTools and voicePrompt", () => {
  it("offers the app's tools and show, and leaves out what a form answers", () => {
    expect(voiceTools(tools).map((tool) => tool.name)).toEqual([
      "place_hold",
      "list_books",
      SHOW_TOOL,
      FILL_TOOL,
    ]);
    // Asking twice does not add them twice.
    expect(voiceTools(voiceTools(tools))).toHaveLength(4);
  });

  it("teaches a speaking model the catalog and that only show puts things on screen", () => {
    const prompt = voicePrompt(catalog);
    expect(prompt).toContain("spoken aloud");
    expect(prompt).toContain(`the ${SHOW_TOOL} tool`);
    expect(prompt).toContain(`<book-card title="…">content</book-card>`);
  });
});

describe("runVoiceTool", () => {
  it("renders what show is given through the catalog, like any reply", async () => {
    const turn = newVoiceTurn();
    const result = await runVoiceTool(
      turn,
      {
        id: "call_1",
        name: SHOW_TOOL,
        input: {
          markup: `<book-card title="Dune" onclick="x">Sand</book-card><script>alert(1)</script>`,
        },
      },
      tools,
      catalog,
    );
    expect(result.state).toBe("done");
    expect(result.output).toBe("Shown on the reader's screen.");
    expect(result.html).toBe(
      `<book-card data-bascik-prop-title="Dune">Sand</book-card>&lt;script&gt;alert(1)&lt;/script&gt;`,
    );
    expect(turn.parts).toHaveLength(1);
    expect(
      (
        await runVoiceTool(
          turn,
          { id: "call_2", name: SHOW_TOOL, input: { markup: 3 } },
          tools,
          catalog,
        )
      ).state,
    ).toBe("failed");
  });

  it("runs a tool and tells the model what it returned", async () => {
    const turn = newVoiceTurn();
    const result = await runVoiceTool(
      turn,
      { id: "call_1", name: "list_books", input: {} },
      tools,
      catalog,
    );
    expect(result).toMatchObject({ state: "done", output: `["Dune"]` });
    // The same call is not run twice.
    expect(
      (
        await runVoiceTool(
          turn,
          { id: "call_1", name: "list_books", input: {} },
          tools,
          catalog,
        )
      ).state,
    ).toBe("failed");
  });

  it("holds a tool that needs approval until the reader answers, and runs it once", async () => {
    held = [];
    const turn = newVoiceTurn();
    const call = { id: "call_1", name: "place_hold", input: { title: "Dune" } };
    const asked = await runVoiceTool(turn, call, tools, catalog, {
      view: (part) =>
        part.state === "approval-requested"
          ? `<form data-call="${part.id}"></form>`
          : null,
    });
    expect(asked.state).toBe("approval-requested");
    expect(asked.output).toBeUndefined();
    expect(asked.html).toContain(`<form data-call="call_1"></form>`);
    expect(held).toEqual([]);

    const allowed = await runVoiceTool(
      turn,
      { ...call, input: { title: "Something else" }, decision: "approve" },
      tools,
      catalog,
    );
    expect(allowed).toMatchObject({ state: "done", output: "Held Dune" });
    // What runs is what was asked for, not what came with the answer.
    expect(held).toEqual(["Dune"]);
    expect(allowed.html).toContain("Holding Dune");
    // An answer is taken once.
    expect(
      (
        await runVoiceTool(
          turn,
          { ...call, decision: "approve" },
          tools,
          catalog,
        )
      ).state,
    ).toBe("failed");
    expect(held).toEqual(["Dune"]);
  });

  it("never runs a refused call, and refuses an answer for a call nobody made", async () => {
    held = [];
    const turn = newVoiceTurn();
    const call = { id: "call_1", name: "place_hold", input: { title: "Dune" } };
    await runVoiceTool(turn, call, tools, catalog);
    const refused = await runVoiceTool(
      turn,
      { ...call, decision: "deny" },
      tools,
      catalog,
    );
    expect(refused.state).toBe("denied");
    expect(refused.output).toContain("declined");
    expect(held).toEqual([]);
    expect(
      (
        await runVoiceTool(
          turn,
          { id: "made_up", name: "place_hold", input: {}, decision: "approve" },
          tools,
          catalog,
        )
      ).state,
    ).toBe("failed");
    expect(held).toEqual([]);
  });

  it("reports bad input, an unknown tool, and a client tool to the model without running anything", async () => {
    held = [];
    const turn = newVoiceTurn();
    const run = (name: string, input: unknown, id: string) =>
      runVoiceTool(turn, { id, name, input }, tools, catalog);
    expect((await run("place_hold", { title: 3 }, "a")).output).toContain(
      '"title" must be a string',
    );
    expect((await run("place_hold", "Dune", "b")).output).toContain(
      "input must be an object",
    );
    expect((await run("drop_tables", {}, "c")).output).toContain(
      "no tool named drop_tables",
    );
    expect((await run("local_time", {}, "d")).output).toContain(
      "no tool named local_time",
    );
    expect(held).toEqual([]);
    // An id that is not safe to put in a page is replaced.
    await run("list_books", {}, `"><script>`);
    const ids = turn.parts.map((part) => (part as ToolPart).id);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("voiceMessages", () => {
  it("stores a turn as what the reader said and one message of what the model said, did, and showed", async () => {
    const turn = newVoiceTurn();
    await runVoiceTool(
      turn,
      { id: "c1", name: "list_books", input: {} },
      tools,
      catalog,
    );
    await runVoiceTool(
      turn,
      {
        id: "c2",
        name: SHOW_TOOL,
        input: { markup: `<book-card title="Dune">Sand</book-card>` },
      },
      tools,
      catalog,
    );
    await runVoiceTool(
      turn,
      { id: "c3", name: "place_hold", input: { title: "Dune" } },
      tools,
      catalog,
    );
    const messages = voiceMessages(turn, {
      reader: " Got anything good? ",
      model: `Here is one. <book-card title="x">`,
    });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(messages[0]!.content).toBe("Got anything good?");
    const parts = messages[1]!.parts!;
    expect(
      parts.map((part) =>
        part.type === "tool" ? `${part.name}:${part.state}` : "text",
      ),
    ).toEqual([
      "text",
      "list_books:done",
      "text",
      // Never answered: stored as refused, so it cannot run later.
      "place_hold:denied",
    ]);
    // What was spoken is words, even when it looks like a tag. What was shown is a component.
    const html = renderMessage(messages[1]!, catalog, { tools });
    expect(html).toContain(
      `<p class="spoken">Here is one. &lt;book-card title=&quot;x&quot;&gt;</p>`,
    );
    expect(html).toContain(
      `<book-card data-bascik-prop-title="Dune">Sand</book-card>`,
    );
    // The turn is empty again.
    expect(turn.parts).toEqual([]);
    expect(voiceMessages(turn, { reader: "", model: "" })).toEqual([]);
  });
});

describe("a view shown again", () => {
  const show = (turn: ReturnType<typeof newVoiceTurn>, markup: string) =>
    runVoiceTool(
      turn,
      {
        id: `call_${Math.random()}`.replace(".", ""),
        name: SHOW_TOOL,
        input: { markup },
      },
      tools,
      catalog,
    );

  it("tells the model when a view uses the same components as the one before it, across turns", async () => {
    const turn = newVoiceTurn();
    const first = await show(turn, `<book-card title="Dune">Sand.</book-card>`);
    expect(first.output).toBe("Shown on the reader's screen.");
    // The turn is stored; the next one starts, and what was on screen is remembered.
    voiceMessages(turn, { reader: "Show me a book", model: "Here it is." });
    const again = await show(
      turn,
      `<book-card title="Emma">Matchmaking.</book-card>`,
    );
    expect(again.output).toContain(
      "same components as the one before it (book-card)",
    );
    expect(again.output).toContain(`call ${SHOW_TOOL} again`);
    // A different kind of view is not remarked on.
    const other = await show(turn, `<tool-note>Two books.</tool-note>`);
    expect(other.output).toBe("Shown on the reader's screen.");
  });

  it("does not call plain text a repeated view", async () => {
    const turn = newVoiceTurn();
    await show(turn, "Two books, no components.");
    const again = await show(turn, "Another line of text.");
    expect(again.output).toBe("Shown on the reader's screen.");
  });

  it("teaches a speaking model to change the kind of view when asked to", () => {
    expect(voicePrompt(catalog)).toContain("change the kind of view");
  });
});

describe("fill_form", () => {
  it("is taught to a speaking model, and is never run on the server", async () => {
    expect(voicePrompt(catalog)).toContain(`call ${FILL_TOOL}`);
    const fill = voiceTools(tools).find((tool) => tool.name === FILL_TOOL)!;
    expect(fill.inputSchema.required).toEqual(["press"]);
    // It cannot be replaced by an app's tool of the same name.
    expect(
      voiceTools([{ ...tools[0]!, name: FILL_TOOL }]).filter(
        (tool) => tool.name === FILL_TOOL,
      ),
    ).toHaveLength(1);
    // The form is in the reader's browser: the server has nothing to press.
    const turn = newVoiceTurn();
    const result = await runVoiceTool(
      turn,
      { id: "call_9", name: FILL_TOOL, input: { press: "Allow" } },
      tools,
      catalog,
    );
    expect(result).toMatchObject({ state: "failed", html: "" });
    expect(turn.parts).toEqual([]);
  });
});

describe("geminiLiveVoice", () => {
  const config = { system: "Be brief.", tools: voiceTools(tools) };

  it("locks the model, the prompt, and the tools into the session setup", () => {
    const setup = geminiLiveSetup(config, {
      model: "models/m",
      voice: "Kore",
    }) as {
      generationConfig: { responseModalities: string[]; speechConfig: unknown };
      tools: {
        functionDeclarations: { name: string; parameters?: unknown }[];
      }[];
    };
    expect(setup).toMatchObject({
      model: "models/m",
      generationConfig: { responseModalities: ["AUDIO"] },
      systemInstruction: { parts: [{ text: "Be brief." }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    });
    expect(JSON.stringify(setup.generationConfig.speechConfig)).toContain(
      "Kore",
    );
    const declared = setup.tools[0]!.functionDeclarations;
    expect(declared.map((entry) => entry.name)).toEqual([
      "place_hold",
      "list_books",
      "show",
      "fill_form",
    ]);
    expect(declared[0]!.parameters).toEqual({
      type: "OBJECT",
      properties: { title: { type: "STRING", description: "The title" } },
      required: ["title"],
    });
    // A tool with no input declares no parameters.
    expect(declared[1]).not.toHaveProperty("parameters");
  });

  it("asks for a one-use token with the key in a header, and gives the browser a ticket without it", async () => {
    const requests: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      requests.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return Response.json({ name: "auth_tokens/abc 123" });
    }) as unknown as typeof fetch;
    const before = Date.now();
    const ticket = await geminiLiveVoice({
      apiKey: "secret-key",
      fetch: fake,
    }).createSession(config);
    expect(requests[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/auth_tokens",
    );
    expect(requests[0]!.headers["x-goog-api-key"]).toBe("secret-key");
    const body = requests[0]!.body as {
      uses: number;
      newSessionExpireTime: string;
      expireTime: string;
      bidiGenerateContentSetup: { model: string };
    };
    expect(body.uses).toBe(1);
    expect(Date.parse(body.newSessionExpireTime) - before).toBeLessThanOrEqual(
      61_000,
    );
    expect(Date.parse(body.expireTime) - before).toBeLessThanOrEqual(901_000);
    expect(body.bidiGenerateContentSetup.model).toBe("models/gemini-3.8-live");

    expect(ticket.protocol).toBe("gemini-live");
    expect(ticket.url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc%20123",
    );
    expect(ticket.setup).toEqual({
      setup: { model: "models/gemini-3.8-live" },
    });
    expect(JSON.stringify(ticket)).not.toContain("secret-key");
  });

  it("fails with the provider's words, and without a key says so", async () => {
    const refuses = (async () =>
      Response.json(
        { error: { message: "API key not valid." } },
        { status: 400 },
      )) as unknown as typeof fetch;
    await expect(
      geminiLiveVoice({ apiKey: "bad", fetch: refuses }).createSession(config),
    ).rejects.toThrow(/answered 400: API key not valid/);
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(geminiLiveVoice().createSession(config)).rejects.toThrow(
        /No Gemini API key/,
      );
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("voice tool calls through createChat", () => {
  const READER = "22222222-2222-4222-8222-222222222222";
  const CONVERSATION = "44444444-4444-4444-8444-444444444444";
  const posted = (fields: Record<string, string>): Request =>
    new Request("http://localhost/api/x", {
      method: "POST",
      headers: { cookie: `visitor=${READER}; chat_t=${CONVERSATION}` },
      body: new URLSearchParams(fields),
    });
  const page = (): Request =>
    new Request("http://x/books", {
      headers: { cookie: `visitor=${READER}; chat_t=${CONVERSATION}` },
    });

  async function voiced() {
    const ran: string[] = [];
    const pay: Tool = {
      name: "pay",
      description: "Pay.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      approval: true,
      // Slow enough that requests sent together overlap while it runs.
      run: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ran.push(String(input.title));
        return `Paid ${input.title}`;
      },
    };
    const chat = createChat({
      id: "t",
      store: memoryStore(),
      catalog,
      model: () => scriptedModel(() => "Hi", { delayMs: 0 }),
      system: "You help.",
      page: "/books",
      onError: () => {},
      tools: [pay],
      voice: {
        protocol: "fake",
        createSession: async () => ({ protocol: "fake", url: "", setup: null }),
      },
    });
    await chat.store.save(READER, {
      ...newConversation(),
      id: CONVERSATION,
      messages: [],
    });
    const call = async (fields: Record<string, string>) =>
      (await (await chat.voiceTool(posted(fields))).json()) as {
        state: string;
        output?: string;
      };
    const stored = async () => {
      await chat.voiceTurn(posted({ reader: "go", model: "ok" }));
      return (await chat.store.load(READER, CONVERSATION))!.messages.at(-1)!
        .parts!;
    };
    return { chat, ran, call, stored };
  }

  it("runs an approved call once when the approval is sent several times at once", async () => {
    const { ran, call, stored } = await voiced();
    const asked = { id: "c1", name: "pay", input: '{"title":"Dune"}' };
    expect((await call(asked)).state).toBe("approval-requested");
    const answers = await Promise.all(
      [1, 2, 3].map(() => call({ ...asked, decision: "approve" })),
    );
    expect(ran).toEqual(["Dune"]);
    expect(answers.map((answer) => answer.state).sort()).toEqual([
      "done",
      "failed",
      "failed",
    ]);
    expect(await stored()).toMatchObject([
      { type: "text" },
      { type: "tool", id: "c1", state: "done" },
    ]);
  });

  it("lets only one of an approval and a denial sent together count, and stores what happened", async () => {
    const { ran, call, stored } = await voiced();
    const asked = { id: "c1", name: "pay", input: '{"title":"Dune"}' };
    await call(asked);
    const answers = await Promise.all([
      call({ ...asked, decision: "approve" }),
      call({ ...asked, decision: "deny" }),
    ]);
    const states = answers.map((answer) => answer.state).sort();
    const part = (await stored()).find((p) => p.type === "tool") as ToolPart;
    expect(ran.length).toBeLessThanOrEqual(1);
    if (ran.length) {
      expect(states).toEqual(["done", "failed"]);
      expect(part.state).toBe("done");
    } else {
      expect(states).toEqual(["denied", "failed"]);
      expect(part.state).toBe("denied");
    }
  });

  it("does not run a call the turn stored as refused before the approval arrived", async () => {
    const { ran, call, stored } = await voiced();
    const asked = { id: "c1", name: "pay", input: '{"title":"Dune"}' };
    await call(asked);
    const [answer, parts] = await Promise.all([
      call({ ...asked, decision: "approve" }),
      stored(),
    ]);
    const part = parts.find((p) => p.type === "tool") as ToolPart;
    if (part.state === "denied") {
      expect(answer.state).toBe("failed");
      expect(ran).toEqual([]);
    } else {
      expect(ran).toEqual(["Dune"]);
    }
  });

  it("refuses a second call with an id already in the turn, even when both arrive at once", async () => {
    const { ran, call, stored } = await voiced();
    const answers = await Promise.all([
      call({ id: "X", name: "pay", input: '{"title":"EVIL"}' }),
      call({ id: "X", name: "pay", input: '{"title":"Dune"}' }),
    ]);
    expect(answers.map((answer) => answer.state).sort()).toEqual([
      "approval-requested",
      "failed",
    ]);
    const waiting =
      answers[0]!.state === "approval-requested" ? "EVIL" : "Dune";
    await call({
      id: "X",
      name: "pay",
      input: JSON.stringify({ title: waiting }),
      decision: "approve",
    });
    expect(ran).toEqual([waiting]);
    expect(
      (await stored()).filter((part) => part.type === "tool"),
    ).toHaveLength(1);
  });

  it("caps the bytes and parts one turn holds, and the views a conversation keeps", async () => {
    const { chat, call, stored } = await voiced();
    const markup = `<book-card title="Dune">${"x".repeat(60_000)}</book-card>`;
    const big = [];
    for (let at = 0; at < 20; at++) {
      big.push(
        await call({
          id: `big${at}`,
          name: "show",
          input: JSON.stringify({ markup }),
        }),
      );
    }
    expect(big[0]!.state).toBe("done");
    expect(big.at(-1)).toMatchObject({
      state: "failed",
      output: expect.stringContaining("holds too much"),
    });
    expect(JSON.stringify(await stored()).length).toBeLessThan(
      MAX_VOICE_TURN_CHARS + 1000,
    );

    const small = [];
    for (let at = 0; at < MAX_VOICE_PARTS + 5; at++) {
      small.push(
        await call({
          id: `s${at}`,
          name: "show",
          input: JSON.stringify({ markup: `<book-card title="${at}" />` }),
        }),
      );
    }
    expect(small.filter((answer) => answer.state === "done")).toHaveLength(
      MAX_VOICE_PARTS,
    );

    // Views outlive the turn, so they are capped for the conversation.
    for (let round = 0; round < 3; round++) {
      await stored();
      for (let at = 0; at < 30; at++) {
        await call({
          id: `v${round}_${at}`,
          name: "show",
          input: JSON.stringify({ markup: `<book-card title="v${at}" />` }),
        });
      }
    }
    expect(await chat.voiceView(page(), "big0")).toBe("");
    expect(await chat.voiceView(page(), "v0_0")).toBe("");
    expect(await chat.voiceView(page(), "v2_29")).toContain("v29");
    let kept = 0;
    for (let round = 0; round < 3; round++) {
      for (let at = 0; at < 30; at++) {
        if (await chat.voiceView(page(), `v${round}_${at}`)) kept++;
      }
    }
    expect(kept).toBe(MAX_VOICE_VIEWS);
  });

  it("caps parts in runVoiceTool too", async () => {
    const turn = newVoiceTurn();
    for (let at = 0; at < MAX_VOICE_PARTS; at++) {
      await runVoiceTool(
        turn,
        { id: `a${at}`, name: "list_books", input: {} },
        tools,
        catalog,
      );
    }
    const over = await runVoiceTool(
      turn,
      { id: "over", name: "list_books", input: {} },
      tools,
      catalog,
    );
    expect(over.state).toBe("failed");
    expect(turn.parts).toHaveLength(MAX_VOICE_PARTS);
  });
});
