/*
 * Caption pacing for chat-voice: a few words at a time with the one being
 * said in bold, stepped at a reading pace or by the voice's word boundaries.
 * Pure; the component draws the parts and runs the timers.
 */

/** How many words the caption shows at a time. */
export const GROUP = 6;

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

/**
 * How long to show `word`, in milliseconds, at `speed` (1 is 190 words a
 * minute). A long word takes longer.
 */
export function wordDelay(word: string, speed: number | string): number {
  const perWord = 60_000 / (190 * Number(speed));
  const weight = 0.6 + Math.min(word.length, 12) / 10;
  return perWord * weight;
}

/** Where each word starts in the sentence the words were split from by single spaces. */
export function wordStarts(words: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const word of words) {
    starts.push(at);
    at += word.length + 1;
  }
  return starts;
}

/** The word a speech boundary at `charIndex` is about. */
export const wordAt = (starts: readonly number[], charIndex: number): number =>
  Math.max(
    starts.findLastIndex((start) => start <= charIndex),
    0,
  );
