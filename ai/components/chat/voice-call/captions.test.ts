import { describe, expect, test } from "vitest";
import {
  spokenRange,
  wordSpans,
  GROUP,
  captionAt,
  captionGroup,
  captionParts,
  newResponse,
  newTimeline,
  scheduleAudio,
  silent,
  timedWord,
  voicing,
} from "./captions.ts";

describe("voicing", () => {
  test("opens a new turn after a closed one, and keeps an open one", () => {
    const timeline = newTimeline();
    const first = voicing(timeline);
    expect(first.open).toBe(true);
    expect(voicing(timeline)).toBe(first);
    first.open = false;
    expect(voicing(timeline)).not.toBe(first);
  });
});

describe("timedWord", () => {
  test("holds words that come before their response's audio", () => {
    const timeline = newTimeline();
    timedWord(timeline, "Kindred", 0);
    expect(timeline.early).toEqual([{ text: "Kindred", ms: 0 }]);
    expect(timeline.voiced.words).toEqual([]);
  });

  test("places words from where the response starts in the turn", () => {
    const timeline = newTimeline();
    timeline.responseAt = 2;
    timedWord(timeline, "Octavia", 500);
    expect(timeline.voiced.words).toEqual([{ text: "Octavia", at: 2.5 }]);
  });

  test("joins a full stop to the word before it", () => {
    const timeline = newTimeline();
    timeline.responseAt = 0;
    timedWord(timeline, "Butler", 0);
    timedWord(timeline, ".", 300);
    expect(timeline.voiced.words).toEqual([{ text: "Butler.", at: 0 }]);
  });

  test("keeps a lone punctuation mark when there is no word before it", () => {
    const timeline = newTimeline();
    timeline.responseAt = 0;
    timedWord(timeline, "…", 100);
    expect(timeline.voiced.words).toEqual([{ text: "…", at: 0.1 }]);
  });
});

describe("scheduleAudio", () => {
  test("starts the turn at its first audio, and counts its length", () => {
    const timeline = newTimeline();
    scheduleAudio(timeline, 10, 0.5);
    expect(timeline.voiced).toMatchObject({ start: 10, seconds: 0.5 });
    expect(timeline.responseAt).toBe(0);
    scheduleAudio(timeline, 10.5, 0.5);
    expect(timeline.voiced).toMatchObject({ start: 10, seconds: 1 });
  });

  test("places a second response's early words after the first one", () => {
    const timeline = newTimeline();
    scheduleAudio(timeline, 10, 1);
    newResponse(timeline);
    timedWord(timeline, "Parable", 200);
    expect(timeline.voiced.words).toEqual([]);
    // A pause between the two responses is counted on the clock.
    scheduleAudio(timeline, 12, 1);
    expect(timeline.responseAt).toBe(2);
    expect(timeline.voiced.words).toEqual([{ text: "Parable", at: 2.2 }]);
    expect(timeline.voiced.seconds).toBe(3);
  });
});

describe("captionAt", () => {
  const estimated = {
    ...silent(true),
    text: "Kindred is a novel by Octavia Butler",
    start: 0,
    seconds: 7,
  };

  test("shows nothing without words or audio, or after the audio ends", () => {
    expect(captionAt(silent(true), 0)).toBeNull();
    expect(captionAt({ ...estimated, seconds: 0 }, 1)).toBeNull();
    expect(captionAt(estimated, 7.5)).toBeNull();
    expect(captionAt(estimated, 7.3)).not.toBeNull();
  });

  test("estimates the word from how far into the audio playback is", () => {
    expect(captionAt(estimated, 0)).toEqual({
      words: ["Kindred", "is", "a", "novel", "by", "Octavia", "Butler"],
      index: 0,
      timed: false,
    });
    expect(captionAt(estimated, 3.5)?.index).toBe(3);
    expect(captionAt(estimated, 7)?.index).toBe(6);
  });

  test("follows the provider's word times exactly", () => {
    const voiced = {
      ...silent(true),
      start: 5,
      seconds: 2,
      words: [
        { text: "Dawn", at: 0 },
        { text: "by", at: 0.4 },
        { text: "Butler", at: 0.9 },
      ],
    };
    expect(captionAt(voiced, 5.5)).toEqual({
      words: ["Dawn", "by", "Butler"],
      index: 1,
      timed: true,
    });
    expect(captionAt(voiced, 6)?.index).toBe(2);
  });
});

describe("captionGroup and captionParts", () => {
  const words = "one two three four five six seven eight".split(" ");

  test("shows the group of words the current one is in", () => {
    expect(GROUP).toBe(6);
    expect(captionGroup({ words, index: 7, timed: false })).toEqual({
      start: 6,
      key: "6:7:8",
    });
    expect(captionParts(words, 7)).toEqual([
      "seven ",
      { current: "eight" },
      " ",
    ]);
  });

  test("marks the current word among the others", () => {
    expect(captionParts(words, 1)).toEqual([
      "one ",
      { current: "two" },
      " ",
      "three ",
      "four ",
      "five ",
      "six ",
    ]);
  });
});

describe("wordSpans", () => {
  test("gives where each word is, whatever the white space", () => {
    expect(wordSpans("  Here are\n two ")).toEqual([
      { start: 2, end: 6 },
      { start: 7, end: 10 },
      { start: 12, end: 15 },
    ]);
  });

  test("divides writing that has no spaces into its words", () => {
    const text = "今天我推荐三本书，第一本是重构。";
    const spans = wordSpans(text);
    expect(spans.length).toBeGreaterThan(3);
    // Every character is in one word, in order, and punctuation is not a word of its own.
    expect(spans.map(({ start, end }) => text.slice(start, end)).join("")).toBe(
      text,
    );
    expect(text.slice(spans.at(-1)!.start).endsWith("。")).toBe(true);
    expect(
      spans.every(({ start, end }) => /\p{L}/u.test(text.slice(start, end))),
    ).toBe(true);
  });

  test("keeps opening punctuation with the word after it, and a run with no word whole", () => {
    const text = "「重构」 。。";
    const spans = wordSpans(text);
    expect(spans[0]!.start).toBe(0);
    expect(spans.at(-1)).toEqual({ start: 5, end: 7 });
  });

  test("leaves words written with spaces as they are", () => {
    const text = "don't re-read 3.5 “quotes”";
    expect(
      wordSpans(text).map(({ start, end }) => text.slice(start, end)),
    ).toEqual(text.split(" "));
  });
});

describe("an estimated caption in writing with no spaces", () => {
  test("moves through the text as the voice does", () => {
    const voiced = {
      ...silent(true),
      text: "今天我推荐三本书，第一本是重构。第二本是代码大全。",
      seconds: 6,
    };
    const at = (now: number) => {
      const frame = captionAt(voiced, now)!;
      return spokenRange(voiced, frame)!;
    };
    const early = at(0.1);
    const middle = at(3);
    const late = at(5.9);
    expect(early.start).toBe(0);
    expect(early.end).toBeLessThan(voiced.text.length / 2);
    expect(middle.start).toBeGreaterThan(early.start);
    expect(late.start).toBeGreaterThan(middle.start);
    expect(late.end).toBe(voiced.text.length);
  });
});

describe("spokenRange", () => {
  const cut = (text: string, range: { start: number; end: number } | null) =>
    range && text.slice(range.start, range.end);

  test("an estimated word is the word of that number in the text", () => {
    const voiced = { ...silent(true), text: " Here are two books", seconds: 2 };
    const frame = {
      words: ["Here", "are", "two", "books"],
      index: 2,
      timed: false,
    };
    expect(cut(voiced.text, spokenRange(voiced, frame))).toBe("two");
    expect(spokenRange(voiced, { ...frame, index: 9 })).toBeNull();
  });

  test("a timed word is found by its characters, not by counting words", () => {
    // As a provider sends them: marks come as words of their own, and
    // timedWord joins each to the word before it.
    const text = "these: “Refactoring the Monolith,” “Practical";
    const timeline = newTimeline();
    scheduleAudio(timeline, 0, 5);
    [
      "these",
      ":",
      "“",
      "Refactoring",
      "the",
      "Monolith",
      ",",
      "”",
      "“",
      "Practical",
    ].forEach((word, at) => timedWord(timeline, word, at * 100));
    const voiced = { ...timeline.voiced, text };
    const words = voiced.words.map((word) => word.text);
    const said = words.map((_, index) =>
      cut(text, spokenRange(voiced, { words, index, timed: true })),
    );
    expect(said).toEqual([
      "these: “",
      "Refactoring",
      "the",
      "Monolith,” “",
      "Practical",
    ]);
  });

  test("is null while the text has not reached the word", () => {
    const timeline = newTimeline();
    scheduleAudio(timeline, 0, 2);
    timedWord(timeline, "Here", 0);
    timedWord(timeline, "are", 200);
    const voiced = { ...timeline.voiced, text: "Here a" };
    const words = ["Here", "are"];
    expect(spokenRange(voiced, { words, index: 1, timed: true })).toBeNull();
    expect(
      cut("Here a", spokenRange(voiced, { words, index: 0, timed: true })),
    ).toBe("Here");
  });
});
