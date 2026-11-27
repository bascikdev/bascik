import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeCall, dropMicrophone, openMicrophone } from "./microphone.ts";
import type { Call } from "./types.ts";

/** A microphone track that remembers whether it was stopped. */
class FakeTrack extends EventTarget {
  readyState = "live";
  stop(): void {
    this.readyState = "ended";
  }
}

/** What a browser gives for a microphone, and for capturing it. */
function fakeBrowser(
  fail: { context?: boolean; module?: boolean; source?: boolean } = {},
) {
  const track = new FakeTrack();
  const contexts: { closed: boolean; sampleRate: number }[] = [];
  class FakeContext {
    closed = false;
    sampleRate: number;
    audioWorklet = {
      addModule: async (): Promise<void> => {
        if (fail.module) throw new Error("A page that may not load a worklet.");
      },
    };
    constructor(options: { sampleRate: number }) {
      if (fail.context) throw new Error("A rate this browser refuses.");
      this.sampleRate = options.sampleRate;
      contexts.push(this);
    }
    createMediaStreamSource() {
      if (fail.source) throw new Error("A stream that cannot be captured.");
      return { connect: () => {} };
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  const revoked: string[] = [];
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [track] }),
    },
  });
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = {};
    },
  );
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:worklet",
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  return { track, contexts, revoked };
}

const newCall = (): Call =>
  ({ waiting: new Map(), sources: new Set() }) as unknown as Call;

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("openMicrophone", () => {
  test("captures the microphone at 16 kHz, and the call holds both", async () => {
    const { track, contexts, revoked } = fakeBrowser();
    const call = newCall();
    const node = await openMicrophone(call, () => true);
    expect(node).not.toBeNull();
    expect(contexts).toEqual([expect.objectContaining({ sampleRate: 16_000 })]);
    expect(call.microphone?.getTracks()).toEqual([track]);
    expect(call.capture).toBe(contexts[0]);
    expect(track.readyState).toBe("live");
    // The worklet's address is not kept once it is loaded.
    expect(revoked).toEqual(["blob:worklet"]);
  });

  test("lets go at once of a microphone that came after the call ended", async () => {
    const { track, contexts } = fakeBrowser();
    const call = newCall();
    expect(await openMicrophone(call, () => false)).toBeNull();
    expect(track.readyState).toBe("ended");
    expect(contexts).toEqual([]);
    expect(call.microphone).toBeUndefined();
  });

  test.each([
    ["the capture context cannot be made", { context: true }],
    ["the worklet cannot be loaded", { module: true }],
    ["the stream cannot be captured", { source: true }],
  ])("does not keep recording when %s", async (_name, fail) => {
    const { track, contexts, revoked } = fakeBrowser(fail);
    const call = newCall();
    await expect(openMicrophone(call, () => true)).rejects.toThrow();
    // The browser's recording light goes out, and nothing is left to close later.
    expect(track.readyState).toBe("ended");
    expect(contexts.every((context) => context.closed)).toBe(true);
    expect(call.microphone).toBeUndefined();
    expect(call.capture).toBeUndefined();
    expect(revoked).toEqual(["blob:worklet"]);
  });

  test("a call that ends while the worklet loads holds a microphone that ending it lets go", async () => {
    const { track, contexts } = fakeBrowser();
    const call = newCall();
    // The reader hangs up after the microphone was given, before capture began:
    // the call is live at the first look, and over at the second.
    let looks = 0;
    expect(await openMicrophone(call, () => ++looks === 1)).toBeNull();
    dropMicrophone(call);
    expect(track.readyState).toBe("ended");
    expect(contexts[0]!.closed).toBe(true);
  });

  test("says so when the microphone goes away by itself, once", async () => {
    const { track, contexts } = fakeBrowser();
    const call = newCall();
    const lost = vi.fn();
    await openMicrophone(call, () => true, lost);
    // A headset is unplugged: the browser ends the track.
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    expect(lost).toHaveBeenCalledTimes(1);
    expect(contexts[0]!.closed).toBe(true);
    expect(call.microphone).toBeUndefined();
    track.dispatchEvent(new Event("ended"));
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe("closeCall", () => {
  test("denies what waits, and lets go of the socket, the sound and the microphone", async () => {
    const { track, contexts } = fakeBrowser();
    const call = newCall();
    await openMicrophone(call, () => true);
    const decided: string[] = [];
    call.waiting.set("c1", (decision) => decided.push(decision));
    const stopped: string[] = [];
    call.sources.add({ stop: () => stopped.push("source") } as never);
    let socketClosed = false;
    let playbackClosed = false;
    call.socket = { close: () => (socketClosed = true) } as never;
    call.playback = {
      close: async () => {
        playbackClosed = true;
      },
    } as never;
    closeCall(call);
    expect(decided).toEqual(["deny"]);
    expect(socketClosed).toBe(true);
    expect(stopped).toEqual(["source"]);
    expect(playbackClosed).toBe(true);
    expect(track.readyState).toBe("ended");
    expect(contexts[0]!.closed).toBe(true);
  });
});
