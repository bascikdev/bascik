/*
 * The microphone for a voice call: asked for once the call is on, captured
 * at 16 kHz by an audio worklet, and handed over in blocks. Whatever is
 * opened for a call that has ended in the meantime is let go at once.
 */

import { WORKLET } from "./audio.ts";
import type { Call } from "./types.ts";

/**
 * Open the microphone for `current`, and start capturing it. Gives the
 * worklet node whose port sends each block of samples, or null when the
 * call ended while the browser was asking (`isLive` says it still is on).
 * Throws when the reader declines.
 */
export async function openMicrophone(
  current: Call,
  isLive: () => boolean,
  onLost: () => void = () => {},
): Promise<AudioWorkletNode | null> {
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  // The call ended while the browser was asking: nothing may keep the microphone.
  if (!isLive()) {
    microphone.getTracks().forEach((track) => track.stop());
    return null;
  }
  // The call holds it from here, so ending the call lets it go whatever happens next.
  current.microphone = microphone;
  const worklet = URL.createObjectURL(
    new Blob([WORKLET], { type: "text/javascript" }),
  );
  try {
    // Asking for 16 kHz here means the browser resamples, not this script.
    const capture = new AudioContext({ sampleRate: 16_000 });
    current.capture = capture;
    await capture.audioWorklet.addModule(worklet);
    if (!isLive()) return null;
    const node = new AudioWorkletNode(capture, "mic");
    capture.createMediaStreamSource(microphone).connect(node);
    // A headset unplugged, or permission taken back: the track ends by itself.
    for (const track of microphone.getTracks()) {
      track.addEventListener("ended", () => {
        if (current.microphone !== microphone) return;
        dropMicrophone(current);
        onLost();
      });
    }
    return node;
  } catch (error) {
    // A browser that cannot capture (no worklet, a rate it refuses) must not
    // be left recording: the reader is told there is no microphone.
    dropMicrophone(current);
    throw error;
  } finally {
    URL.revokeObjectURL(worklet);
  }
}

/** Let go of a call's microphone and what captures it; the call goes on. */
export function dropMicrophone(current: Call): void {
  current.microphone?.getTracks().forEach((track) => track.stop());
  void current.capture?.close().catch(() => {});
  current.microphone = undefined;
  current.capture = undefined;
}

/** Let go of everything a call holds: its socket, audio and microphone. */
export function closeCall(ending: Call): void {
  for (const decide of ending.waiting.values()) decide("deny");
  ending.socket.close();
  for (const source of ending.sources) source.stop();
  dropMicrophone(ending);
  void ending.playback.close().catch(() => {});
}
