/*
 * Caption timing for voice-call: which words the model's voice is saying,
 * and where each one falls in the turn's audio. Pure, so the component only
 * reads the playback clock and draws what these functions return.
 */

import type { Voiced } from "./types.ts";

/** How many words the caption shows at a time. */
export const GROUP = 6;

/** A turn with nothing to caption yet; `open` turns take more words. */
export const silent = (open: boolean): Voiced => ({
  text: "",
  start: 0,
  seconds: 0,
  open,
  words: [],
});

/**
 * The caption's state across responses. A provider times words from the
 * start of one response's audio, and a turn can have more than one
 * response. `responseAt` is where the response being played starts in the
 * turn's audio; null until its first audio arrives, and words that come
 * before that wait in `early`.
 */
export interface Timeline {
  voiced: Voiced;
  responseAt: number | null;
  early: { text: string; ms: number }[];
}

export const newTimeline = (): Timeline => ({
  voiced: silent(false),
  responseAt: null,
  early: [],
});

/** The turn being voiced: a closed one gives way to a new, open one. */
export function voicing(timeline: Timeline): Voiced {
  if (!timeline.voiced.open) timeline.voiced = silent(true);
  return timeline.voiced;
}

/** A new response begins: its words wait for its audio. */
export function newResponse(timeline: Timeline): void {
  timeline.responseAt = null;
  timeline.early = [];
}

/** The time of one word, in milliseconds from its response's audio. */
export function timedWord(timeline: Timeline, text: string, ms: number): void {
  if (timeline.responseAt === null) {
    timeline.early.push({ text, ms });
    return;
  }
  const words = voicing(timeline).words;
  // A full stop comes as a word of its own: it belongs to the word before.
  if (/^[\p{P}\p{S}]+$/u.test(text) && words.length) {
    words[words.length - 1]!.text += text;
  } else {
    words.push({ text, at: timeline.responseAt + ms / 1000 });
  }
}

/**
 * Audio of `seconds` was queued to start at `at` on the playback clock. The
 * first audio of a turn is where its caption starts; the first of a response
 * places that response's words, which may have arrived before it.
 */
export function scheduleAudio(
  timeline: Timeline,
  at: number,
  seconds: number,
): void {
  const turn = voicing(timeline);
  if (turn.seconds === 0) turn.start = at;
  if (timeline.responseAt === null) {
    timeline.responseAt = at - turn.start;
    for (const word of timeline.early.splice(0)) {
      timedWord(timeline, word.text, word.ms);
    }
  }
  // Measured on the clock, so a pause between two responses is counted.
  turn.seconds = at + seconds - turn.start;
}

/** The words on screen and the one being said, or null for no caption. */
export interface CaptionFrame {
  words: string[];
  index: number;
  /** True when the provider timed each word; false when it is estimated. */
  timed: boolean;
}

/**
 * Which word is being spoken, `now` on the playback clock. A provider that
 * sends the time of each word is followed exactly. One that sends only text
 * is estimated: the text and the audio grow together, so the word is found
 * by how far into the turn's audio the playback is.
 */
export function captionAt(voiced: Voiced, now: number): CaptionFrame | null {
  const timed = voiced.words.length > 0;
  const spans = timed ? [] : wordSpans(voiced.text);
  const words = timed
    ? voiced.words.map((word) => word.text)
    : spans.map((span) => voiced.text.slice(span.start, span.end));
  const elapsed = now - voiced.start;
  if (!words.length || voiced.seconds === 0 || elapsed > voiced.seconds + 0.4) {
    return null;
  }
  let index = 0;
  if (timed) {
    voiced.words.forEach((word, at) => {
      if (word.at <= elapsed) index = at;
    });
  } else {
    // How far into the text, from its first word to its last, the voice is.
    const first = spans[0]!.start;
    const position =
      first +
      Math.max(0, elapsed / voiced.seconds) * (spans.at(-1)!.end - first);
    spans.forEach((span, at) => {
      if (span.start <= position) index = at;
    });
  }
  return { words, index, timed };
}

/** The group of words a frame shows, and a key that changes when it should be redrawn. */
export function captionGroup(frame: CaptionFrame): {
  start: number;
  key: string;
} {
  const start = Math.floor(frame.index / GROUP) * GROUP;
  return { start, key: `${start}:${frame.index}:${frame.words.length}` };
}

/**
 * The caption's contents: words as text, each followed by a space, and the
 * word being said as `{ current }`, for the component to draw in bold.
 */
export function captionParts(
  words: readonly string[],
  index: number,
): (string | { current: string })[] {
  const start = Math.floor(index / GROUP) * GROUP;
  return words.slice(start, start + GROUP).flatMap((word, offset) => {
    if (offset + start !== index) return [`${word} `];
    return [{ current: word }, " "];
  });
}

/** Writing that puts no spaces between its words. */
const UNSPACED =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;

let segmenter: Intl.Segmenter | undefined;

/**
 * Where each word of `text` is: the offsets of every run that is not white
 * space. A run in a script that is written without spaces is divided into
 * its words, where the browser can tell them; a mark of punctuation stays
 * with the word beside it.
 */
export function wordSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const run of text.matchAll(/\S+/g)) {
    const end = run.index + run[0].length;
    if (!UNSPACED.test(run[0]) || typeof Intl.Segmenter !== "function") {
      spans.push({ start: run.index, end });
      continue;
    }
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
    /** Where the word being gathered starts, and whether a word of this run is out. */
    let start = run.index;
    let begun = false;
    for (const piece of segmenter.segment(run[0])) {
      const pieceEnd = run.index + piece.index + piece.segment.length;
      if (piece.isWordLike) {
        spans.push({ start, end: pieceEnd });
        begun = true;
      } else if (begun) {
        spans.at(-1)!.end = pieceEnd;
      } else {
        // Punctuation that opens the run goes with the word after it.
        continue;
      }
      start = pieceEnd;
    }
    // A run with no word in it is one span.
    if (!begun) spans.push({ start: run.index, end });
  }
  return spans;
}

const inked = (text: string): number => text.replace(/\s/g, "").length;

/**
 * Where the word being said is in the turn's text, as offsets into
 * `voiced.text`, or null when the text does not reach that far yet. A word
 * the provider timed is found by counting the characters, white space left
 * out, of the timed words before it: the provider's words and its text do
 * not break in the same places (a quotation mark comes as a word of its own).
 */
export function spokenRange(
  voiced: Voiced,
  frame: CaptionFrame,
): { start: number; end: number } | null {
  if (!frame.timed) return wordSpans(voiced.text)[frame.index] ?? null;
  let before = 0;
  for (let at = 0; at < frame.index; at++) {
    before += inked(voiced.words[at]!.text);
  }
  const length = inked(voiced.words[frame.index]?.text ?? "");
  if (!length) return null;
  let seen = 0;
  let start = -1;
  for (let at = 0; at < voiced.text.length; at++) {
    if (/\s/.test(voiced.text[at]!)) continue;
    if (seen === before) start = at;
    seen++;
    if (start >= 0 && seen === before + length) return { start, end: at + 1 };
  }
  return null;
}
