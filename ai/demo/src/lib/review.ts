/**
 * The review app: a knowledge assistant asks a subject expert to validate
 * what it read before it answers anyone with it. Each item is shown with the
 * review component that fits it (a fact to confirm, a rule to choose, a code
 * table to check, a gap to fill, a plan to approve), and every answer is one
 * plain form post that lands here as a `Decision`.
 *
 * The sample knowledge is a bookshop's returns desk. Swap `QUEUE` for items
 * your own pipeline extracts from its sources.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scriptedModel, type Model, type Tool } from "@bascik/ai";

/* ---- Decisions: what a review form posts, and where it is kept ---- */

export type ReviewKind = "fact" | "rule" | "codes" | "gap" | "plan";

export interface Decision {
  item: string;
  kind: ReviewKind;
  /** confirmed, wrong, unsure, approved, changes, answered, unknown, reviewed, or a branch id. */
  verdict: string;
  note: string;
  /** Per-row answers of a code table: old code to "right" or "wrong". */
  rows: Record<string, string>;
  at: string;
}

const KINDS: readonly ReviewKind[] = ["fact", "rule", "codes", "gap", "plan"];
const TOKEN = /^[\w.-]{1,64}$/;
const MAX_NOTE = 2000;
const MAX_ROWS = 200;
/** Fields a review form sends that are not a code row. */
const OWN_FIELDS = new Set(["app", "kind", "item", "verdict", "note"]);

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** The decision a review form posted, or null when it is not one. */
export function decisionFrom(
  form: FormData,
  now = new Date(),
): Decision | null {
  const item = field(form, "item");
  const kind = field(form, "kind") as ReviewKind;
  const verdict = field(form, "verdict");
  if (!TOKEN.test(item) || !KINDS.includes(kind) || !TOKEN.test(verdict)) {
    return null;
  }
  const rows: Record<string, string> = {};
  if (kind === "codes") {
    for (const [name, value] of form) {
      if (OWN_FIELDS.has(name) || typeof value !== "string") continue;
      if (!TOKEN.test(name) || (value !== "right" && value !== "wrong")) {
        continue;
      }
      if (Object.keys(rows).length >= MAX_ROWS) break;
      rows[name] = value;
    }
  }
  return {
    item,
    kind,
    verdict,
    note: field(form, "note").slice(0, MAX_NOTE),
    rows,
    at: now.toISOString(),
  };
}

/**
 * The decision as the reviewer's next chat message. It is what the model
 * reads, and `decisionsIn` reads it back, so a conversation is its own record.
 */
export function decisionMessage(decision: Decision): string {
  const lines = [
    `Decision on ${decision.item} (${decision.kind}): ${decision.verdict}`,
  ];
  for (const [code, answer] of Object.entries(decision.rows)) {
    lines.push(`${code}: ${answer}`);
  }
  if (decision.note) lines.push(`Note: ${decision.note}`);
  return lines.join("\n");
}

const DECISION_LINE = /^Decision on ([\w.-]+) \((\w+)\): ([\w.-]+)$/;

/** Every decision recorded in a conversation, oldest first. */
export function decisionsIn(
  messages: readonly { role: string; content: string }[],
): Decision[] {
  const found: Decision[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const [first = "", ...rest] = message.content.split("\n");
    const match = DECISION_LINE.exec(first);
    if (!match) continue;
    const rows: Record<string, string> = {};
    let note = "";
    for (const [index, line] of rest.entries()) {
      if (line.startsWith("Note: ")) {
        note = [line.slice(6), ...rest.slice(index + 1)].join("\n");
        break;
      }
      const row = /^([\w.-]+): (right|wrong)$/.exec(line);
      if (row) rows[row[1]!] = row[2]!;
    }
    found.push({
      item: match[1]!,
      kind: match[2] as ReviewKind,
      verdict: match[3]!,
      note,
      rows,
      at: "",
    });
  }
  return found;
}

const LOG_DIR = join(process.cwd(), ".data", "decisions");

/** Append the decision to the visitor's log: one JSON object per line. */
export async function recordDecision(
  visitor: string,
  conversation: string,
  decision: Decision,
): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(
    join(LOG_DIR, `${visitor}.jsonl`),
    `${JSON.stringify({ conversation, ...decision })}\n`,
  );
}

/** The visitor's log, oldest first. For an export, a report, or a test. */
export async function readDecisions(
  visitor: string,
): Promise<(Decision & { conversation: string })[]> {
  let text: string;
  try {
    text = await readFile(join(LOG_DIR, `${visitor}.jsonl`), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/* ---- The sample queue: what the assistant read and is unsure of ---- */

interface QueueItem {
  id: string;
  kind: ReviewKind;
  /** What the assistant shows, in the model's own output format. */
  ask: string;
}

const STAGES = [
  ["Receive", "The book and the customer arrive at the desk."],
  ["Check receipt", "Find the sale: a receipt, or a card lookup."],
  ["Inspect", "Grade the book as new, used, or damaged."],
  ["Refund or credit", "Pay back the way the rules allow."],
  ["Restock", "Shelve it, or send it to the damaged bin."],
] as const;

/** The returns process with one stage marked as the one being asked about. */
const flow = (current: number, unclear: number[] = []): string =>
  [
    `<flow-diagram title="Returns desk, start to finish">`,
    ...STAGES.map(([label, detail], index) => {
      const state = unclear.includes(index)
        ? "unclear"
        : index < current
          ? "done"
          : index === current
            ? "current"
            : "todo";
      return `<flow-stage label="${label}" state="${state}">${detail}</flow-stage>`;
    }),
    `</flow-diagram>`,
  ].join("\n");

export const QUEUE: QueueItem[] = [
  {
    id: "returns-window",
    kind: "fact",
    ask: [
      "First, a fact I plan to quote to customers. It belongs to the second stage:",
      "",
      flow(1),
      "",
      `<fact-check item="returns-window" claim="A book can be returned within 30 days of purchase when the customer has the receipt.">`,
      `<source-quote source="Returns policy, section 2">Returns are accepted for 30 days from the date of sale. Proof of purchase is required.</source-quote>`,
      `</fact-check>`,
    ].join("\n"),
  },
  {
    id: "damaged-no-receipt",
    kind: "rule",
    ask: [
      "Next, a case the policy does not settle. It covers a damaged book, and it covers a missing receipt, but not both at once:",
      "",
      flow(2, [3]),
      "",
      `<decision-fork item="damaged-no-receipt" question="A book arrives damaged and the customer has no receipt. What should the desk do?">`,
      `<source-quote source="Returns policy, sections 2 and 4">Proof of purchase is required. [...] A book damaged on arrival is refunded in full.</source-quote>`,
      `<fork-branch value="lookup-then-refund" when="the sale is found by card lookup">refund in full, as for any damaged book.</fork-branch>`,
      `<fork-branch value="store-credit" when="the sale cannot be found">offer store credit at today's price.</fork-branch>`,
      `<fork-branch value="escalate" when="the customer refuses credit">hand the case to the shift lead.</fork-branch>`,
      `</decision-fork>`,
    ].join("\n"),
  },
  {
    id: "shelf-codes-2027",
    kind: "codes",
    ask: [
      "The 2027 shelf code list is out. I matched each retired code to its replacement from the publisher's notice. Flag any row I got wrong:",
      "",
      `<code-map item="shelf-codes-2027" title="Shelf codes replaced on 1 January 2027">`,
      `<code-row old="FIC-014" new="FIC-114">Historical fiction</code-row>`,
      `<code-row old="TEC-020" new="TEC-220">Software engineering</code-row>`,
      `<code-row old="CKB-003" new="CKB-031">Baking</code-row>`,
      `<code-row old="BIO-007" new="BIO-070">Memoir, split from biography</code-row>`,
      `</code-map>`,
    ].join("\n"),
  },
  {
    id: "refund-approval-limit",
    kind: "gap",
    ask: [
      "Here the documentation stops short, and I will not guess:",
      "",
      `<gap-question item="refund-approval-limit" question="What is the desk limit for a refund, and who approves one above it?">`,
      `<source-quote source="Returns policy, section 5">Refunds above the desk limit need approval before they are paid.</source-quote>`,
      `</gap-question>`,
    ].join("\n"),
  },
  {
    id: "returns-answer-plan",
    kind: "plan",
    ask: [
      "Last one. With your answers, this is how I plan to handle a returns question from the team:",
      "",
      `<plan-review item="returns-answer-plan" title="How I will answer a returns question">`,
      `<step-item title="Ask which case it is">Receipt or not, and the condition of the book.</step-item>`,
      `<step-item title="Answer from the policy">Quote the section, and link to it.</step-item>`,
      `<step-item title="Apply your rulings">Use what you decided here where the policy is silent.</step-item>`,
      `<step-item title="Say when I do not know">Log the question for you instead of guessing.</step-item>`,
      `</plan-review>`,
    ].join("\n"),
  },
];

/* ---- The offline reviewer: walks the queue, one item per turn ---- */

const ACKNOWLEDGE: Record<string, string> = {
  confirmed: "Recorded as correct. I can quote it.",
  wrong:
    "Recorded as wrong. I will not use it, and the source goes to an editor with your note.",
  unsure:
    "Recorded as not sure. I will leave it out until someone confirms it.",
  approved: "Approved. I will work this way.",
  changes:
    "Recorded. I will change the plan as your note says and show it again.",
  answered:
    "Thank you. Your answer is saved as a new rule, with you as its source.",
  unknown: "Recorded as unknown. The question stays open for someone else.",
  "none-fit": "Recorded: none of my options fit. Your note is the rule.",
};

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function acknowledge(decision: Decision): string {
  if (decision.kind === "codes") {
    const wrong = Object.entries(decision.rows)
      .filter(([, answer]) => answer === "wrong")
      .map(([code]) => code);
    return wrong.length === 0
      ? "Every replacement accepted. The new codes are in use."
      : `Recorded. I will hold ${wrong.join(", ")} until the replacement is corrected, and use the others.`;
  }
  if (decision.kind === "rule" && !ACKNOWLEDGE[decision.verdict]) {
    return `Recorded: the desk follows the "${decision.verdict}" rule in that case.`;
  }
  return ACKNOWLEDGE[decision.verdict] ?? "Recorded.";
}

function summary(decisions: Decision[]): string {
  if (decisions.length === 0) {
    return "Nothing is decided yet in this review.";
  }
  return [
    "<table>",
    "<thead><tr><th>Item</th><th>Kind</th><th>Your answer</th><th>Note</th></tr></thead>",
    "<tbody>",
    ...decisions.map((decision) => {
      const flagged = Object.entries(decision.rows)
        .filter(([, answer]) => answer === "wrong")
        .map(([code]) => code);
      const answer =
        decision.kind === "codes"
          ? flagged.length === 0
            ? "all rows right"
            : `wrong: ${flagged.join(", ")}`
          : decision.verdict;
      return `<tr><td>${decision.item}</td><td>${decision.kind}</td><td>${answer}</td><td>${escapeText(decision.note)}</td></tr>`;
    }),
    "</tbody>",
    "</table>",
  ].join("\n");
}

/** The offline reviewer's reply to a conversation. Exported for its test. */
export function reviewReply(
  messages: readonly { role: string; content: string }[],
): string {
  const last = messages.at(-1)?.content ?? "";
  const decisions = decisionsIn(messages);
  const decided = new Set(decisions.map((decision) => decision.item));
  const next = QUEUE.find((item) => !decided.has(item.id));
  const justDecided = DECISION_LINE.test(last.split("\n")[0] ?? "");

  if (/\b(summary|decided|decisions|log)\b/i.test(last) && !justDecided) {
    return [
      `${decisions.length} of ${QUEUE.length} items are decided.`,
      "",
      summary(decisions),
      "",
      next
        ? `<ask-button say="Continue the review">Continue the review</ask-button>`
        : "",
    ].join("\n");
  }

  const lead = justDecided ? `${acknowledge(decisions.at(-1)!)}\n\n` : "";
  if (!next) {
    return [
      `${lead}That was the last item. Everything you decided, as it was recorded:`,
      "",
      summary(decisions),
      "",
      "Each row is one form post, kept as one line of JSON on the server.",
    ].join("\n");
  }
  if (decisions.length === 0) {
    return [
      `I read the returns policy and the 2027 shelf code notice, and ${QUEUE.length} things need your judgment before I answer the team with them. One at a time.`,
      "",
      next.ask,
    ].join("\n");
  }
  return `${lead}${next.ask}`;
}

export const reviewModel: Model = scriptedModel(
  (request) => reviewReply(request.messages),
  { chunkSize: 24, delayMs: Number(process.env.DEMO_MODEL_DELAY_MS ?? 14) },
);

/* ---- For a real model: the queue as a tool ---- */

export const reviewTools: Tool[] = [
  {
    name: "review_queue",
    description:
      'List the items waiting for the expert\'s validation, as JSON: [{id, kind, ask}]. `ask` is an example of how to present the item with the review components. Items already decided appear in the conversation as messages that start with "Decision on".',
    inputSchema: { type: "object", properties: {}, required: [] },
    note: () => `<tool-note>Reading the review queue</tool-note>`,
    run: () => JSON.stringify(QUEUE),
  },
];
