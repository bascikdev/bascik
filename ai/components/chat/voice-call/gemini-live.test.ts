import { describe, expect, test } from "vitest";
import {
  geminiAudio,
  geminiLive,
  geminiText,
  geminiToolResponse,
  sender,
} from "./gemini-live.ts";
import type { WireHooks } from "./types.ts";

/** A socket that keeps what is sent, and hooks that record each call in order. */
function fake(answer = async (): Promise<string> => "done") {
  const calls: unknown[][] = [];
  const state = { said: "", reply: false, unheard: false };
  const socket = {
    readyState: WebSocket.OPEN as number,
    sent: [] as unknown[],
    send(data: string) {
      this.sent.push(JSON.parse(data));
    },
  };
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const hooks: WireHooks = {
    connected: log("connected"),
    answerTool: (tool) => (log("answerTool")(tool), answer()),
    mark: log("mark"),
    quiet: log("quiet"),
    heard: log("heard"),
    dropReply: () => (log("dropReply")(), state.unheard),
    active: log("active"),
    play: log("play"),
    spoke: log("spoke"),
    timedWord: log("timedWord"),
    newResponse: log("newResponse"),
    endTurn: log("endTurn"),
    said: () => state.said,
    hasReply: () => state.reply,
    isCurrent: () => true,
  };
  return { socket, hooks, calls, state };
}

describe("messages to Gemini Live", () => {
  test("audio, text and tool answers have the shapes Gemini reads", () => {
    expect(geminiAudio("AAA=")).toEqual({
      realtimeInput: {
        audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" },
      },
    });
    expect(geminiText("Is Kindred in stock?")).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Is Kindred in stock?" }] }],
        turnComplete: true,
      },
    });
    expect(
      geminiToolResponse([
        { id: "1", name: "search", response: { result: "ok" } },
      ]),
    ).toEqual({
      toolResponse: {
        functionResponses: [
          { id: "1", name: "search", response: { result: "ok" } },
        ],
      },
    });
  });

  test("nothing is sent once the socket is not open", () => {
    const { socket } = fake();
    socket.readyState = WebSocket.CLOSING;
    sender(socket)({ hello: true });
    expect(socket.sent).toEqual([]);
  });

  test("begin sends the ticket's setup; audio and text go as they are built", () => {
    const { socket, hooks } = fake();
    const wire = geminiLive({ socket }, { setup: { model: "m" } }, hooks);
    expect(wire.byMeter).toBe(true);
    wire.begin();
    wire.audio("AAA=");
    wire.text("Hello");
    expect(socket.sent).toEqual([
      { setup: { model: "m" } },
      geminiAudio("AAA="),
      geminiText("Hello"),
    ]);
  });
});

describe("messages from Gemini Live", () => {
  test("setupComplete means the call is on", async () => {
    const { socket, hooks, calls } = fake();
    await geminiLive({ socket }, {}, hooks).receive({ setupComplete: {} });
    expect(calls).toEqual([["connected"]]);
  });

  test("tool calls are answered in order, all in one reply", async () => {
    const { socket, hooks, calls } = fake(async () => "found");
    await geminiLive({ socket }, {}, hooks).receive({
      toolCall: {
        functionCalls: [
          { id: "a", name: "search", args: { q: "Butler" } },
          { id: "b", name: "fill_form", args: {} },
        ],
      },
    });
    expect(socket.sent).toEqual([
      geminiToolResponse([
        { id: "a", name: "search", response: { result: "found" } },
        { id: "b", name: "fill_form", response: { result: "found" } },
      ]),
    ]);
    expect(calls.map(([name]) => name)).toEqual([
      "answerTool",
      "answerTool",
      "mark",
    ]);
    expect(calls.at(-1)).toEqual(["mark", { thinking: true }]);
  });

  test("server content is heard, played and spoken in that order", async () => {
    const { socket, hooks, calls } = fake();
    await geminiLive({ socket }, {}, hooks).receive({
      serverContent: {
        interrupted: true,
        inputTranscription: { text: "Tell me about Dawn" },
        modelTurn: {
          parts: [
            { inlineData: { data: "A" } },
            { text: "x" },
            { inlineData: { data: "B" } },
          ],
        },
        outputTranscription: { text: "Dawn is" },
      },
    });
    expect(calls).toEqual([
      ["quiet"],
      ["heard", "Tell me about Dawn", "utterance-0"],
      ["play", "A"],
      ["play", "B"],
      ["spoke", "Dawn is"],
    ]);
  });

  test("a complete turn ends once the model has said something, or has no reply", async () => {
    const spoken = fake();
    spoken.state.said = "Dawn is a novel.";
    spoken.state.reply = true;
    await geminiLive({ socket: spoken.socket }, {}, spoken.hooks).receive({
      serverContent: { turnComplete: true },
    });
    expect(spoken.calls).toEqual([["endTurn"]]);

    const nothing = fake();
    await geminiLive({ socket: nothing.socket }, {}, nothing.hooks).receive({
      serverContent: { turnComplete: true },
    });
    expect(nothing.calls).toEqual([["endTurn"]]);
  });

  /** A tool whose answer the test gives when it chooses. */
  function slowTool() {
    let give!: (result: string) => void;
    const answer = new Promise<string>((resolve) => (give = resolve));
    return { answer: () => answer, give };
  }
  const toolCall = {
    toolCall: { functionCalls: [{ id: "a", name: "list_books", args: {} }] },
  };
  const ends = (calls: unknown[][]) =>
    calls.filter(([name]) => name === "endTurn").length;

  test("the turn the provider calls complete straight after a tool call is not over", async () => {
    const tool = slowTool();
    const { socket, hooks, calls } = fake(tool.answer);
    const wire = geminiLive({ socket }, {}, hooks);
    // The order of a real session: the call, then complete, then the answer.
    await wire.receive({
      serverContent: { inputTranscription: { text: "What is a good book?" } },
    });
    const answering = wire.receive(toolCall);
    await wire.receive({ serverContent: { generationComplete: true } });
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(0);
    tool.give("Two books.");
    await answering;
    expect(socket.sent).toHaveLength(1);
    // The model speaks of what the tool said, and that ends the turn.
    await wire.receive({
      serverContent: { outputTranscription: { text: "Try this." } },
    });
    expect(ends(calls)).toBe(0);
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
    expect(calls.at(-1)).toEqual(["endTurn"]);
  });

  test("a model that spoke and then called a tool has not ended its turn either", async () => {
    const tool = slowTool();
    const { socket, hooks, calls, state } = fake(tool.answer);
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive({
      serverContent: { outputTranscription: { text: "I can hold that." } },
    });
    state.said = "I can hold that.";
    state.reply = true;
    const answering = wire.receive(toolCall);
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(0);
    tool.give("Held.");
    await answering;
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
  });

  test("a tool answered before the provider calls the turn complete does not end it", async () => {
    const { socket, hooks, calls, state } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive(toolCall);
    state.reply = true;
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(0);
    // The model says nothing more: its next complete turn is the end.
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
  });

  test("a turn is not ended while a tool waits for the reader, whatever is said meanwhile", async () => {
    const tool = slowTool();
    const { socket, hooks, calls, state } = fake(tool.answer);
    const wire = geminiLive({ socket }, {}, hooks);
    const answering = wire.receive(toolCall);
    await wire.receive({ serverContent: { turnComplete: true } });
    // The reader asks something while the question is on screen, and is answered.
    await wire.receive({
      serverContent: { inputTranscription: { text: "Is it long?" } },
    });
    await wire.receive({
      serverContent: { outputTranscription: { text: "Not very." } },
    });
    state.said = "Not very.";
    state.reply = true;
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(0);
    tool.give("Allowed.");
    await answering;
    await wire.receive({
      serverContent: { outputTranscription: { text: " It is held." } },
    });
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
  });

  test("a tool that fails does not keep the turn open for ever", async () => {
    const { socket, hooks, calls } = fake(async () => {
      throw new Error("no answer");
    });
    const wire = geminiLive({ socket }, {}, hooks);
    await expect(wire.receive(toolCall)).rejects.toThrow("no answer");
    await wire.receive({ serverContent: { turnComplete: true } });
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
  });

  test("a cut with no turn open holds nothing: the next turn ends as usual", async () => {
    const { socket, hooks, calls, state } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    // A turn that is complete, and stored, while its voice still plays.
    await wire.receive({
      serverContent: { outputTranscription: { text: "answer one" } },
    });
    state.said = "answer one";
    state.reply = true;
    await wire.receive({ serverContent: { turnComplete: true } });
    state.said = "";
    state.reply = false;
    calls.length = 0;
    // The reader speaks over it: the provider says so, and no more.
    await wire.receive({ serverContent: { interrupted: true } });
    await wire.receive({
      serverContent: { inputTranscription: { text: "two" } },
    });
    await wire.receive({
      serverContent: { outputTranscription: { text: "answer two" } },
    });
    state.said = "answer two";
    state.reply = true;
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(calls.map(([name]) => name)).toEqual([
      "quiet",
      "heard",
      "spoke",
      "endTurn",
    ]);
  });

  test("a cut before the model has said anything holds the reader's turn open", async () => {
    const { socket, hooks, calls } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive({
      serverContent: { inputTranscription: { text: "Cool, so you're the" } },
    });
    await wire.receive({ serverContent: { interrupted: true } });
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(0);
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(ends(calls)).toBe(1);
  });

  test("what is heard after typed words is another utterance", async () => {
    const { socket, hooks, calls } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive({
      serverContent: { inputTranscription: { text: "spoken" } },
    });
    wire.text("typed");
    await wire.receive({
      serverContent: { inputTranscription: { text: "spoken next" } },
    });
    expect(calls).toEqual([
      ["heard", "spoken", "utterance-0"],
      ["heard", "spoken next", "utterance-1"],
    ]);
  });

  test("a call in use is not said to the provider", () => {
    const { socket, hooks } = fake();
    geminiLive({ socket }, {}, hooks).alive();
    expect(socket.sent).toEqual([]);
  });

  test("a message with nothing known in it does nothing", async () => {
    const { socket, hooks, calls } = fake();
    await geminiLive({ socket }, {}, hooks).receive({ usageMetadata: {} });
    expect(calls).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  test("muting tells the provider the microphone's sound has ended", () => {
    const { socket, hooks } = fake();
    geminiLive({ socket }, {}, hooks).pause();
    expect(socket.sent).toEqual([{ realtimeInput: { audioStreamEnd: true } }]);
  });

  test("the provider hearing a voice is the call in use", async () => {
    const { socket, hooks, calls } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive({ voiceActivity: { type: "ACTIVITY_START" } });
    await wire.receive({ voiceActivity: { type: "ACTIVITY_END" } });
    expect(calls).toEqual([["active"]]);
  });

  test("a reply the reader spoke over before hearing it does not end their turn", async () => {
    const { socket, hooks, calls, state } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    await wire.receive({
      serverContent: { inputTranscription: { text: "Cool, so you're the" } },
    });
    state.said = "Yep,";
    state.reply = true;
    state.unheard = true;
    await wire.receive({ serverContent: { interrupted: true } });
    state.said = "";
    state.reply = false;
    await wire.receive({ serverContent: { turnComplete: true } });
    await wire.receive({
      serverContent: {
        inputTranscription: { text: "assistant for the shop?" },
      },
    });
    expect(calls).toEqual([
      ["heard", "Cool, so you're the", "utterance-0"],
      ["dropReply"],
      ["quiet"],
      ["heard", "assistant for the shop?", "utterance-1"],
    ]);
    // The next complete turn ends as usual.
    state.said = "I am.";
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(calls.at(-1)).toEqual(["endTurn"]);
  });

  test("a reply the reader heard some of is a turn of its own", async () => {
    const { socket, hooks, calls, state } = fake();
    const wire = geminiLive({ socket }, {}, hooks);
    state.said = "Here are two books";
    state.reply = true;
    await wire.receive({ serverContent: { interrupted: true } });
    await wire.receive({ serverContent: { turnComplete: true } });
    expect(calls).toEqual([["dropReply"], ["quiet"], ["endTurn"]]);
  });
});
