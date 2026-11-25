import { describe, expect, it } from "vitest";
import type { ChatMessage, ModelEvent, Tool, ToolPart } from "./model.ts";
import { openAiResponsesModel, toResponsesInput } from "./openai-responses.ts";
import { runTurn } from "./turn.ts";

interface Sent {
  url: string;
  authorization: string | null;
  body: {
    model: string;
    stream: boolean;
    store: boolean;
    instructions: string;
    input: { type?: string; role?: string; [key: string]: unknown }[];
    tools?: unknown[];
    [key: string]: unknown;
  };
}

/** A `fetch` that answers each request with an event stream, sliced mid-line as a network does. */
function server(
  answer: (body: Sent["body"]) => {
    status?: number;
    events?: object[];
    raw?: string;
  },
): { send: typeof fetch; requests: Sent[] } {
  const requests: Sent[] = [];
  const send: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init!.body)) as Sent["body"];
    requests.push({
      url: String(input),
      authorization: new Headers(init!.headers).get("authorization"),
      body,
    });
    const reply = answer(body);
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status ?? 200 });
    }
    const stream = (reply.events ?? [])
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`,
      )
      .join("");
    const bytes = new TextEncoder().encode(stream);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < bytes.length; at += 11) {
            controller.enqueue(bytes.slice(at, at + 11));
          }
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return { send, requests };
}

const text = (delta: string) => ({ type: "response.output_text.delta", delta });
const done = { type: "response.completed", response: { status: "completed" } };
const call = (args: string, name = "find_book", call_id = "call_1") => [
  // The input also arrives in pieces first; the adapter takes the finished item.
  { type: "response.function_call_arguments.delta", delta: args.slice(0, 3) },
  {
    type: "response.output_item.done",
    item: { type: "function_call", call_id, name, arguments: args },
  },
  done,
];

const ask = {
  system: "Be brief.",
  messages: [{ role: "user" as const, content: "Hi" }],
};
const lookup: Tool = {
  name: "find_book",
  description: "Find a book by title.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  run: (input) => JSON.stringify({ title: input.title, rating: 4.6 }),
};

async function collect(
  stream: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const all: ModelEvent[] = [];
  for await (const piece of stream) all.push(piece);
  return all;
}

const baseUrl = "https://example.test/openai/v1/";

describe("openAiResponsesModel", () => {
  it("streams the reply, asking on /responses with the prompt as instructions and nothing stored", async () => {
    const { send, requests } = server(() => ({
      events: [
        { type: "response.created" },
        text("Hel"),
        text("lo <note-box>hi</note-box>"),
        // A message item finishing is not a tool call.
        { type: "response.output_item.done", item: { type: "message" } },
        done,
      ],
    }));
    const model = openAiResponsesModel({
      baseUrl,
      model: "gpt-new",
      apiKey: "sk-test",
      fetch: send,
      body: { reasoning: { effort: "low" }, store: true, model: "another" },
    });
    expect((await collect(model(ask))).join("")).toBe(
      "Hello <note-box>hi</note-box>",
    );
    expect(requests[0]).toMatchObject({
      url: "https://example.test/openai/v1/responses",
      authorization: "Bearer sk-test",
      body: {
        // Extra fields are sent, and cannot replace the adapter's own.
        reasoning: { effort: "low" },
        model: "gpt-new",
        stream: true,
        store: false,
        instructions: "Be brief.",
        input: [{ role: "user", content: "Hi" }],
      },
    });
    expect(requests[0]!.body).not.toHaveProperty("tools");
  });

  it("yields a tool call once its input is whole, and continues with its result", async () => {
    const { send, requests } = server((body) =>
      body.input.at(-1)!.type === "function_call_output"
        ? { events: [text("Rated 4.6."), done] }
        : { events: [text("Looking. "), ...call('{"title":"Dune"}')] },
    );
    const model = openAiResponsesModel({ baseUrl, model: "m", fetch: send });
    // One round only asks: it never runs a tool itself.
    expect(await collect(model({ ...ask, tools: [lookup] }))).toEqual([
      "Looking. ",
      {
        type: "tool-call",
        id: "call_1",
        name: "find_book",
        input: { title: "Dune" },
      },
    ]);
    expect(requests[0]!.body.tools).toEqual([
      {
        type: "function",
        name: "find_book",
        description: "Find a book by title.",
        parameters: lookup.inputSchema,
      },
    ]);

    const running = runTurn({ model, ...ask, tools: [lookup] });
    let said = "";
    for await (const event of running.events) {
      if (event.type === "text") said += event.delta;
    }
    expect(said).toBe("Looking. Rated 4.6.");
    expect(
      running.message.parts!.filter(
        (part): part is ToolPart => part.type === "tool",
      ),
    ).toMatchObject([
      { id: "call_1", state: "done", output: '{"title":"Dune","rating":4.6}' },
    ]);
    expect(requests.at(-1)!.body.input).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Looking. " },
      {
        type: "function_call",
        call_id: "call_1",
        name: "find_book",
        arguments: '{"title":"Dune"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"title":"Dune","rating":4.6}',
      },
    ]);
  });

  it("passes on input that is not JSON, so the turn refuses it and tells the model", async () => {
    let ran = false;
    const { send, requests } = server((body) =>
      body.input.at(-1)!.type === "function_call_output"
        ? { events: [text("Sorry."), done] }
        : { events: call("{oops") },
    );
    const running = runTurn({
      model: openAiResponsesModel({ baseUrl, model: "m", fetch: send }),
      ...ask,
      tools: [{ ...lookup, run: () => ((ran = true), "x") }],
    });
    for await (const _event of running.events) {
      // Run to the end.
    }
    expect(ran).toBe(false);
    expect(String(requests[1]!.body.input.at(-1)!.output)).toMatch(/^Error: /);
  });

  it("does not run a tool call from a reply cut off at the length limit", async () => {
    const { send } = server(() => ({
      events: [
        text("So"),
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "c",
            name: "find_book",
            arguments: '{"ti',
          },
        },
        { type: "response.incomplete", response: { status: "incomplete" } },
      ],
    }));
    const model = openAiResponsesModel({ baseUrl, model: "m", fetch: send });
    expect(await collect(model({ ...ask, tools: [lookup] }))).toEqual([
      "So",
      "\n\nThe reply was cut off at the length limit.",
    ]);
  });

  it("fails with the server's own words, before or during the stream", async () => {
    const refused = server(() => ({
      status: 404,
      raw: '{"error":{"message":"The deployment does not exist."}}',
    }));
    await expect(
      collect(
        openAiResponsesModel({ baseUrl, model: "gone", fetch: refused.send })(
          ask,
        ),
      ),
    ).rejects.toThrow(/answered 404 for "gone".*does not exist/);

    const broke = server(() => ({
      events: [
        text("So"),
        {
          type: "response.failed",
          response: { error: { message: "Out of capacity." } },
        },
      ],
    }));
    await expect(
      collect(
        openAiResponsesModel({ baseUrl, model: "m", fetch: broke.send })(ask),
      ),
    ).rejects.toThrow('failed for "m": Out of capacity.');
  });

  it("skips lines that are not events", async () => {
    const { send } = server(() => ({
      raw: `: keep-alive\n\ndata: not json\n\ndata: ${JSON.stringify(text("ok"))}\n\ndata: [DONE]\n\n`,
    }));
    const model = openAiResponsesModel({ baseUrl, model: "m", fetch: send });
    expect(await collect(model(ask))).toEqual(["ok"]);
  });
});

describe("toResponsesInput", () => {
  it("writes each round as its text, its calls, then what each call came to", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hold two" },
      { role: "assistant", content: "An older reply." },
      {
        role: "assistant",
        content: "",
        parts: [
          { type: "text", text: "Holding both." },
          {
            type: "tool",
            id: "a",
            name: "hold",
            input: { n: 1 },
            state: "done",
            output: "H-1",
          },
          {
            type: "tool",
            id: "b",
            name: "hold",
            input: { n: 2 },
            state: "denied",
          },
          { type: "text", text: "One is held." },
        ],
      },
    ];
    const input = toResponsesInput(messages);
    expect(
      input.map((item) => ("type" in item ? item.type : item.role)),
    ).toEqual([
      "user",
      "assistant",
      "assistant",
      "function_call",
      "function_call",
      "function_call_output",
      "function_call_output",
      "assistant",
    ]);
    expect(input[5]).toEqual({
      type: "function_call_output",
      call_id: "a",
      output: "H-1",
    });
    // A call the reader refused is told to the model as a failure.
    expect(String((input[6] as { output: string }).output)).toMatch(/^Error: /);
  });
});
