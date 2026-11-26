import { describe, expect, test } from "vitest";
import {
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
