import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import { geminiLiveSetup, geminiLiveVoice } from "./gemini-live.ts";
import type { Tool, ToolPart } from "./model.ts";
import { renderMessage } from "./render-turn.ts";
import {
  newVoiceTurn,
  runVoiceTool,
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
    ]);
    // Asking twice does not add show twice.
    expect(voiceTools(voiceTools(tools))).toHaveLength(3);
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
