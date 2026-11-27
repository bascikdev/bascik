import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, onTestFinished, test } from "vitest";
import { acceptWebSocket } from "../src/ws.ts";
import {
  kindOf,
  readCassette,
  recordSession,
  scrub,
  serveCassette,
  typedIn,
  voiceSeconds,
  writeCassette,
} from "./cassette.ts";
import type { Cassette } from "./cassette.ts";

const AUDIO = Buffer.alloc(4800, 7).toString("base64"); // a tenth of a second at 24 kHz
const MICROPHONE = Buffer.alloc(3200, 3).toString("base64");

/** A provider that speaks a little of the Gemini Live protocol, in binary frames. */
async function provider(): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    socket.on("error", () => {});
    asked.push(request.url ?? "");
    const client = acceptWebSocket(request, socket)!;
    const send = (message: unknown): void =>
      client.send(JSON.stringify(message), true);
    client.onMessage = (text) => {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.setup) {
        send({ setupComplete: { sessionId: "sess-123" } });
      } else if (message.clientContent) {
        send({
          serverContent: { outputTranscription: { text: "Hello there." } },
        });
        setTimeout(() => {
          send({
            serverContent: {
              modelTurn: { parts: [{ inlineData: { data: AUDIO } }] },
            },
          });
          send({ serverContent: { turnComplete: true } });
        }, 120);
      } else if (message.bye) {
        client.close(1000, "Goodbye.");
      }
    };
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
  };
}

/** A browser's side of a session: what it received, and how it ended. */
function browser(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const got: { at: number; message: Record<string, unknown> }[] = [];
  const waiting: (() => void)[] = [];
  socket.onmessage = (event) => {
    const text =
      typeof event.data === "string"
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer);
    got.push({ at: Date.now(), message: JSON.parse(text) });
    for (const wake of waiting.splice(0)) wake();
  };
  const opened = new Promise<void>(
    (resolve) => (socket.onopen = () => resolve()),
  );
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => {
      for (const wake of waiting.splice(0)) wake();
      resolve({ code: event.code, reason: event.reason });
    };
  });
  onTestFinished(async () => {
    socket.close();
    await closed;
  });
  return {
    got,
    opened,
    closed,
    send: (message: unknown): void => socket.send(JSON.stringify(message)),
    close: (): void => socket.close(),
    /** Wait until `count` messages have come. */
    async until(count: number): Promise<void> {
      while (got.length < count && socket.readyState <= WebSocket.OPEN) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    },
  };
}

/** One session against the real provider, through the recorder. */
async function record(): Promise<Cassette> {
  const real = await provider();
  const recording = await recordSession({
    upstream: real.url,
    provider: "gemini-live",
    note: "A greeting.",
  });
  onTestFinished(() => recording.close());
  const page = browser(
    `${recording.url}/ws/live?access_token=auth_tokens/abc123`,
  );
  await page.opened;
  page.send({ setup: { model: "m", apiKey: "sk-live-1" } });
  await page.until(1);
  page.send({
    realtimeInput: {
      audio: { data: MICROPHONE, mimeType: "audio/pcm;rate=16000" },
    },
  });
  page.send({
    clientContent: {
      turns: [{ role: "user", parts: [{ text: "Say hello" }] }],
      turnComplete: true,
    },
  });
  await page.until(4);
  page.send({ bye: true });
  expect(await page.closed).toEqual({ code: 1000, reason: "Goodbye." });
  // The provider was asked for the path and query the browser asked for.
  expect(real.asked).toEqual(["/ws/live?access_token=auth_tokens/abc123"]);
  return recording.cassette();
}

describe("recording", () => {
  test("keeps every message of a session, in order, from both sides", async () => {
    const cassette = await record();
    expect(
      cassette.frames.map((frame) => `${frame.from}:${kindOf(frame.data)}`),
    ).toEqual([
      "browser:setup",
      "provider:setupComplete",
      "browser:audio",
      "browser:clientContent",
      "provider:serverContent",
      "provider:serverContent",
      "provider:serverContent",
      "browser:bye",
      "provider:$closed",
    ]);
    // Times only go up, and the provider's pause before it spoke is in them.
    const times = cassette.frames.map((frame) => frame.at);
    expect([...times].sort((first, second) => first - second)).toEqual(times);
    expect(cassette.frames[5]!.at - cassette.frames[4]!.at).toBeGreaterThan(80);
  });

  test("keeps no secret and nobody's voice but the model's", async () => {
    const text = writeCassette(await record());
    expect(text).not.toContain("sk-live-1");
    expect(text).not.toContain("sess-123");
    expect(text).not.toContain(MICROPHONE);
    expect(
      readCassette(text).frames.some((frame) =>
        frame.data.includes('"$audio":3200'),
      ),
    ).toBe(true);
    // The model's voice is what a test plays: it is kept whole.
    expect(text).toContain(AUDIO);
    expect(voiceSeconds(readCassette(text))).toBeCloseTo(0.1, 5);
  });

  test("survives being written and read", async () => {
    const cassette = await record();
    expect(readCassette(writeCassette(cassette))).toEqual(cassette);
    expect(() => readCassette('{"not":"one"}\n')).toThrow("Not a cassette.");
    expect(typedIn(cassette)).toEqual(["Say hello"]);
  });
});

describe("scrub", () => {
  test("removes credentials by name and by shape, wherever they are", () => {
    const scrubbed = scrub(
      JSON.stringify({
        session: {
          id: "kept",
          session_id: "s1",
          client_secret: { value: "x" },
        },
        headers: [{ Authorization: "Bearer abc.def" }],
        note: "use auth_tokens/zzz999 or eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
        text: "the reader said: my key is fine",
      }),
      "provider",
    );
    expect(scrubbed).not.toMatch(/s1"|abc\.def|zzz999|eyJhbGci/);
    expect(JSON.parse(scrubbed)).toMatchObject({
      session: { id: "kept", session_id: "[removed]" },
      text: "the reader said: my key is fine",
    });
  });

  test("keeps the provider's audio, and replaces the browser's by its size", () => {
    const delta = JSON.stringify({
      type: "response.audio.delta",
      delta: AUDIO,
    });
    expect(scrub(delta, "provider")).toBe(delta);
    expect(
      JSON.parse(
        scrub(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: MICROPHONE,
          }),
          "browser",
        ),
      ),
    ).toEqual({ type: "input_audio_buffer.append", audio: { $audio: 3200 } });
  });

  test("keeps text that is not JSON, without a credential in it", () => {
    expect(scrub("hello Bearer abc123", "provider")).toBe("hello [removed]");
  });
});

describe("kindOf", () => {
  test.each([
    [{ setup: {} }, "setup"],
    [{ realtimeInput: { audio: {} } }, "audio"],
    [{ toolResponse: {} }, "toolResponse"],
    [{ type: "input_audio_buffer.append" }, "audio"],
    [{ type: "response.create" }, "response.create"],
    [
      { type: "conversation.item.create", item: { type: "message" } },
      "conversation.item.create:message",
    ],
    [
      {
        type: "conversation.item.create",
        item: { type: "function_call_output" },
      },
      "conversation.item.create:function_call_output",
    ],
  ])("%j is %s", (message, kind) => {
    expect(kindOf(JSON.stringify(message))).toBe(kind);
  });

  test("text that is not a message is text", () => {
    expect(kindOf("not json")).toBe("text");
    expect(kindOf("7")).toBe("text");
  });
});

describe("playing", () => {
  test("gives a browser what the provider gave, with its pauses, and waits for the browser's part", async () => {
    const cassette = await record();
    const player = await serveCassette(cassette);
    onTestFinished(() => player.close());
    const page = browser(player.url);
    await page.opened;
    // Nothing is said before the browser's setup, as in the recording.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(page.got).toEqual([]);
    page.send({ setup: {} });
    await page.until(1);
    expect(page.got[0]!.message).toEqual({
      setupComplete: { sessionId: "[removed]" },
    });
    // Sound from the microphone is not waited for, and does not stand in for a typed message.
    page.send({ realtimeInput: { audio: { data: MICROPHONE } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(page.got).toHaveLength(1);
    page.send({ clientContent: { turns: [] } });
    await page.until(4);
    expect(page.got.slice(1).map((entry) => entry.message)).toEqual(
      cassette.frames
        .filter(
          (frame) =>
            frame.from === "provider" && kindOf(frame.data) === "serverContent",
        )
        .map((frame) => JSON.parse(frame.data)),
    );
    // The pause before the voice is the recorded one.
    expect(page.got[2]!.at - page.got[1]!.at).toBeGreaterThan(80);
    page.send({ bye: true });
    // And it ends as the session ended.
    expect(await page.closed).toEqual({ code: 1000, reason: "Goodbye." });
    await expect.poll(() => player.played()).toBe(1);
  });

  test("plays faster when asked, and cuts a long pause short", async () => {
    const cassette: Cassette = {
      provider: "azure-voice-live",
      note: "",
      frames: [
        { at: 0, from: "provider", data: '{"type":"session.created"}' },
        { at: 60_000, from: "provider", data: '{"type":"session.updated"}' },
      ],
    };
    const player = await serveCassette(cassette, {
      speed: 10,
      longestGap: 500,
    });
    onTestFinished(() => player.close());
    const page = browser(player.url);
    const started = Date.now();
    await page.until(2);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(page.got.map((entry) => entry.message.type)).toEqual([
      "session.created",
      "session.updated",
    ]);
  });

  test("stops when the browser leaves, in a pause or in a wait", async () => {
    const waits: Cassette = {
      provider: "azure-voice-live",
      note: "",
      frames: [
        { at: 0, from: "provider", data: '{"type":"session.created"}' },
        { at: 10, from: "browser", data: '{"type":"response.create"}' },
        { at: 20, from: "provider", data: '{"type":"response.created"}' },
      ],
    };
    const player = await serveCassette(waits);
    onTestFinished(() => player.close());
    const page = browser(player.url);
    await page.until(1);
    page.close();
    await page.closed;
    // The session was not played to its end, and nothing is left running.
    expect(player.played()).toBe(0);
    await player.close();
  });
});
