import { describe, expect, test } from "vitest";
import { isConversation, summaryAtStart } from "./file-format.ts";

describe("summaryAtStart", () => {
  test("reads the summary at the start of a file fileStore wrote", () => {
    const text = JSON.stringify({
      id: "c-1",
      title: 'Books by "Le Guin" \\ and more',
      updatedAt: 1764000000000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(summaryAtStart(text)).toEqual({
      id: "c-1",
      title: 'Books by "Le Guin" \\ and more',
      updatedAt: 1764000000000,
    });
  });

  test("reads it from only the first bytes of a long file", () => {
    const text = JSON.stringify({
      id: "c-2",
      title: "Long",
      updatedAt: 5,
      messages: ["x".repeat(10_000)],
    }).slice(0, 4096);
    expect(summaryAtStart(text)).toEqual({
      id: "c-2",
      title: "Long",
      updatedAt: 5,
    });
  });

  test("is null when the keys are in another order or missing", () => {
    expect(
      summaryAtStart('{"title":"T","id":"c","updatedAt":1,"messages":[]}'),
    ).toBeNull();
    expect(summaryAtStart('{"id":"c","title":"T","messages":[]}')).toBeNull();
    expect(summaryAtStart("")).toBeNull();
    expect(summaryAtStart("not json")).toBeNull();
  });
});

describe("isConversation", () => {
  test("accepts the shape of a conversation", () => {
    expect(
      isConversation({ id: "c", title: "T", updatedAt: 1, messages: [] }),
    ).toBe(true);
  });

  test("refuses anything else", () => {
    expect(isConversation(null)).toBe(false);
    expect(isConversation([])).toBe(false);
    expect(isConversation("c")).toBe(false);
    expect(
      isConversation({ id: "c", title: "T", updatedAt: "1", messages: [] }),
    ).toBe(false);
    expect(isConversation({ id: "c", title: "T", updatedAt: 1 })).toBe(false);
  });
});
