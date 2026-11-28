import { describe, expect, test } from "vitest";
import {
  correlation,
  findSignal,
  fromPcm16,
  fromWav,
  join,
  largestJump,
  mix,
  noise,
  percentile,
  resample,
  rms,
  silence,
  soundStretches,
  speechLike,
  toPcm16,
  toWav,
} from "./signal.ts";

const RATE = 16_000;

describe("speechLike", () => {
  test("gives the same samples for the same arguments", () => {
    expect(speechLike(1, RATE)).toEqual(speechLike(1, RATE));
  });

  test("differs by voice", () => {
    const first = speechLike(1, RATE, { pitch: 110 });
    const second = speechLike(1, RATE, { pitch: 210, rate: 5 });
    expect(Math.abs(correlation(first, second))).toBeLessThan(0.3);
  });

  test("has the level and the pauses of speech", () => {
    const voice = speechLike(3, RATE);
    expect(voice.length).toBe(3 * RATE);
    const level = rms(voice);
    // Loud enough for the call's meter to count as speaking, and not clipped.
    expect(level).toBeGreaterThan(0.05);
    expect(Math.max(...voice.map(Math.abs))).toBeLessThanOrEqual(0.5);
    // Words with gaps between them, joined into one stretch of speech.
    expect(soundStretches(voice, RATE, 0.003, 0.2)).toHaveLength(1);
    expect(soundStretches(voice, RATE, 0.003, 0.01).length).toBeGreaterThan(2);
  });

  test("starts and ends without a click", () => {
    const voice = speechLike(1, RATE);
    expect(Math.abs(voice[0]!)).toBeLessThan(0.001);
    expect(Math.abs(voice.at(-1)!)).toBeLessThan(0.001);
  });
});

describe("PCM and WAV", () => {
  test("PCM16 survives a round trip to within one step", () => {
    const voice = speechLike(0.5, RATE);
    const back = fromPcm16(toPcm16(voice));
    expect(back.length).toBe(voice.length);
    for (let at = 0; at < voice.length; at += 97) {
      expect(Math.abs(back[at]! - voice[at]!)).toBeLessThan(1 / 16_000);
    }
  });

  test("clips what is out of range rather than wrapping it", () => {
    const loud = Float32Array.of(2, -2, 1, -1);
    expect(
      [...fromPcm16(toPcm16(loud))].map((sample) => Math.sign(sample)),
    ).toEqual([1, -1, 1, -1]);
  });

  test("leaves an odd last byte out", () => {
    expect(fromPcm16(Uint8Array.of(0, 64, 7))).toHaveLength(1);
  });

  test("a WAV file survives a round trip, rate included", () => {
    const voice = speechLike(0.25, 24_000);
    const { samples, sampleRate } = fromWav(toWav(voice, 24_000));
    expect(sampleRate).toBe(24_000);
    expect(correlation(samples, voice)).toBeGreaterThan(0.9999);
  });

  test("reads the first channel of a stereo file with extra chunks", () => {
    const voice = speechLike(0.1, RATE);
    const stereo = new Float32Array(voice.length * 2);
    voice.forEach((sample, at) => {
      stereo[at * 2] = sample;
      stereo[at * 2 + 1] = -sample;
    });
    const plain = toWav(stereo, RATE);
    // Mark it stereo, and put a chunk of an odd length before the sound.
    plain.writeUInt16LE(2, 22);
    const extra = Buffer.from("LIST\x03\x00\x00\x00abc\x00", "latin1");
    const file = Buffer.concat([
      plain.subarray(0, 36),
      extra,
      plain.subarray(36),
    ]);
    const { samples } = fromWav(file);
    expect(samples.length).toBe(voice.length);
    expect(correlation(samples, voice)).toBeGreaterThan(0.9999);
  });

  test("refuses what is not a 16-bit WAV file", () => {
    expect(() => fromWav(Buffer.from("not a wave file at all"))).toThrow(
      "Not a WAV file.",
    );
    const eightBit = toWav(speechLike(0.01, RATE), RATE);
    eightBit.writeUInt16LE(8, 34);
    expect(() => fromWav(eightBit)).toThrow("16-bit");
  });
});

describe("resample", () => {
  test("keeps the sound when going up and back down", () => {
    const voice = speechLike(1, RATE);
    const back = resample(resample(voice, RATE, 48_000), 48_000, RATE);
    expect(back.length).toBe(voice.length);
    expect(correlation(back, voice)).toBeGreaterThan(0.99);
    expect(rms(back) / rms(voice)).toBeCloseTo(1, 1);
  });

  test("gives the length the new rate asks for", () => {
    expect(resample(new Float32Array(16_000), 16_000, 24_000)).toHaveLength(
      24_000,
    );
  });
});

describe("findSignal", () => {
  const voice = speechLike(2, RATE);

  test("finds a signal in a longer recording, at any volume", () => {
    const recording = join(
      silence(0.73, RATE),
      voice.map((sample) => sample * 0.4),
      silence(0.5, RATE),
    );
    const match = findSignal(recording, voice, RATE);
    expect(match.lag).toBe(Math.round(0.73 * RATE));
    expect(match.score).toBeGreaterThan(0.999);
    expect(match.worst).toBeGreaterThan(0.999);
    expect(match.gain).toBeCloseTo(0.4, 2);
  });

  test("still matches under room noise", () => {
    const recording = mix(
      join(silence(0.3, RATE), voice),
      noise(2.5, RATE, 0.01),
    );
    const match = findSignal(recording, voice, RATE);
    expect(match.lag).toBe(Math.round(0.3 * RATE));
    expect(match.worst).toBeGreaterThan(0.9);
  });

  test("a dropped piece shows in the worst stretch, not in the whole", () => {
    // A tenth of a second goes missing a second in: everything after it is early.
    const dropped = join(
      voice.subarray(0, RATE),
      voice.subarray(RATE + RATE / 10),
    );
    const match = findSignal(dropped, voice, RATE);
    expect(match.worst).toBeLessThan(0.5);
  });

  test("tells a clock that slipped from a piece that was lost", () => {
    // Forty samples go missing a second in: 2.5 ms, as two sound clocks can differ.
    const slipped = join(voice.subarray(0, RATE), voice.subarray(RATE + 40));
    expect(findSignal(slipped, voice, RATE).worst).toBeLessThan(0.9);
    const allowed = findSignal(slipped, voice, RATE, 0.25, 64);
    expect(allowed.worst).toBeGreaterThan(0.95);
    expect(allowed.slip).toBe(40);
    // A tenth of a second is not a slip, however much slack there is.
    const dropped = join(
      voice.subarray(0, RATE),
      voice.subarray(RATE + RATE / 10),
    );
    expect(findSignal(dropped, voice, RATE, 0.25, 64).worst).toBeLessThan(0.6);
  });

  test("a repeated piece shows too", () => {
    const repeated = join(
      voice.subarray(0, RATE),
      voice.subarray(RATE - RATE / 10),
    );
    expect(findSignal(repeated, voice, RATE).worst).toBeLessThan(0.5);
  });

  test("scores an unrelated recording low", () => {
    const other = speechLike(2, RATE, { pitch: 220, rate: 5.5 });
    expect(findSignal(other, voice, RATE).worst).toBeLessThan(0.5);
  });
});

describe("measurements", () => {
  test("soundStretches tells sentences apart, in seconds", () => {
    const recording = join(
      silence(0.5, RATE),
      speechLike(1, RATE),
      silence(1, RATE),
      speechLike(0.5, RATE),
      silence(0.25, RATE),
    );
    const stretches = soundStretches(recording, RATE);
    expect(stretches).toHaveLength(2);
    expect(stretches[0]!.start).toBeCloseTo(0.5, 1);
    expect(stretches[0]!.end).toBeCloseTo(1.5, 1);
    expect(stretches[1]!.start).toBeCloseTo(2.5, 1);
    expect(stretches[1]!.end).toBeCloseTo(3, 1);
  });

  test("noise is the same every run and at the level asked for", () => {
    expect(noise(0.1, RATE, 0.02, 7)).toEqual(noise(0.1, RATE, 0.02, 7));
    expect(rms(noise(1, RATE, 0.02))).toBeCloseTo(0.02, 2);
  });

  test("largestJump tells a cut from a voice", () => {
    const voice = speechLike(1, 24_000);
    const whole = largestJump(voice);
    // Cut at the loudest sample, and go straight to silence.
    let loudest = 0;
    voice.forEach((sample, at) => {
      if (Math.abs(sample) > Math.abs(voice[loudest]!)) loudest = at;
    });
    const cut = join(voice.subarray(0, loudest + 1), silence(0.1, 24_000));
    expect(largestJump(cut)).toBeGreaterThan(whole * 1.5);
  });

  test("percentile", () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 0.5)).toBe(3);
    expect(percentile(values, 0.95)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([], 0.5)).toBeNaN();
  });
});
