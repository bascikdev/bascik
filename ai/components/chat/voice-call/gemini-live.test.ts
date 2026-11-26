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
  const state = { said: "", reply: false };
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
      ["heard", "Tell me about Dawn"],
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

  test("a turn that only called tools is not over", async () => {
    const { socket, hooks, calls, state } = fake();
    state.reply = true;
    state.said = "  ";
    await geminiLive({ socket }, {}, hooks).receive({
      serverContent: { turnComplete: true },
    });
    expect(calls).toEqual([]);
  });

  test("a message with nothing known in it does nothing", async () => {
    const { socket, hooks, calls } = fake();
    await geminiLive({ socket }, {}, hooks).receive({ usageMetadata: {} });
    expect(calls).toEqual([]);
    expect(socket.sent).toEqual([]);
  });
});
