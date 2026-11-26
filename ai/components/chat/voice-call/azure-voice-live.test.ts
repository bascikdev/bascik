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
  const state = { said: "", current: true };
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
      ["mark", { hearing: true, thinking: false }],
    ]);
    calls.length = 0;
    state.said = "Dawn is";
    await wire.receive({ type: "input_audio_buffer.speech_started" });
    expect(calls).toEqual([
      ["quiet"],
      ["endTurn"],
      ["mark", { hearing: true, thinking: false }],
    ]);
  });

  test("speech stopping waits for the model", async () => {
    const { wire, calls } = fake();
    await wire.receive({ type: "input_audio_buffer.speech_stopped" });
    expect(calls).toEqual([["mark", { hearing: false, thinking: true }]]);
  });

  test("the reader's words: deltas add, the completed text replaces", async () => {
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
      ["heard", "Tell"],
      ["heard", "Tell me", true],
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
});
