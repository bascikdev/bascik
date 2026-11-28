/*
 * Sound for voice-call as numbers: the model's 24 kHz audio decoded to
 * samples, the microphone's samples encoded for the provider, and the level
 * math that tells when the reader is speaking and draws the meter.
 */

/** Above this the reader counts as speaking; below the lower one, as quiet. */
export const SPEECH_ON = 0.15;
export const SPEECH_OFF = 0.08;
/** How long it must stay quiet before speech is over, in milliseconds. */
export const QUIET_FOR = 500;
/** The meter's bars, tallest in the middle. */
export const BAR_SHAPE: readonly number[] = [0.55, 0.8, 1, 0.8, 0.55];
/** Microphone samples per message: a tenth of a second at 16 kHz. */
export const CHUNK = 1600;

/**
 * How many chunks of silence follow the reader's last sound when they mute.
 * A provider ends the reader's turn only after a pause as long as the one
 * it was set up with, so the silence outlasts the longest pause there is
 * (`pauseMs` is at most 3000): 3.2 seconds.
 */
export const MUTE_TAIL = 32;

/** An audio worklet that hands each block of microphone samples to the page. */
export const WORKLET = `registerProcessor("mic", class extends AudioWorkletProcessor {
      process(inputs) {
        const channel = inputs[0][0];
        if (channel) this.port.postMessage(channel.slice(0));
        return true;
      }
    });`;

/** 16-bit little-endian PCM, base64, as samples from -1 to 1. */
export function decodePcm16(base64: string): Float32Array {
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0),
  );
  const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const channel = new Float32Array(samples.length);
  for (let at = 0; at < samples.length; at++) {
    channel[at] = samples[at]! / 32_768;
  }
  return channel;
}

/** Samples already scaled to 16-bit, as 16-bit PCM in base64. */
export function encodePcm16(samples: readonly number[]): string {
  const bytes = new Uint8Array(Int16Array.from(samples).buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Collects microphone blocks until there is a chunk to send. `add` keeps a
 * block's samples and gives its level (root mean square); `take` gives the
 * chunk once there is enough of it, and null before.
 */
export function pcmChunker(size = CHUNK): {
  add(data: Float32Array): number;
  take(): string | null;
  /** Forget what has not been taken. */
  reset(): void;
} {
  let pending: number[] = [];
  return {
    add(data) {
      let squares = 0;
      for (const sample of data) {
        squares += sample * sample;
        pending.push(Math.max(-1, Math.min(1, sample)) * 32_767);
      }
      return Math.sqrt(squares / (data.length || 1));
    },
    take() {
      if (pending.length < size) return null;
      const chunk = encodePcm16(pending);
      pending = [];
      return chunk;
    },
    reset() {
      pending = [];
    },
  };
}

/** One chunk of silence, as the provider is sent it. */
export const silentChunk = (size = CHUNK): string =>
  encodePcm16(new Array<number>(size).fill(0));

/** The microphone's level, and whether it counts as speech. */
export interface Speech {
  level: number;
  speaking: boolean;
  /** When the level last fell quiet, while still counted as speech. */
  quietAt: number;
}

/**
 * One block of microphone sound: smooth the level, and tell when speech
 * starts and ends. `now` is in milliseconds. Changes `speech` in place.
 */
export function measureSpeech(speech: Speech, rms: number, now: number): void {
  // A voice is far quieter than a full-scale tone: this puts speech near the top.
  const target = Math.min(1, rms * 8);
  speech.level +=
    (target - speech.level) * (target > speech.level ? 0.5 : 0.06);
  if (!speech.speaking && speech.level > SPEECH_ON) {
    speech.speaking = true;
    speech.quietAt = 0;
  } else if (speech.speaking && speech.level < SPEECH_OFF) {
    speech.quietAt ||= now;
    if (now - speech.quietAt > QUIET_FOR) speech.speaking = false;
  } else if (speech.speaking) {
    speech.quietAt = 0;
  }
}

/** The CSS transform of the meter's bar at `at`, for a level of 0 to 1. */
export const barTransform = (level: number, at: number): string =>
  `scaleY(${Math.max(0.12, level * BAR_SHAPE[at]!).toFixed(2)})`;

/** True while the model's voice is playing, when the microphone hears it back. */
export const isPlaying = (current: {
  playback: { currentTime: number };
  nextAt: number;
}): boolean => current.playback.currentTime < current.nextAt;
