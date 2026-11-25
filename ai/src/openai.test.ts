import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Model, ModelEvent, Tool, ToolPart } from "./model.ts";
import {
  listOpenAiCompatibleModels,
  openAiCompatibleModel,
  toWireMessages,
} from "./openai.ts";
import { runTurn } from "./turn.ts";

type Handler = (body: {
  model: string;
  messages: { role: string; content: string | null; tool_call_id?: string }[];
  tools?: unknown[];
}) => { status?: number; events?: object[]; raw?: string };

let server: Server | undefined;
const requests: { authorization?: string; body: Parameters<Handler>[0] }[] = [];

/** A real HTTP server that answers chat completions as an event stream. */
async function serve(handler: Handler, models: string[] = []): Promise<string> {
  requests.length = 0;
  server = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ authorization: request.headers.authorization, body });
    const answer = handler(body);
    response.statusCode = answer.status ?? 200;
    if (answer.raw !== undefined) {
      response.end(answer.raw);
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    // Split mid-line, as a network does.
    const stream = `${(answer.events ?? []).map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: [DONE]\n\n`;
    for (let at = 0; at < stream.length; at += 7) {
      response.write(stream.slice(at, at + 7));
    }
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(0)));
  server = undefined;
});

const text = (content: string) => ({ choices: [{ delta: { content } }] });
const stop = (finish_reason = "stop") => ({
  choices: [{ delta: {}, finish_reason }],
});

/** The text of one round. */
async function collect(stream: AsyncIterable<ModelEvent>): Promise<string> {
  let all = "";
  for await (const piece of stream) {
    if (typeof piece === "string") all += piece;
  }
  return all;
}

/** A whole turn: the model's rounds with the tools run between them. */
async function turn(
  model: Model,
  tools: Tool[],
  maxRounds?: number,
): Promise<{ text: string; calls: ToolPart[] }> {
  const running = runTurn({ model, ...ask, tools, maxRounds });
  let text = "";
  for await (const event of running.events) {
    if (event.type === "text") text += event.delta;
  }
  return {
    text,
    calls: running.message.parts!.filter(
      (part): part is ToolPart => part.type === "tool",
    ),
  };
}

const ask = {
  system: "Be brief.",
  messages: [{ role: "user" as const, content: "Hi" }],
};

describe("openAiCompatibleModel", () => {
  it("streams the reply, however the event stream is sliced", async () => {
    const baseUrl = await serve(() => ({
      events: [
        text("Hello, "),
        text('<book-card title="A">'),
        text("b</book-card>"),
        stop(),
      ],
    }));
    const model = openAiCompatibleModel({
      baseUrl: `${baseUrl}/`,
      model: "llama3.2:3b",
    });
    expect(await collect(model(ask))).toBe(
      'Hello, <book-card title="A">b</book-card>',
    );
    expect(requests[0]!.body.model).toBe("llama3.2:3b");
    expect(requests[0]!.body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ]);
    expect(requests[0]!.authorization).toBeUndefined();
    expect(requests[0]!.body.tools).toBeUndefined();
  });

  it("sends the key as a bearer token when there is one", async () => {
    const baseUrl = await serve(() => ({ events: [text("ok"), stop()] }));
    await collect(
      openAiCompatibleModel({ baseUrl, model: "m", apiKey: "sk-test" })(ask),
    );
    expect(requests[0]!.authorization).toBe("Bearer sk-test");
  });

  it("sends extra request fields a server needs, without letting them replace its own", async () => {
    const baseUrl = await serve(() => ({ events: [text("ok"), stop()] }));
    await collect(
      openAiCompatibleModel({
        baseUrl,
        model: "m",
        body: { reasoning_effort: "low", model: "another", stream: false },
      })(ask),
    );
    expect(requests[0]!.body).toMatchObject({
      reasoning_effort: "low",
      model: "m",
      stream: true,
    });
  });

  const lookup: Tool = {
    name: "find_book",
    description: "Find a book by title.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    note: (input) => `<tool-note>Looking up ${String(input.title)}</tool-note>`,
    run: (input) => JSON.stringify({ title: input.title, rating: 4.6 }),
  };
  const call = (args: string[], name = "find_book") => [
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "c1", function: { name } }] } },
      ],
    },
    ...args.map((piece) => ({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] },
        },
      ],
    })),
    stop("tool_calls"),
  ];

  it("yields a tool call that arrived in pieces, and continues with its result", async () => {
    const baseUrl = await serve((body) =>
      body.messages.at(-1)!.role === "tool"
        ? { events: [text("Rated 4.6."), stop()] }
        : { events: call(['{"tit', 'le":"Dune"}']) },
    );
    const model = openAiCompatibleModel({ baseUrl, model: "m" });
    // One round only asks: it never runs a tool itself.
    const events: ModelEvent[] = [];
    for await (const event of model({ ...ask, tools: [lookup] })) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "tool-call",
        id: "c1",
        name: "find_book",
        input: { title: "Dune" },
      },
    ]);
    expect(requests).toHaveLength(1);

    const reply = await turn(model, [lookup]);
    expect(reply.text).toBe("Rated 4.6.");
    expect(reply.calls).toMatchObject([
      { id: "c1", state: "done", output: '{"title":"Dune","rating":4.6}' },
    ]);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.body.messages.slice(-2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "find_book", arguments: '{"title":"Dune"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: '{"title":"Dune","rating":4.6}',
      },
    ]);
  });

  it.each([
    ["input that is not JSON", ["{oops"], "find_book", "must be an object"],
    [
      "input that fails the schema",
      ['{"isbn":1}'],
      "find_book",
      'missing "title"',
    ],
    [
      "a tool that does not exist",
      ["{}"],
      "drop_tables",
      "no tool named drop_tables",
    ],
  ])(
    "tells the model about %s and never runs it",
    async (_name, args, name, said) => {
      let ran = false;
      const baseUrl = await serve((body) =>
        body.messages.at(-1)!.role === "tool"
          ? { events: [text("Sorry."), stop()] }
          : { events: call(args, name) },
      );
      const reply = await turn(openAiCompatibleModel({ baseUrl, model: "m" }), [
        { ...lookup, run: () => ((ran = true), "x") },
      ]);
      expect(ran).toBe(false);
      expect(reply.calls[0]!.state).toBe("failed");
      expect(reply.text).toBe("Sorry.");
      const told = requests[1]!.body.messages.at(-1)!.content;
      expect(told).toMatch(/^Error: /);
      expect(told).toContain(said);
    },
  );

  it("stops a model that keeps calling tools", async () => {
    const baseUrl = await serve(() => ({ events: call(['{"title":"A"}']) }));
    const reply = await turn(
      openAiCompatibleModel({ baseUrl, model: "m" }),
      [lookup],
      2,
    );
    expect(reply.text).toMatch(
      /Stopped: this reply needed too many tool calls\.$/,
    );
    expect(requests).toHaveLength(2);
  });

  it("writes a refused call and a call nobody answered as failed results", () => {
    const part = (id: string, state: ToolPart["state"]): ToolPart => ({
      type: "tool",
      id,
      name: "find_book",
      input: { title: "Dune" },
      state,
    });
    expect(
      toWireMessages("s", [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Checking.",
          parts: [
            { type: "text", text: "Checking." },
            part("a", "denied"),
            part("b", "approval-requested"),
            { type: "text", text: "Done." },
          ],
        },
      ]).map((message) => [message.role, message.content]),
    ).toEqual([
      ["system", "s"],
      ["user", "Hi"],
      ["assistant", "Checking."],
      ["tool", "Error: The reader declined this action."],
      ["tool", "Error: The action was never confirmed."],
      ["assistant", "Done."],
    ]);
  });

  it("does not run a tool call cut off at the length limit", async () => {
    const baseUrl = await serve(() => ({
      events: [...call(['{"title":"A']).slice(0, -1), stop("length")],
    }));
    const reply = await collect(
      openAiCompatibleModel({ baseUrl, model: "m" })({
        ...ask,
        tools: [lookup],
      }),
    );
    expect(reply).toBe("\n\nThe reply was cut off at the length limit.");
    expect(requests).toHaveLength(1);
  });

  it("fails with the server's own words when the model is not there", async () => {
    const baseUrl = await serve(() => ({
      status: 404,
      raw: '{"error":"model \\"nope\\" not found, try pulling it first"}',
    }));
    await expect(
      collect(openAiCompatibleModel({ baseUrl, model: "nope" })(ask)),
    ).rejects.toThrow(/answered 404 for "nope".*try pulling it first/);
  });

  it("skips lines that are not events", async () => {
    const baseUrl = await serve(() => ({
      raw: `: keep-alive\n\ndata: not json\n\ndata: ${JSON.stringify(text("ok"))}\n\ndata: [DONE]`,
    }));
    expect(
      await collect(openAiCompatibleModel({ baseUrl, model: "m" })(ask)),
    ).toBe("ok");
  });
});

describe("listOpenAiCompatibleModels", () => {
  it("lists what the server has", async () => {
    const baseUrl = await serve(
      () => ({}),
      ["llama3.2:3b", "qwen2.5-coder:7b"],
    );
    expect(await listOpenAiCompatibleModels({ baseUrl })).toEqual([
      "llama3.2:3b",
      "qwen2.5-coder:7b",
    ]);
  });

  it("is empty, not an error, when nothing answers", async () => {
    expect(
      await listOpenAiCompatibleModels({
        baseUrl: "http://127.0.0.1:9/v1",
        timeoutMs: 200,
      }),
    ).toEqual([]);
  });
});
