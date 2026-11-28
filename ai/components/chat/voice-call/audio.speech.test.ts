/*
 * The level detector against sound, not hand-picked numbers: the lab's
 * speech-like signal and its noise (voice-lab/signal.ts) go through the
 * same chunker and `measureSpeech` the component uses, in the blocks an
 * audio worklet hands over.
 */
import { describe, expect, test } from "vitest";
import {
  join,
  mix,
  noise,
  silence,
  speechLike,
} from "../../../voice-lab/signal.ts";
import { decodePcm16, measureSpeech, pcmChunker } from "./audio.ts";
import type { Speech } from "./audio.ts";

const RATE = 16_000;
/** An audio worklet's block. */
const BLOCK = 128;

/** Run sound through the detector. Gives when it counted as speech, in seconds. */
function detect(samples: Float32Array): {
  spoke: { from: number; to: number }[];
  sent: Float32Array;
} {
  const speech: Speech = { level: 0, speaking: false, quietAt: 0 };
  const chunks = pcmChunker();
  const spoke: { from: number; to: number }[] = [];
  const sent: number[] = [];
  for (let at = 0; at + BLOCK <= samples.length; at += BLOCK) {
    const was = speech.speaking;
    measureSpeech(
      speech,
      chunks.add(samples.subarray(at, at + BLOCK)),
      (at / RATE) * 1000,
    );
    if (speech.speaking && !was) spoke.push({ from: at / RATE, to: Infinity });
    if (!speech.speaking && was) spoke.at(-1)!.to = at / RATE;
    const chunk = chunks.take();
    if (chunk !== null) sent.push(...decodePcm16(chunk));
  }
  return { spoke, sent: Float32Array.from(sent) };
}

describe("the level detector, on sound", () => {
  test("hears a sentence as one stretch of speech, pauses between words included", () => {
    const { spoke } = detect(
      join(silence(1, RATE), speechLike(3, RATE), silence(2, RATE)),
    );
    expect(spoke).toHaveLength(1);
    // It notices within a fifth of a second, and lets go about half a second after the end.
    expect(spoke[0]!.from).toBeGreaterThan(1);
    expect(spoke[0]!.from).toBeLessThan(1.2);
    expect(spoke[0]!.to).toBeGreaterThan(4);
    expect(spoke[0]!.to).toBeLessThan(5.2);
  });

  test("does not take a quiet room, or a noisy one, for speech", () => {
    expect(detect(silence(3, RATE)).spoke).toEqual([]);
    // A fan, a street through a window: well under a voice at the microphone.
    expect(detect(noise(5, RATE, 0.01)).spoke).toEqual([]);
  });

  test("hears a sentence over room noise, and only the sentence", () => {
    const room = noise(6, RATE, 0.008);
    const { spoke } = detect(
      mix(room, join(silence(2, RATE), speechLike(2, RATE))),
    );
    expect(spoke).toHaveLength(1);
    expect(spoke[0]!.from).toBeGreaterThan(2);
    expect(spoke[0]!.from).toBeLessThan(2.2);
    expect(spoke[0]!.to).toBeLessThan(5.2);
  });

  test("hears a quiet voice, and a single short word", () => {
    // Far from the microphone: a fifth of the usual level.
    expect(detect(speechLike(2, RATE, { peak: 0.1 })).spoke).toHaveLength(1);
    // "Yes."
    expect(
      detect(join(silence(0.5, RATE), speechLike(0.35, RATE), silence(1, RATE)))
        .spoke,
    ).toHaveLength(1);
  });

  test("sends every sample it was given, in order, whatever the block size", () => {
    const voice = speechLike(1, RATE);
    const { sent } = detect(voice);
    // What is left over is less than one piece; the rest is the voice itself.
    expect(voice.length - sent.length).toBeLessThan(1600 + BLOCK);
    for (let at = 0; at < sent.length; at += 53) {
      expect(Math.abs(sent[at]! - voice[at]!)).toBeLessThan(1 / 16_000);
    }
  });

  test("clips a sound that is too loud rather than wrapping it", () => {
    const loud = speechLike(0.5, RATE).map((sample) => sample * 4);
    const { sent } = detect(loud);
    for (let at = 0; at < sent.length; at++) {
      // A wrapped sample changes sign: a clipped one keeps it.
      if (Math.abs(loud[at]!) > 1) {
        expect(Math.sign(sent[at]!)).toBe(Math.sign(loud[at]!));
      }
    }
  });
});
