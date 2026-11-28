import { describe, expect, test } from "vitest";
import { CLOSED_KEPT, closePieces, hear, readerText } from "./reader.ts";
import type { ReaderPiece } from "./reader.ts";

const turn = (): ReaderPiece[] => [];

describe("hear", () => {
  test("words with no name are added to the end", () => {
    const pieces = turn();
    hear(pieces, "Recommend");
    hear(pieces, " a book");
    expect(readerText(pieces)).toBe("Recommend a book");
    expect(pieces).toHaveLength(1);
  });

  test("a named utterance's whole text replaces its own words, and no other's", () => {
    const pieces = turn();
    hear(pieces, "Tell me about", "a");
    hear(pieces, "Tell me about the AI package.", "a", true);
    hear(pieces, "How does", "b");
    hear(pieces, "How does that work?", "b", true);
    expect(readerText(pieces)).toBe(
      "Tell me about the AI package. How does that work?",
    );
  });

  test("utterances keep the order they were spoken in, whenever their words come", () => {
    const pieces = turn();
    hear(pieces, "", "a");
    hear(pieces, "", "b");
    hear(pieces, "second.", "b", true);
    expect(readerText(pieces)).toBe("second.");
    hear(pieces, "First,", "a", true);
    expect(readerText(pieces)).toBe("First, second.");
  });

  test("a late utterance does not replace what was typed", () => {
    const pieces = turn();
    hear(pieces, "typed words");
    hear(pieces, "spoken words", "a", true);
    expect(readerText(pieces)).toBe("typed words spoken words");
  });

  test("words after a named utterance start a piece of their own", () => {
    const pieces = turn();
    hear(pieces, "Fill in the form", "a", true);
    hear(pieces, "\nName: Ada");
    hear(pieces, " Lovelace");
    expect(readerText(pieces)).toBe("Fill in the form\nName: Ada Lovelace");
  });

  test("text is kept as it is, whatever is in it", () => {
    const pieces = turn();
    hear(pieces, "costs $1 & <b>$&</b>", "a", true);
    expect(readerText(pieces)).toBe("costs $1 & <b>$&</b>");
  });
});

describe("closePieces", () => {
  test("empties the turn and remembers its utterances, with or without words", () => {
    const pieces = turn();
    const closed = new Set<string>();
    hear(pieces, "", "item_a");
    hear(pieces, "typed");
    hear(pieces, "How does that work?", "item_b", true);
    closePieces(pieces, closed);
    expect(pieces).toEqual([]);
    expect([...closed]).toEqual(["item_a", "item_b"]);
  });

  test("remembers only the newest utterances", () => {
    const closed = new Set<string>();
    for (let at = 0; at < CLOSED_KEPT + 5; at++) {
      const pieces = turn();
      hear(pieces, "words", `item_${at}`);
      closePieces(pieces, closed);
    }
    expect(closed.size).toBe(CLOSED_KEPT);
    expect(closed.has("item_4")).toBe(false);
    expect(closed.has("item_5")).toBe(true);
    expect(closed.has(`item_${CLOSED_KEPT + 4}`)).toBe(true);
  });

  test("an utterance closed again is kept as the newest", () => {
    const closed = new Set(["a", "b"]);
    const pieces = turn();
    hear(pieces, "again", "a");
    closePieces(pieces, closed, 2);
    expect([...closed]).toEqual(["b", "a"]);
  });
});

describe("readerText", () => {
  test("is empty for a turn of utterances with no words yet", () => {
    const pieces = turn();
    hear(pieces, "", "a");
    hear(pieces, "  ", "b");
    expect(readerText(pieces)).toBe("");
  });

  test("adds no space where a piece brings its own", () => {
    const pieces = turn();
    hear(pieces, "Stop.", "a");
    hear(pieces, " Wait.", "b");
    hear(pieces, "Please.", "c");
    expect(readerText(pieces)).toBe("Stop. Wait. Please.");
  });
});
