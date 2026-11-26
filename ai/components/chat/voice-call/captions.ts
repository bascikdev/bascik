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
  const text = voiced.text.trim();
  const words = timed
    ? voiced.words.map((word) => word.text)
    : text.split(/\s+/).filter(Boolean);
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
    const position = Math.max(0, elapsed / voiced.seconds) * text.length;
    for (let at = 0, word = 0; word < words.length; word++) {
      if (at <= position) index = word;
      at += words[word]!.length + 1;
    }
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
