import { describe, expect, test } from "vitest";
import { matchOf, wordsOf } from "./search-match.ts";
import type { Conversation } from "./types.ts";

const conversation = (
  messages: Conversation["messages"],
  title = "Reading list",
): Conversation => ({ id: "c-1", title, updatedAt: 7, messages });

describe("wordsOf", () => {
  test("lowercases, splits on any whitespace, and drops repeats", () => {
    expect(wordsOf("  Le Guin\tle\nGUIN  Earthsea ")).toEqual([
      "le",
      "guin",
      "earthsea",
    ]);
  });

  test("keeps at most eight words", () => {
    expect(wordsOf("a b c d e f g h i j")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ]);
  });

  test("an empty or blank query has no words", () => {
    expect(wordsOf("")).toEqual([]);
    expect(wordsOf("   ")).toEqual([]);
  });
});

describe("matchOf", () => {
  test("counts every appearance and marks them in the snippet", () => {
    const found = matchOf(
      conversation([
        { role: "user", content: "Is Earthsea by Le Guin worth reading?" },
        { role: "assistant", content: "Earthsea is a classic. Start there." },
      ]),
      ["earthsea"],
    );
    expect(found?.count).toBe(2);
    expect(found?.match).toEqual({
      id: "c-1",
      title: "Reading list",
      updatedAt: 7,
      snippet: "Is Earthsea by Le Guin worth reading?",
      marks: [[3, 11]],
    });
  });

  test("needs every word somewhere in the conversation", () => {
    const talk = conversation([
      { role: "user", content: "Tell me about Dune." },
      { role: "assistant", content: "Frank Herbert wrote it." },
    ]);
    expect(matchOf(talk, ["dune", "herbert"])?.count).toBe(2);
    expect(matchOf(talk, ["dune", "tolkien"])).toBeNull();
  });

  test("never matches what a tool was given or returned", () => {
    const talk = conversation([
      {
        role: "assistant",
        content: "Here you go.",
        parts: [
          {
            type: "tool",
            id: "t1",
            name: "search_books",
            input: { query: "Middlemarch" },
            state: "done",
            output: "Middlemarch by George Eliot",
          },
          { type: "text", text: "Here you go." },
        ],
      },
    ]);
    expect(matchOf(talk, ["middlemarch"])).toBeNull();
  });

  test("cuts a long message around the first match, with ellipses", () => {
    const text = `${"a".repeat(100)} Beloved ${"b".repeat(300)}`;
    const found = matchOf(conversation([{ role: "user", content: text }]), [
      "beloved",
    ]);
    const snippet = found!.match.snippet;
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    const [[from, to]] = found!.match.marks as [[number, number]];
    expect(snippet.slice(from, to)).toBe("Beloved");
  });

  test("matches and prints what the thread shows for a message, never what it hides", () => {
    const answered = conversation([
      {
        role: "user",
        content: "Decision on returns-window (fact): unsure",
        show: "Not sure",
      },
      { role: "assistant", content: "Recorded." },
      { role: "user", content: "secret command", show: "" },
    ]);
    const found = matchOf(answered, ["not", "sure"]);
    expect(found?.count).toBe(2);
    expect(found?.match.snippet).toBe("Not sure");
    expect(matchOf(answered, ["unsure"])).toBeNull();
    expect(matchOf(answered, ["returns-window"])).toBeNull();
    expect(matchOf(answered, ["secret"])).toBeNull();
  });

  test("an assistant message is matched by its text, whatever it carries", () => {
    const found = matchOf(
      conversation([{ role: "assistant", content: "Dune", show: "Hidden" }]),
      ["dune"],
    );
    expect(found?.match.snippet).toBe("Dune");
  });
});
