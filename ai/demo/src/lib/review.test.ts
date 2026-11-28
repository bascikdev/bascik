import { describe, expect, it } from "vitest";
import {
  QUEUE,
  decisionFrom,
  branchFrom,
  decisionLabel,
  decisionMessage,
  decisionsIn,
  reviewReply,
} from "./review.ts";

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

const NOW = new Date("2026-11-24T12:00:00Z");

describe("decisionFrom", () => {
  it("reads a fact decision from the form's named fields", () => {
    expect(
      decisionFrom(
        form({
          app: "review",
          kind: "fact",
          item: "returns-window",
          verdict: "confirmed",
          note: "  The emailed receipt counts.  ",
        }),
        NOW,
      ),
    ).toEqual({
      item: "returns-window",
      kind: "fact",
      verdict: "confirmed",
      note: "The emailed receipt counts.",
      rows: {},
      at: "2026-11-24T12:00:00.000Z",
    });
  });

  it("keeps a code table's per-row answers and nothing else", () => {
    const decision = decisionFrom(
      form({
        kind: "codes",
        item: "shelf-codes-2027",
        verdict: "reviewed",
        "FIC-014": "right",
        "CKB-003": "wrong",
        "TEC-020": "maybe",
        "<script>": "wrong",
      }),
      NOW,
    );
    expect(decision?.rows).toEqual({ "FIC-014": "right", "CKB-003": "wrong" });
  });

  it("keeps a fact deck's per-fact answers, and the deck's own fields win", () => {
    const data = form({
      app: "review",
      kind: "facts",
      item: "quick-facts",
      verdict: "reviewed",
    });
    data.append("gift-receipt", "right");
    data.append("sale-items", "wrong");
    // A card the model named after a field of the form: its answer is not a row.
    data.append("kind", "wrong");
    data.append("ebook refunds", "right");
    const decision = decisionFrom(data, NOW);
    expect(decision?.kind).toBe("facts");
    expect(decision?.verdict).toBe("reviewed");
    expect(decision?.rows).toEqual({
      "gift-receipt": "right",
      "sale-items": "wrong",
    });
  });

  it.each([
    ["no item", { kind: "fact", verdict: "confirmed" }],
    ["an unknown kind", { kind: "vote", item: "a", verdict: "confirmed" }],
    ["markup as the item", { kind: "fact", item: "<b>", verdict: "wrong" }],
    ["a verdict with spaces", { kind: "fact", item: "a", verdict: "a b" }],
    ["a file as the item", { kind: "fact", verdict: "confirmed" }],
  ])("refuses a form with %s", (_name, fields) => {
    expect(decisionFrom(form(fields), NOW)).toBeNull();
  });

  it("cuts a note at 2,000 characters", () => {
    const decision = decisionFrom(
      form({
        kind: "gap",
        item: "a",
        verdict: "answered",
        note: "x".repeat(5000),
      }),
      NOW,
    );
    expect(decision?.note).toHaveLength(2000);
  });
});

describe("a decision as a chat message", () => {
  it("reads back what it wrote, with rows and a note of several lines", () => {
    const decision = decisionFrom(
      form({
        kind: "codes",
        item: "shelf-codes-2027",
        verdict: "reviewed",
        "FIC-014": "right",
        "CKB-003": "wrong",
        note: "CKB-003 goes to CKB-030.\nAsk the buyer about BIO-007: right",
      }),
      NOW,
    )!;
    const [read] = decisionsIn([
      { role: "user", content: decisionMessage(decision) },
    ]);
    expect(read).toEqual({ ...decision, at: "" });
  });

  it("is only read from the reviewer's own messages", () => {
    const content = "Decision on returns-window (fact): confirmed";
    expect(decisionsIn([{ role: "assistant", content }])).toEqual([]);
    expect(
      decisionsIn([{ role: "user", content: `I think the ${content}` }]),
    ).toEqual([]);
  });
});

describe("a decision as the thread shows it", () => {
  const decided = (fields: Record<string, string>) =>
    decisionFrom(form(fields), NOW)!;

  it("is the words on the button that was pressed, then the note", () => {
    const base = { kind: "fact", item: "returns-window" };
    expect(decisionLabel(decided({ ...base, verdict: "unsure" }))).toBe(
      "Not sure",
    );
    expect(decisionLabel(decided({ ...base, verdict: "wrong" }))).toBe("Wrong");
    expect(
      decisionLabel(
        decided({ ...base, verdict: "confirmed", note: "<b>45</b> days, $1" }),
      ),
    ).toBe("Correct\n<b>45</b> days, $1");
    expect(
      decisionLabel(decided({ kind: "plan", item: "p", verdict: "changes" })),
    ).toBe("Needs changes");
  });

  it("is the reviewer's own answer to a gap, or that they do not know", () => {
    const base = { kind: "gap", item: "gift-returns" };
    expect(
      decisionLabel(
        decided({ ...base, verdict: "answered", note: "Store credit only." }),
      ),
    ).toBe("Store credit only.");
    expect(decisionLabel(decided({ ...base, verdict: "unknown" }))).toBe(
      "I do not know",
    );
  });

  it("names the branch of a rule by the condition its form sent", () => {
    const posted = form({
      kind: "rule",
      item: "damaged-no-receipt",
      verdict: "store-credit",
      "store-credit": "the receipt cannot be found",
      refund: "the card is on file",
    });
    const decision = decisionFrom(posted, NOW)!;
    expect(branchFrom(posted, decision)).toBe("the receipt cannot be found");
    expect(decisionLabel(decision, branchFrom(posted, decision))).toBe(
      "If the receipt cannot be found",
    );
    // Without the condition, and for "none of these", it still says something.
    expect(decisionLabel(decision)).toBe("Answered");
    expect(
      decisionLabel(
        decided({ kind: "rule", item: "r", verdict: "none-fit", note: "Ask." }),
      ),
    ).toBe("None of these\nAsk.");
  });

  it("never reads a branch's words from one of the form's own fields", () => {
    const posted = form({
      kind: "rule",
      item: "r",
      verdict: "note",
      note: "x",
    });
    expect(branchFrom(posted, decisionFrom(posted, NOW)!)).toBe("");
  });

  it("counts the rows of a table or a deck", () => {
    const base = { kind: "facts", item: "quick-facts", verdict: "reviewed" };
    expect(
      decisionLabel(decided({ ...base, a: "right", b: "wrong", c: "right" })),
    ).toBe("2 right, 1 wrong");
    expect(
      decisionLabel(
        decided({ ...base, kind: "codes", a: "right", b: "right", note: "Ok" }),
      ),
    ).toBe("All 2 right\nOk");
  });

  it("does not change what the model reads", () => {
    const decision = decided({
      kind: "fact",
      item: "returns-window",
      verdict: "unsure",
    });
    expect(decisionMessage(decision)).toBe(
      "Decision on returns-window (fact): unsure",
    );
  });
});

describe("the offline reviewer", () => {
  const user = (content: string) => ({ role: "user", content });
  const decide = (item: string, kind: string, verdict: string) =>
    user(`Decision on ${item} (${kind}): ${verdict}`);

  it("starts with the first item and its place in the process", () => {
    const reply = reviewReply([user("Start the review")]);
    expect(reply).toContain(`<fact-check item="returns-window"`);
    expect(reply).toContain(`state="current"`);
    expect(reply).not.toContain("<decision-fork");
  });

  it("acknowledges a decision and moves to the next undecided item", () => {
    const reply = reviewReply([
      user("Start the review"),
      decide("returns-window", "fact", "wrong"),
    ]);
    expect(reply).toMatch(/^Recorded as wrong/);
    expect(reply).toContain(`<decision-fork item="damaged-no-receipt"`);
  });

  it("names the code rows the reviewer flagged", () => {
    const reply = reviewReply([
      user(
        "Decision on shelf-codes-2027 (codes): reviewed\nFIC-014: right\nCKB-003: wrong",
      ),
    ]);
    expect(reply).toMatch(/^Recorded\. I will hold CKB-003/);
  });

  it("ends with every decision in a table, with the note shown as text", () => {
    const messages = QUEUE.map((item) =>
      decide(item.id, item.kind, "confirmed"),
    );
    messages[0] = user(
      "Decision on returns-window (fact): wrong\nNote: <b>45</b> days & a receipt",
    );
    const reply = reviewReply(messages);
    expect(reply).toContain("That was the last item.");
    expect(reply).toContain(
      "<td>returns-window</td><td>fact</td><td>wrong</td><td>&lt;b&gt;45&lt;/b&gt; days &amp; a receipt</td>",
    );
    expect(reply.match(/<tr><td>/g)).toHaveLength(QUEUE.length);
  });

  it("shows what is decided so far when asked, without counting the question", () => {
    const reply = reviewReply([
      decide("returns-window", "fact", "confirmed"),
      user("Show my decisions so far"),
    ]);
    expect(reply).toMatch(/^1 of 6 items are decided\./);
    expect(reply).toContain("Continue the review");
  });
});
