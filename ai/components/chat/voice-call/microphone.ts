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
): Promise<AudioWorkletNode | null> {
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  // The call ended while the browser was asking: nothing may keep the microphone.
  if (!isLive()) {
    microphone.getTracks().forEach((track) => track.stop());
    return null;
  }
  // Asking for 16 kHz here means the browser resamples, not this script.
  const capture = new AudioContext({ sampleRate: 16_000 });
  current.microphone = microphone;
  current.capture = capture;
  await capture.audioWorklet.addModule(
    URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })),
  );
  if (!isLive()) return null;
  const node = new AudioWorkletNode(capture, "mic");
  capture.createMediaStreamSource(microphone).connect(node);
  return node;
}

/** Let go of everything a call holds: its socket, audio and microphone. */
export function closeCall(ending: Call): void {
  for (const decide of ending.waiting.values()) decide("deny");
  ending.socket.close();
  for (const source of ending.sources) source.stop();
  ending.microphone?.getTracks().forEach((track) => track.stop());
  void ending.capture?.close();
  void ending.playback.close();
}
