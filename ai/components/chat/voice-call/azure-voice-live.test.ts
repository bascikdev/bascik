import { describe, expect, test } from "vitest";
import {
  azureAudio,
  azureToolOutput,
  azureUserText,
  azureVoiceLive,
  parseToolArguments,
} from "./azure-voice-live.ts";
import type { WireHooks } from "./types.ts";

/** A socket that keeps what is sent, and hooks that record each call in order. */
function fake(answer = async (): Promise<string> => "done") {
  const calls: unknown[][] = [];
  const state = { said: "", current: true, unheard: false };
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
    hasReply: () => false,
    isCurrent: () => state.current,
  };
  const wire = azureVoiceLive({ socket }, hooks);
  return { socket, wire, calls, state };
}

describe("events to Azure Voice Live", () => {
  test("audio, text and tool output have the realtime shapes", () => {
    expect(azureAudio("AAA=")).toEqual({
      type: "input_audio_buffer.append",
      audio: "AAA=",
    });
    expect(azureUserText("Hi")).toEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hi" }],
      },
    });
    expect(azureToolOutput("c1", "ok")).toEqual({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "c1", output: "ok" },
    });
  });

  test("typed text asks for a response, canceling one being made", async () => {
    const { socket, wire } = fake();
    expect(wire.byMeter).toBe(false);
    wire.begin();
    wire.text("First");
    await wire.receive({ type: "response.created" });
    wire.text("Second");
    expect(socket.sent).toEqual([
      azureUserText("First"),
      { type: "response.create" },
      { type: "response.cancel" },
      azureUserText("Second"),
      { type: "response.create" },
    ]);
  });
});

describe("parseToolArguments", () => {
  test("reads JSON, empty as an empty object, and passes other text on", () => {
    expect(parseToolArguments('{"title":"Kindred"}')).toEqual({
      title: "Kindred",
    });
    expect(parseToolArguments("")).toEqual({});
    expect(parseToolArguments(undefined)).toEqual({});
    expect(parseToolArguments("{oops")).toBe("{oops");
  });
});

describe("events from Azure Voice Live", () => {
  test("session.updated means the call is on", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "session.updated" });
    expect(calls).toEqual([["connected"]]);
  });

  test("speech starting stops the voice, and ends a turn that was spoken", async () => {
    const { wire, calls, state } = fake();
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    expect(calls).toEqual([
      ["quiet"],
      ["heard", "", "utterance-1"],
      ["mark", { hearing: true, thinking: false }],
      ["active"],
    ]);
    calls.length = 0;
    state.said = "Dawn is";
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    expect(calls).toEqual([
      ["dropReply"],
      ["quiet"],
      ["endTurn"],
      ["heard", "", "utterance-2"],
      ["mark", { hearing: true, thinking: false }],
      ["active"],
    ]);
  });

  test("a reply the reader spoke over before hearing it does not end their turn", async () => {
    const { wire, calls, state } = fake();
    state.said = "Yep,";
    state.unheard = true;
    await wire.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "item_b",
    });
    expect(calls.map(([name]) => name)).toEqual([
      "dropReply",
      "quiet",
      "heard",
      "mark",
      "active",
    ]);
    expect(calls).toContainEqual(["heard", "", "item_b"]);
  });

  test("the end of a reply that was cut off, arriving after the next began, ends nothing", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "response.created", response: { id: "r1" } });
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    await wire.receive({ type: "response.created", response: { id: "r2" } });
    calls.length = 0;
    await wire.receive({
      type: "response.audio_transcript.delta",
      response_id: "r1",
      delta: "stale",
    });
    await wire.receive({
      type: "response.done",
      response: { id: "r1", status: "cancelled" },
    });
    expect(calls).toEqual([]);
    await wire.receive({
      type: "response.audio_transcript.delta",
      response_id: "r2",
      delta: "fresh",
    });
    await wire.receive({
      type: "response.done",
      response: { id: "r2", status: "completed" },
    });
    expect(calls).toEqual([["spoke", "fresh"], ["endTurn"]]);
  });

  test("the tool calls of a reply that was replaced are not the next reply's", async () => {
    const { socket, wire, calls } = fake();
    await wire.receive({ type: "response.created", response: { id: "r1" } });
    await wire.receive({
      type: "response.function_call_arguments.done",
      response_id: "r1",
      call_id: "c1",
      name: "search",
      arguments: "{}",
    });
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    await wire.receive({ type: "response.created", response: { id: "r2" } });
    await wire.receive({
      type: "response.done",
      response: { id: "r1", status: "cancelled" },
    });
    calls.length = 0;
    socket.sent.length = 0;
    await wire.receive({
      type: "response.audio_transcript.delta",
      response_id: "r2",
      delta: "Hello.",
    });
    await wire.receive({
      type: "response.done",
      response: { id: "r2", status: "completed" },
    });
    expect(calls).toEqual([["spoke", "Hello."], ["endTurn"]]);
    expect(socket.sent).toEqual([]);
  });

  test("a call in use is said to the relay, and to nobody else", () => {
    const { socket, wire } = fake();
    wire.alive();
    expect(socket.sent).toEqual([{ type: "call.active" }]);
  });

  test("a reader who pauses says one turn in two utterances, and neither replaces the other", async () => {
    const { wire, calls } = fake();
    const said = (item_id: string, transcript: string) =>
      wire.receive({
        type: "conversation.item.input_audio_transcription.completed",
        item_id,
        transcript,
      });
    await wire.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "item_a",
    });
    await wire.receive({ type: "response.created" });
    await said("item_a", "Tell me about the AI package.");
    // The reader goes on before the model has said anything.
    await wire.receive({
      type: "input_audio_buffer.speech_started",
      item_id: "item_b",
    });
    await wire.receive({
      type: "response.done",
      response: { status: "cancelled" },
    });
    await wire.receive({ type: "response.created" });
    await said("item_b", "How does that work?");
    const heard = calls.filter(([name]) => name === "heard");
    expect(heard).toEqual([
      ["heard", "", "item_a"],
      ["heard", "Tell me about the AI package.", "item_a", true],
      ["heard", "", "item_b"],
      ["heard", "How does that work?", "item_b", true],
    ]);
    // The reply that was cut off did not end the turn.
    expect(calls.some(([name]) => name === "endTurn")).toBe(false);
  });

  test("speech stopping waits for the model", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "input_audio_buffer.speech_stopped" });
    expect(calls).toEqual([["mark", { hearing: false, thinking: true }]]);
  });

  test("muting sends nothing: the silence that follows ends the reader's turn", () => {
    const { wire, socket } = fake();
    wire.pause();
    expect(socket.sent).toEqual([]);
  });

  test("the reader's words: deltas add, the completed text replaces its own utterance", async () => {
    const { wire, calls } = fake();
    await wire.receive({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Tell",
    });
    await wire.receive({
      type: "conversation.item.input_audio_transcription.delta",
    });
    await wire.receive({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Tell me",
    });
    expect(calls).toEqual([
      ["heard", "Tell", "utterance-0"],
      ["heard", "Tell me", "utterance-0", true],
    ]);
  });

  test("a second response in a turn is kept apart by a space", async () => {
    const { wire, calls, state } = fake();
    await wire.receive({ type: "response.created" });
    state.said = "Kindred.";
    await wire.receive({ type: "response.created" });
    state.said = "Kindred. ";
    await wire.receive({ type: "response.created" });
    expect(calls).toEqual([
      ["newResponse"],
      ["newResponse"],
      ["spoke", " "],
      ["newResponse"],
    ]);
  });

  test("audio, transcript and word times go to the call", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "response.audio.delta", delta: "A" });
    await wire.receive({
      type: "response.audio_transcript.delta",
      delta: "Dawn",
    });
    await wire.receive({
      type: "response.audio_timestamp.delta",
      text: "Dawn",
      audio_offset_ms: 250,
    });
    await wire.receive({ type: "response.audio_timestamp.delta", text: "is" });
    expect(calls).toEqual([
      ["play", "A"],
      ["spoke", "Dawn"],
      ["timedWord", "Dawn", 250],
      ["timedWord", "is", 0],
    ]);
  });

  test("tool results are sent when the response is done, then the model goes on", async () => {
    const { socket, wire, calls } = fake(async () => "in stock");
    await wire.receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "stock",
      arguments: '{"title":"Dawn"}',
    });
    expect(calls).toEqual([
      ["answerTool", { id: "c1", name: "stock", args: { title: "Dawn" } }],
    ]);
    await wire.receive({
      type: "response.done",
      response: { status: "completed" },
    });
    expect(socket.sent).toEqual([
      azureToolOutput("c1", "in stock"),
      { type: "response.create" },
    ]);
    expect(calls.at(-1)).toEqual(["mark", { thinking: true }]);
  });

  test("a call that has ended asks for nothing more after its tools", async () => {
    const { socket, wire, calls, state } = fake();
    await wire.receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "stock",
    });
    state.current = false;
    await wire.receive({ type: "response.done" });
    expect(socket.sent).toEqual([azureToolOutput("c1", "done")]);
    expect(calls.map(([name]) => name)).toEqual(["answerTool"]);
  });

  test("a response with no tools, or a canceled one, ends the turn", async () => {
    const plain = fake();
    await plain.wire.receive({ type: "response.done" });
    expect(plain.calls).toEqual([["endTurn"]]);

    const canceled = fake();
    await canceled.wire.receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "stock",
    });
    await canceled.wire.receive({
      type: "response.done",
      response: { status: "cancelled" },
    });
    expect(canceled.calls.at(-1)).toEqual(["endTurn"]);
    // A canceled response's tools are not waited for.
    await canceled.wire.receive({ type: "response.done" });
    expect(canceled.calls.at(-1)).toEqual(["endTurn"]);
  });

  test("a reply the reader cut in on plays, shows and does nothing more", async () => {
    const { wire, calls, socket } = fake();
    await wire.receive({ type: "response.created" });
    await wire.receive({ type: "response.audio.delta", delta: "AAA=" });
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    calls.length = 0;
    // What was already on its way when the reader spoke.
    await wire.receive({ type: "response.audio.delta", delta: "BBB=" });
    await wire.receive({ type: "response.audio_transcript.delta", delta: "x" });
    await wire.receive({
      type: "response.audio_timestamp.delta",
      text: "x",
      audio_offset_ms: 900,
    });
    await wire.receive({
      type: "response.function_call_arguments.done",
      call_id: "c1",
      name: "place_hold",
    });
    await wire.receive({
      type: "response.done",
      response: { status: "cancelled" },
    });
    // Nothing of it reached the call, and its end did not end the reader's turn.
    expect(calls).toEqual([]);
    expect(socket.sent).toEqual([]);

    // The reply to what the reader said is played as any other.
    await wire.receive({ type: "response.created" });
    await wire.receive({ type: "response.audio.delta", delta: "CCC=" });
    await wire.receive({ type: "response.done" });
    expect(calls.map(([name]) => name)).toEqual([
      "newResponse",
      "play",
      "endTurn",
    ]);
  });

  test("a reply that had finished before the reader spoke is not cut", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "response.created" });
    await wire.receive({ type: "response.done" });
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    calls.length = 0;
    await wire.receive({ type: "response.created" });
    await wire.receive({ type: "response.audio.delta", delta: "AAA=" });
    expect(calls.map(([name]) => name)).toEqual(["newResponse", "play"]);
  });

  test("a typed message replaces the reply being made, and keeps its own turn", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "response.created" });
    wire.text("Something else");
    calls.length = 0;
    await wire.receive({ type: "response.audio.delta", delta: "AAA=" });
    await wire.receive({
      type: "response.done",
      response: { status: "cancelled" },
    });
    // The canceled reply's end is not the end of the typed message's turn.
    expect(calls).toEqual([]);
    await wire.receive({ type: "response.created" });
    await wire.receive({
      type: "response.audio_transcript.delta",
      delta: "Sure.",
    });
    await wire.receive({ type: "response.done" });
    expect(calls.map(([name]) => name)).toEqual([
      "newResponse",
      "spoke",
      "endTurn",
    ]);
  });
});
