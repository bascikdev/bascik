/*
 * Sound as numbers, for the voice tests: a speech-like signal made from a
 * formula (so no recording is committed and every run hears the same thing),
 * WAV and PCM16 in and out, and the measurements a test asserts on: how well
 * two recordings match, where one starts in the other, and where sound stops.
 *
 * Nothing here needs a browser or a provider. The browser side of the lab is
 * in browser.ts, and the stand-in providers use this through e2e/fake-lab.ts.
 */

/** What makes one utterance differ from another: a pitch and a rhythm. */
export interface Voice {
  /** The pitch the voice starts at, in hertz. */
  pitch?: number;
  /** Syllables a second. */
  rate?: number;
  /** The loudest sample, 0 to 1. */
  peak?: number;
}

/**
 * A signal shaped like speech: a pitched buzz with a few formants, in
 * syllables, in words with short gaps between them. It is not speech, and no
 * recognizer will read words in it; it has speech's level, rhythm and
 * spectrum, which is what capture, playback and level detection work on.
 * The same arguments always give the same samples.
 */
export function speechLike(
  seconds: number,
  sampleRate: number,
  voice: Voice = {},
): Float32Array {
  const { pitch = 130, rate = 4.2, peak = 0.5 } = voice;
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  // Three formants, each a band of harmonics that is louder than the rest.
  const formants = [
    [700, 1],
    [1200, 0.6],
    [2600, 0.3],
  ] as const;
  let phase = 0;
  let loudest = 0;
  for (let at = 0; at < samples.length; at++) {
    const time = at / sampleRate;
    // The pitch falls over a word and wobbles a little, as a voice does.
    const syllable = time * rate;
    const word = Math.floor(syllable / 3);
    const inWord = syllable / 3 - word;
    const f0 =
      pitch * (1.12 - 0.2 * inWord) * (1 + 0.015 * Math.sin(time * 31));
    phase += (2 * Math.PI * f0) / sampleRate;
    let value = 0;
    for (let harmonic = 1; harmonic * f0 < 3400; harmonic++) {
      let weight = 0.08 / harmonic;
      for (const [center, gain] of formants) {
        // A formant moves from word to word, so no two words sound the same.
        const moved = center * (1 + 0.18 * Math.sin(word * 2.4 + center));
        const distance = (harmonic * f0 - moved) / 160;
        weight += gain * Math.exp(-distance * distance);
      }
      value += weight * Math.sin(harmonic * phase);
    }
    // A syllable rises and falls; the third of every three is cut short by a gap.
    const beat = syllable - Math.floor(syllable);
    const lastOfWord = Math.floor(syllable) % 3 === 2;
    const open = lastOfWord ? beat < 0.55 : true;
    const envelope = open ? Math.sin(Math.PI * Math.min(1, beat / 0.9)) : 0;
    samples[at] = value * envelope ** 0.7;
    loudest = Math.max(loudest, Math.abs(samples[at]!));
  }
  // A short fade at each end, so that starting and stopping it is not a click.
  const fade = Math.min(samples.length >> 1, Math.round(sampleRate * 0.01));
  for (let at = 0; at < fade; at++) {
    samples[at]! *= at / fade;
    samples[samples.length - 1 - at]! *= at / fade;
  }
  if (loudest > 0) {
    for (let at = 0; at < samples.length; at++) {
      samples[at] = (samples[at]! / loudest) * peak;
    }
  }
  return samples;
}

/** Noise at a steady level, the same every run: a room, a fan, a street. */
export function noise(
  seconds: number,
  sampleRate: number,
  level = 0.02,
  seed = 1,
): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  let state = seed >>> 0 || 1;
  for (let at = 0; at < samples.length; at++) {
    // xorshift32: small, fast, and the same on every machine.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    samples[at] = (state / 0xffff_ffff - 0.5) * 2 * level * Math.SQRT2 * 1.2247;
  }
  return samples;
}

/** `first` and `second` added together, as long as the longer of the two. */
export function mix(first: Float32Array, second: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(first.length, second.length));
  out.set(first);
  for (let at = 0; at < second.length; at++) out[at]! += second[at]!;
  return out;
}

/** `pieces` one after another. */
export function join(...pieces: Float32Array[]): Float32Array {
  const out = new Float32Array(
    pieces.reduce((total, piece) => total + piece.length, 0),
  );
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
}

export const silence = (seconds: number, sampleRate: number): Float32Array =>
  new Float32Array(Math.round(seconds * sampleRate));

/** Samples from -1 to 1 as 16-bit little-endian PCM. */
export function toPcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let at = 0; at < samples.length; at++) {
    const clipped = Math.max(-1, Math.min(1, samples[at]!));
    out.writeInt16LE(Math.round(clipped * 32_767), at * 2);
  }
  return out;
}

/** 16-bit little-endian PCM as samples from -1 to 1. An odd last byte is left out. */
export function fromPcm16(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 1);
  for (let at = 0; at < out.length; at++) {
    out[at] = view.getInt16(at * 2, true) / 32_768;
  }
  return out;
}

/** A mono 16-bit WAV file of `samples`. */
export function toWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = toPcm16(samples);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The first channel of a 16-bit PCM WAV file, and its rate. Reads the chunks
 * rather than trusting a 44-byte header, since a recorder may add its own.
 */
export function fromWav(file: Uint8Array): {
  samples: Float32Array;
  sampleRate: number;
} {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Not a WAV file.");
  }
  let sampleRate = 0;
  let channels = 1;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      const format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      const bits = bytes.readUInt16LE(body + 14);
      // 0xFFFE is the extensible form of plain PCM, which recorders write.
      if ((format !== 1 && format !== 0xfffe) || bits !== 16) {
        throw new Error("Only 16-bit PCM WAV files are read.");
      }
    } else if (id === "data") {
      if (!sampleRate) throw new Error("A WAV file's format comes first.");
      const all = fromPcm16(
        bytes.subarray(body, Math.min(bytes.length, body + size)),
      );
      if (channels === 1) return { samples: all, sampleRate };
      const first = new Float32Array(Math.floor(all.length / channels));
      for (let frame = 0; frame < first.length; frame++) {
        first[frame] = all[frame * channels]!;
      }
      return { samples: first, sampleRate };
    }
    at = body + size + (size & 1);
  }
  throw new Error("A WAV file with no sound in it.");
}

/**
 * `samples` at another rate, by a windowed sinc. Good enough to compare with
 * what a browser's own resampler gives; not for listening.
 */
export function resample(
  samples: Float32Array,
  from: number,
  to: number,
): Float32Array {
  if (from === to) return samples.slice();
  const out = new Float32Array(Math.round((samples.length * to) / from));
  const step = from / to;
  // Going down, the filter is cut at the new rate's limit.
  const cutoff = Math.min(1, to / from);
  const reach = Math.ceil(8 / cutoff);
  for (let at = 0; at < out.length; at++) {
    const center = at * step;
    const first = Math.max(0, Math.ceil(center - reach));
    const last = Math.min(samples.length - 1, Math.floor(center + reach));
    let sum = 0;
    for (let source = first; source <= last; source++) {
      const x = (source - center) * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window =
        0.5 + 0.5 * Math.cos((Math.PI * (source - center)) / reach);
      sum += samples[source]! * sinc * window * cutoff;
    }
    out[at] = sum;
  }
  return out;
}

/** The root mean square of a stretch of samples: its loudness. */
export function rms(
  samples: Float32Array,
  start = 0,
  end = samples.length,
): number {
  let squares = 0;
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  for (let at = from; at < to; at++) squares += samples[at]! * samples[at]!;
  return to > from ? Math.sqrt(squares / (to - from)) : 0;
}

/** Loudness in steps of `windowSeconds`, one number a step. */
export function envelope(
  samples: Float32Array,
  sampleRate: number,
  windowSeconds = 0.01,
): Float32Array {
  const size = Math.max(1, Math.round(sampleRate * windowSeconds));
  const out = new Float32Array(Math.floor(samples.length / size));
  for (let at = 0; at < out.length; at++) {
    out[at] = rms(samples, at * size, (at + 1) * size);
  }
  return out;
}

/**
 * How alike two stretches are, from -1 to 1: 1 is the same shape at any
 * volume, 0 is unrelated. `lag` is where `found` starts in `whole`.
 */
export function correlation(
  whole: Float32Array,
  found: Float32Array,
  lag = 0,
  start = 0,
  end = found.length,
): number {
  let dot = 0;
  let wholeSquares = 0;
  let foundSquares = 0;
  for (let at = start; at < end; at++) {
    const other = at + lag;
    if (other < 0 || other >= whole.length) continue;
    dot += whole[other]! * found[at]!;
    wholeSquares += whole[other]! * whole[other]!;
    foundSquares += found[at]! * found[at]!;
  }
  const scale = Math.sqrt(wholeSquares * foundSquares);
  return scale > 0 ? dot / scale : 0;
}

/** Where a known signal was found in a recording, and how well it matched. */
export interface Match {
  /** The sample of the recording where the signal starts. */
  lag: number;
  /** How alike the two are over the whole signal, -1 to 1. */
  score: number;
  /**
   * The worst score of any stretch of `windowSeconds`. A dropped, repeated or
   * reordered piece moves everything after it, so its stretch scores near 0
   * while the whole can still look fair.
   */
  worst: number;
  /** The recording's loudness over the signal, divided by the signal's. */
  gain: number;
  /**
   * The furthest any stretch had to be moved from `lag` to match, in
   * samples. Two sound clocks that do not agree move a recording by a few
   * samples over seconds; a lost piece moves it by the piece's length.
   */
  slip: number;
}

/**
 * Find `signal` in `recording` (both at `sampleRate`) and say how well it
 * survived. The search is by loudness first, in 5 ms steps, then by sample
 * around the best step, so a recording of many seconds is quick to search.
 *
 * `slack` is how far, in samples, a stretch may be moved to find its best
 * match. Leave it at 0 for sound that stayed on one clock (what a page
 * plays). Give it a few milliseconds for sound that crossed from one clock
 * to another (a microphone into a capture context), and assert on `slip`.
 */
export function findSignal(
  recording: Float32Array,
  signal: Float32Array,
  sampleRate: number,
  windowSeconds = 0.25,
  slack = 0,
): Match {
  const step = Math.max(1, Math.round(sampleRate * 0.005));
  const coarseRecording = envelope(recording, sampleRate, step / sampleRate);
  const coarseSignal = envelope(signal, sampleRate, step / sampleRate);
  let coarse = 0;
  let coarseScore = -Infinity;
  for (let lag = -coarseSignal.length; lag < coarseRecording.length; lag++) {
    let dot = 0;
    for (let at = 0; at < coarseSignal.length; at++) {
      const other = at + lag;
      if (other >= 0 && other < coarseRecording.length) {
        dot += coarseRecording[other]! * coarseSignal[at]!;
      }
    }
    if (dot > coarseScore) {
      coarseScore = dot;
      coarse = lag;
    }
  }
  let lag = coarse * step;
  let score = -Infinity;
  // The loudness search is good to a step or two: look at every sample near it.
  // A second of the signal is enough to place it.
  const probe = Math.min(signal.length, sampleRate);
  const loudestStart = loudestStretch(signal, probe);
  for (
    let near = coarse * step - 3 * step;
    near <= coarse * step + 3 * step;
    near++
  ) {
    const found = correlation(
      recording,
      signal,
      near,
      loudestStart,
      loudestStart + probe,
    );
    if (found > score) {
      score = found;
      lag = near;
    }
  }
  const size = Math.round(sampleRate * windowSeconds);
  let worst = 1;
  let slip = 0;
  for (let start = 0; start + size <= signal.length; start += size) {
    // A stretch of silence has no shape to compare.
    if (rms(signal, start, start + size) < 0.005) continue;
    let best = -Infinity;
    let moved = 0;
    for (let move = -slack; move <= slack; move++) {
      const found = correlation(
        recording,
        signal,
        lag + move,
        start,
        start + size,
      );
      if (found > best) {
        best = found;
        moved = move;
      }
    }
    worst = Math.min(worst, best);
    slip = Math.max(slip, Math.abs(moved));
  }
  const heard = rms(recording, lag, lag + signal.length);
  return {
    lag,
    score: correlation(recording, signal, lag),
    worst,
    gain: heard / (rms(signal) || 1),
    slip,
  };
}

/** Where the loudest stretch of `length` samples starts. */
function loudestStretch(samples: Float32Array, length: number): number {
  if (samples.length <= length) return 0;
  const hop = Math.max(1, length >> 3);
  let best = 0;
  let bestLevel = -1;
  for (let start = 0; start + length <= samples.length; start += hop) {
    const level = rms(samples, start, start + length);
    if (level > bestLevel) {
      bestLevel = level;
      best = start;
    }
  }
  return best;
}

/** A stretch of a recording, in seconds from its start. */
export interface Stretch {
  start: number;
  end: number;
}

/**
 * Every stretch of sound in a recording: where the level is above `floor`,
 * with quiet shorter than `bridge` seconds counted as part of the sound
 * around it (a gap between words is not the end of a sentence).
 */
export function soundStretches(
  samples: Float32Array,
  sampleRate: number,
  floor = 0.003,
  bridge = 0.2,
): Stretch[] {
  const window = 0.005;
  const levels = envelope(samples, sampleRate, window);
  const stretches: Stretch[] = [];
  let open: Stretch | null = null;
  for (let at = 0; at < levels.length; at++) {
    if (levels[at]! <= floor) continue;
    const time = at * window;
    if (open && time - open.end <= bridge) {
      open.end = time + window;
    } else {
      open = { start: time, end: time + window };
      stretches.push(open);
    }
  }
  return stretches;
}

/**
 * The largest jump between two neighboring samples. A voice at these rates
 * moves a small part of full scale from one sample to the next; a cut in the
 * middle of a sound, which is heard as a click, jumps far.
 */
export function largestJump(samples: Float32Array): number {
  let largest = 0;
  for (let at = 1; at < samples.length; at++) {
    largest = Math.max(largest, Math.abs(samples[at]! - samples[at - 1]!));
  }
  return largest;
}

/** The `fraction` point of a list of numbers: 0.5 is the median, 0.95 the 95th percentile. */
export function percentile(
  values: readonly number[],
  fraction: number,
): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((first, second) => first - second);
  const at = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[at]!;
}
