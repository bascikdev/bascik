import { describe, expect, it } from "vitest";
import {
  roundsOf,
  scriptedModel,
  toolResult,
  type ChatMessage,
  type Model,
  type ModelRequest,
  type Tool,
  type ToolPart,
} from "./model.ts";
import {
  abandonToolCalls,
  answerToolCall,
  decideToolCall,
  runTurn,
  turnPending,
  type TurnEvent,
} from "./turn.ts";

const lookUp: Tool = {
  name: "look_up",
  description: "Look a title up.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  run: (input) => `Found ${input.title}`,
};

const hold: Tool = {
  name: "place_hold",
  description: "Hold a copy.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  approval: true,
  run: (input) => {
    if (input.title === "Missing") throw new Error("No such book.");
    return `Held ${input.title}`;
  },
};

const tools = [lookUp, hold];
const ask: ChatMessage = { role: "user", content: "Hold it" };

/** A model that plays one scripted round per call and records what it was shown. */
function rounds(...script: (string | { name: string; input: unknown })[][]): {
  model: Model;
  seen: ModelRequest[];
} {
  const seen: ModelRequest[] = [];
  let at = 0;
  const model = scriptedModel(
    (request) => {
      seen.push(structuredClone({ ...request, signal: undefined, tools: [] }));
      return (script[at++] ?? []).map((event) =>
        typeof event === "string"
          ? event
          : { type: "tool-call" as const, ...event },
      );
    },
    { delayMs: 0, chunkSize: 100 },
  );
  return { model, seen };
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<string[]> {
  const log: string[] = [];
  for await (const event of events) {
    log.push(
      event.type === "text"
        ? `text:${event.delta}`
        : `tool:${event.part.name}:${event.part.state}`,
    );
  }
  return log;
}

const toolParts = (message: ChatMessage): ToolPart[] =>
  (message.parts ?? []).filter(
    (part): part is ToolPart => part.type === "tool",
  );

describe("runTurn", () => {
  it("reads each attached file once per turn, however many rounds it takes", async () => {
    const file = {
      type: "file" as const,
      id: "scan",
      name: "scan.png",
      mediaType: "image/png",
      size: 3,
    };
    const withFile: ChatMessage = {
      role: "user",
      content: "Find this",
      parts: [{ type: "text", text: "Find this" }, file],
    };
    let reads = 0;
    let round = 0;
    const model: Model = async function* (request) {
      expect(await request.readFile!(file)).toEqual(new Uint8Array([1, 2, 3]));
      if (round++ < 2) {
        yield { type: "tool-call", name: "look_up", input: { title: "Dune" } };
      } else yield "Done.";
    };
    const turn = runTurn({
      model,
      system: "",
      messages: [withFile],
      tools,
      readFile: async () => {
        reads++;
        return new Uint8Array([1, 2, 3]);
      },
    });
    await collect(turn.events);
    expect(round).toBe(3);
    expect(reads).toBe(1);
  });

  it("passes a reply with no tool calls through as one text part", async () => {
    const { model } = rounds(["Hello"]);
    const turn = runTurn({ model, system: "", messages: [ask] });
    expect(await collect(turn.events)).toEqual(["text:Hello"]);
    expect(turn.message).toEqual({
      role: "assistant",
      content: "Hello",
      parts: [{ type: "text", text: "Hello" }],
    });
  });

  it("runs a tool, reports each state, and asks the model again with the result", async () => {
    const { model, seen } = rounds(
      ["Looking. ", { name: "look_up", input: { title: "Dune" } }],
      ["It is in stock."],
    );
    const turn = runTurn({ model, system: "s", messages: [ask], tools });
    expect(await collect(turn.events)).toEqual([
      "text:Looking. ",
      "tool:look_up:running",
      "tool:look_up:done",
      "text:It is in stock.",
    ]);
    expect(turn.message.parts!.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "text",
    ]);
    expect(toolParts(turn.message)[0]).toMatchObject({
      state: "done",
      output: "Found Dune",
      input: { title: "Dune" },
    });
    expect(turn.message.content).toBe("Looking. \nIt is in stock.");
    expect(turn.message.awaiting).toBeUndefined();
    // The second round saw the first one's call and its result.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.messages).toEqual([ask]);
    const shown = seen[1]!.messages.at(-1)!;
    expect(shown.role).toBe("assistant");
    expect(toolResult(toolParts(shown)[0]!)).toEqual({
      text: "Found Dune",
      failed: false,
    });
  });

  it("stops at a call that needs approval, and carries on once it is allowed", async () => {
    const first = rounds([
      "I need your OK. ",
      { name: "place_hold", input: { title: "Dune" } },
    ]);
    const turn = runTurn({
      model: first.model,
      system: "",
      messages: [ask],
      tools,
    });
    expect(await collect(turn.events)).toEqual([
      "text:I need your OK. ",
      "tool:place_hold:approval-requested",
    ]);
    expect(turn.message.awaiting).toBe("reader");
    expect(first.seen).toHaveLength(1);

    const messages = [ask, turn.message];
    expect(turnPending(messages)).toBe(false);
    const call = toolParts(turn.message)[0]!;
    expect(decideToolCall(messages, "not-a-call", true)).toBe(false);
    expect(decideToolCall(messages, call.id, true)).toBe(true);
    // An answer is given once.
    expect(decideToolCall(messages, call.id, false)).toBe(false);
    expect(turn.message.awaiting).toBe("model");
    expect(turnPending(messages)).toBe(true);

    const second = rounds(["Held."]);
    const next = runTurn({
      model: second.model,
      system: "",
      messages,
      tools,
    });
    expect(await collect(next.events)).toEqual([
      "tool:place_hold:running",
      "tool:place_hold:done",
      "text:Held.",
    ]);
    // One message: the turn carried on, it did not start another.
    expect(next.message.parts!.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "text",
    ]);
    expect(toolParts(next.message)[0]).toMatchObject({
      id: call.id,
      state: "done",
      output: "Held Dune",
    });
    expect(next.message.awaiting).toBeUndefined();
    expect(second.seen[0]!.messages).toHaveLength(2);
  });

  it("never runs a call the reader refused, and tells the model", async () => {
    const first = rounds([{ name: "place_hold", input: { title: "Dune" } }]);
    const turn = runTurn({
      model: first.model,
      system: "",
      messages: [ask],
      tools,
    });
    await collect(turn.events);
    const messages = [ask, turn.message];
    decideToolCall(messages, toolParts(turn.message)[0]!.id, false);

    const second = rounds(["Nothing was held."]);
    const next = runTurn({ model: second.model, system: "", messages, tools });
    expect(await collect(next.events)).toEqual(["text:Nothing was held."]);
    const refused = toolParts(next.message)[0]!;
    expect(refused.state).toBe("denied");
    expect(refused.output).toBeUndefined();
    expect(toolResult(toolParts(second.seen[0]!.messages.at(-1)!)[0]!)).toEqual(
      { text: "The reader declined this action.", failed: true },
    );
  });

  it("runs the other calls of a round while one waits, and waits for every answer", async () => {
    const { model } = rounds([
      { name: "look_up", input: { title: "A" } },
      { name: "place_hold", input: { title: "B" } },
      { name: "place_hold", input: { title: "C" } },
    ]);
    const turn = runTurn({ model, system: "", messages: [ask], tools });
    expect(await collect(turn.events)).toEqual([
      "tool:place_hold:approval-requested",
      "tool:place_hold:approval-requested",
      "tool:look_up:running",
      "tool:look_up:done",
    ]);
    const messages = [ask, turn.message];
    const [, second, third] = toolParts(turn.message);
    decideToolCall(messages, second!.id, true);
    expect(turn.message.awaiting).toBe("reader");
    decideToolCall(messages, third!.id, false);
    expect(turn.message.awaiting).toBe("model");
  });

  it("reports a failed tool, an unknown tool, and bad input to the model instead of throwing", async () => {
    const { model, seen } = rounds(
      [
        { name: "nope", input: {} },
        { name: "look_up", input: { title: 3 } },
        { name: "look_up", input: "Dune" },
      ],
      ["Sorry."],
    );
    const turn = runTurn({ model, system: "", messages: [ask], tools });
    await collect(turn.events);
    expect(toolParts(turn.message).map((part) => part.error)).toEqual([
      "Invalid call: there is no tool named nope.",
      'Invalid call: "title" must be a string.',
      "Invalid call: input must be an object.",
    ]);
    expect(seen).toHaveLength(2);

    const failing = rounds(
      [{ name: "place_hold", input: { title: "Missing" } }],
      ["It failed."],
    );
    const first = runTurn({
      model: failing.model,
      system: "",
      messages: [ask],
      tools,
    });
    await collect(first.events);
    const messages = [ask, first.message];
    decideToolCall(messages, toolParts(first.message)[0]!.id, true);
    const next = runTurn({
      model: failing.model,
      system: "",
      messages,
      tools,
    });
    expect(await collect(next.events)).toEqual([
      "tool:place_hold:running",
      "tool:place_hold:failed",
      "text:It failed.",
    ]);
    expect(toolParts(next.message)[0]).toMatchObject({
      state: "failed",
      error: "No such book.",
    });
  });

  it("gives every call an id that is safe to put in a page and unique in the conversation", async () => {
    const { model } = rounds([
      { name: "look_up", input: { title: "A" }, id: "toolu_01" } as never,
      { name: "look_up", input: { title: "B" }, id: "toolu_01" } as never,
      { name: "look_up", input: { title: "C" }, id: '"><script>' } as never,
      { name: "look_up", input: { title: "D" } },
    ]);
    const turn = runTurn({ model, system: "", messages: [ask], tools });
    await collect(turn.events);
    const ids = toolParts(turn.message).map((part) => part.id);
    expect(ids[0]).toBe("toolu_01");
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("stops a model that never stops calling tools", async () => {
    const model: Model = async function* () {
      yield { type: "tool-call", name: "look_up", input: { title: "A" } };
    };
    const turn = runTurn({
      model,
      system: "",
      messages: [ask],
      tools,
      maxRounds: 3,
    });
    const log = await collect(turn.events);
    expect(log.filter((line) => line === "tool:look_up:done")).toHaveLength(3);
    expect(log.at(-1)).toContain("too many tool calls");
  });

  it("keeps what was written when the reader leaves, and marks a cut-off call", async () => {
    let release = (): void => {};
    const slow: Tool = {
      ...lookUp,
      run: () =>
        new Promise<string>((resolve) => (release = () => resolve("late"))),
    };
    const { model } = rounds([
      "Working. ",
      { name: "look_up", input: { title: "A" } },
    ]);
    const turn = runTurn({ model, system: "", messages: [ask], tools: [slow] });
    const seen: string[] = [];
    for await (const event of turn.events) {
      seen.push(event.type);
      if (event.type === "tool") break; // the reader left while it ran
    }
    release();
    expect(seen).toEqual(["text", "tool"]);
    expect(turn.message.content).toBe("Working.");
    expect(toolParts(turn.message)[0]).toMatchObject({
      state: "failed",
      error: "Interrupted before it finished.",
    });
  });
});

describe("client tools", () => {
  const clock: Tool = {
    name: "local_time",
    description: "The reader's local time.",
    inputSchema: { type: "object", properties: {} },
    client: true,
  };

  it("stops at a client tool, and carries on with the result the reader's side sent", async () => {
    const first = rounds(["Checking. ", { name: "local_time", input: {} }]);
    const turn = runTurn({
      model: first.model,
      system: "",
      messages: [ask],
      tools: [clock],
    });
    expect(await collect(turn.events)).toEqual([
      "text:Checking. ",
      "tool:local_time:client-requested",
    ]);
    expect(turn.message.awaiting).toBe("reader");

    const messages = [ask, turn.message];
    const call = toolParts(turn.message)[0]!;
    // It is not an approval, and it is answered once.
    expect(decideToolCall(messages, call.id, true)).toBe(false);
    expect(answerToolCall(messages, call.id, "x".repeat(5000))).toBe(true);
    expect(answerToolCall(messages, call.id, "again")).toBe(false);
    expect(call).toMatchObject({ state: "done" });
    expect(call.output).toHaveLength(4000);
    expect(turn.message.awaiting).toBe("model");

    const second = rounds(["It is late."]);
    const next = runTurn({
      model: second.model,
      system: "",
      messages,
      tools: [clock],
    });
    // Nothing runs on the server: the result is already there.
    expect(await collect(next.events)).toEqual(["text:It is late."]);
    expect(
      toolResult(toolParts(second.seen[0]!.messages.at(-1)!)[0]!).failed,
    ).toBe(false);
  });

  it("refuses every waiting call when the reader moves on", async () => {
    const { model } = rounds([
      { name: "local_time", input: {} },
      { name: "place_hold", input: { title: "Dune" } },
    ]);
    const turn = runTurn({
      model,
      system: "",
      messages: [ask],
      tools: [clock, hold],
    });
    await collect(turn.events);
    const messages = [ask, turn.message];
    abandonToolCalls(messages);
    expect(toolParts(turn.message).map((part) => part.state)).toEqual([
      "denied",
      "denied",
    ]);
    expect(turn.message.awaiting).toBeUndefined();
    expect(turnPending(messages)).toBe(false);
    // And only the open turn: a settled conversation is left alone.
    abandonToolCalls([ask]);
  });
});

describe("message parts", () => {
  it("splits a message into the rounds a model wrote it in", () => {
    const call = (id: string): ToolPart => ({
      type: "tool",
      id,
      name: "look_up",
      input: {},
      state: "done",
      output: id,
    });
    expect(
      roundsOf([
        { type: "text", text: "a" },
        call("1"),
        call("2"),
        call("3"),
        { type: "text", text: "b" },
        { type: "text", text: "c" },
      ]).map((round) => [round.text, round.calls.map((part) => part.id)]),
    ).toEqual([
      ["a", ["1", "2", "3"]],
      ["bc", []],
    ]);
    expect(roundsOf([call("1")])).toEqual([{ text: "", calls: [call("1")] }]);
    expect(roundsOf([])).toEqual([]);
  });

  it("says what a call came to in every state", () => {
    const part = (state: ToolPart["state"]): ToolPart => ({
      type: "tool",
      id: "1",
      name: "x",
      input: {},
      state,
      output: "out",
      error: "err",
    });
    expect(toolResult(part("done"))).toEqual({ text: "out", failed: false });
    expect(toolResult(part("failed"))).toEqual({ text: "err", failed: true });
    expect(toolResult(part("denied")).failed).toBe(true);
    expect(toolResult(part("approval-requested")).failed).toBe(true);
  });
});
