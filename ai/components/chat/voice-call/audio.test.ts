import { describe, expect, test } from "vitest";
import {
  QUIET_FOR,
  barTransform,
  decodePcm16,
  encodePcm16,
  isPlaying,
  measureSpeech,
  pcmChunker,
} from "./audio.ts";

describe("PCM", () => {
  test("decodes 16-bit little-endian samples to -1..1", () => {
    // 0, 16384, -32768 as little-endian bytes.
    const base64 = btoa(String.fromCharCode(0, 0, 0, 0x40, 0, 0x80));
    expect([...decodePcm16(base64)]).toEqual([0, 0.5, -1]);
  });

  test("drops a trailing odd byte", () => {
    expect(decodePcm16(btoa(String.fromCharCode(0, 0x40, 7)))).toHaveLength(1);
  });

  test("encodes scaled samples, and decodes back to them", () => {
    const encoded = encodePcm16([0, 16_384, -32_768]);
    expect([...decodePcm16(encoded)]).toEqual([0, 0.5, -1]);
  });
});

describe("pcmChunker", () => {
  test("gives a block's level, and a chunk once there is enough", () => {
    const chunker = pcmChunker(4);
    expect(chunker.add(new Float32Array([0.5, -0.5]))).toBe(0.5);
    expect(chunker.take()).toBeNull();
    chunker.add(new Float32Array([0, 0]));
    const chunk = chunker.take();
    expect(chunk).not.toBeNull();
    expect(decodePcm16(chunk!)).toHaveLength(4);
    expect(chunker.take()).toBeNull();
  });

  test("clips samples past full scale, and counts an empty block as silent", () => {
    const chunker = pcmChunker(1);
    expect(chunker.add(new Float32Array([]))).toBe(0);
    chunker.add(new Float32Array([2]));
    expect(decodePcm16(chunker.take()!)[0]).toBeCloseTo(32_767 / 32_768);
  });
});

describe("measureSpeech", () => {
  const quiet = () => ({ level: 0, speaking: false, quietAt: 0 });

  test("rises fast, so speech starts at once", () => {
    const speech = quiet();
    measureSpeech(speech, 0.1, 0);
    expect(speech.level).toBeCloseTo(0.4);
    expect(speech.speaking).toBe(true);
  });

  test("falls slowly, and ends speech only after a quiet spell", () => {
    const speech = { level: 0.05, speaking: true, quietAt: 0 };
    measureSpeech(speech, 0, 1_000);
    expect(speech.level).toBeCloseTo(0.047);
    expect(speech.quietAt).toBe(1_000);
    measureSpeech(speech, 0, 1_000 + QUIET_FOR);
    expect(speech.speaking).toBe(true);
    measureSpeech(speech, 0, 1_001 + QUIET_FOR);
    expect(speech.speaking).toBe(false);
  });

  test("a loud block in a quiet spell starts the spell again", () => {
    const speech = { level: 0.1, speaking: true, quietAt: 500 };
    measureSpeech(speech, 0.02, 600);
    expect(speech.quietAt).toBe(0);
  });
});

describe("the meter and playback", () => {
  test("draws each bar to its shape, never flat", () => {
    expect(barTransform(0, 0)).toBe("scaleY(0.12)");
    expect(barTransform(1, 2)).toBe("scaleY(1.00)");
    expect(barTransform(1, 0)).toBe("scaleY(0.55)");
  });

  test("is playing while queued audio is ahead of the clock", () => {
    expect(isPlaying({ playback: { currentTime: 1 }, nextAt: 2 })).toBe(true);
    expect(isPlaying({ playback: { currentTime: 2 }, nextAt: 2 })).toBe(false);
  });
});
