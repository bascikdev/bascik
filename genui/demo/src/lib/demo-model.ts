/**
 * The model used when no API key is set: it answers from a script, so the
 * demo runs offline and its tests are deterministic. It writes exactly what a
 * real model would be asked to write: prose plus catalog tags.
 */
import {
  scriptedModel,
  type ChatMessage,
  type Model,
  type ModelEvent,
  type ToolPart,
} from "@bascik/genui";
import { CLOSES, OPENS } from "./book-tools.ts";
import { BOOKS, findBook, type Book } from "./books.ts";

const card = (book: Book): string =>
  `<book-card title="${book.title}" author="${book.author}" rating="${book.rating}">${book.blurb}</book-card>`;

const grid = (books: Book[]): string =>
  `<card-grid>\n${books.map(card).join("\n")}\n</card-grid>`;

/** The round after a tool call: say how the hold went. */
function afterTool(message: ChatMessage): string {
  const call = message.parts?.findLast(
    (part): part is ToolPart => part.type === "tool",
  );
  if (call?.name === "local_time") {
    // The reader's browser sent this, or the reader typed it: it is read
    // loosely, and never trusted for anything but this sentence.
    const time = /\b(\d{1,2}):(\d{2})\b/.exec(call.output ?? "");
    if (call.state !== "done" || !time) {
      return `I could not tell what time it is for you. The shop is open ${OPENS}:00 to ${CLOSES}:00.`;
    }
    const hour = Number(time[1]);
    const open = hour >= OPENS && hour < CLOSES;
    return `It is ${call.output} for you. The shop is **${open ? "open" : "closed"}** now: its hours are ${OPENS}:00 to ${CLOSES}:00.`;
  }
  if (call?.state === "done") {
    return [
      `Done. ${call.output}`,
      "",
      `<ask-button say="Recommend a book">Recommend another</ask-button>`,
    ].join("\n");
  }
  if (call?.state === "denied") {
    return "No problem, nothing was held. Ask again whenever you want a copy kept.";
  }
  return `That did not work: ${call?.error ?? "the hold could not be placed"}.`;
}

function reply(text: string): string | ModelEvent[] {
  const asked = text.toLowerCase();
  const book = findBook(text);

  if (/\b(open|hours|closed?)\b/.test(asked)) {
    return [
      "Let me check the time where you are.",
      { type: "tool-call", name: "local_time", input: {} },
    ];
  }

  if (/\b(hold|reserve|keep)\b/.test(asked)) {
    const wanted = book ?? BOOKS[2]!;
    return [
      `I can hold a copy of **${wanted.title}** at the front desk. That changes the shop's records, so it needs your OK first.`,
      { type: "tool-call", name: "place_hold", input: { title: wanted.title } },
    ];
  }

  if (/compare|chart|length|pages|stats/.test(asked)) {
    const longest = Math.max(...BOOKS.map((entry) => entry.pages));
    return [
      "Here is how the four books compare by length.",
      "",
      `<bar-chart title="Pages per book">`,
      ...BOOKS.map(
        (entry) =>
          `<bar-row label="${entry.title}" value="${entry.pages}" max="${longest}" />`,
      ),
      `</bar-chart>`,
      "",
      "**Shipping Small Changes** is the quickest read, at under 200 pages.",
      "",
      `<ask-button say="Tell me more about Shipping Small Changes">Tell me about the short one</ask-button>`,
    ].join("\n");
  }

  if (/diagram|flow|mermaid/.test(asked)) {
    return [
      "This is how I narrow four books down to one, drawn from a `mermaid` fence on the server:",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[You ask for a book] --> B{Know your mood?}",
      "  B -->|Yes| C[Match the mood]",
      "  B -->|No| D[Ask one question]",
      "  D --> C",
      "  C --> E{Short on time?}",
      "  E -->|Yes| F[Shipping Small Changes]",
      "  E -->|No| G[Best rated match]",
      "```",
      "",
      "The diagram is an inline SVG: no script drew it, and it follows the page's light or dark theme.",
      "",
      `<ask-button say="Help me choose a book">Help me choose</ask-button>`,
    ].join("\n");
  }

  if (/choose|quiz|pick|decide/.test(asked)) {
    return [
      "Happy to narrow it down. One question first.",
      "",
      `<choice-form question="What are you in the mood for?">`,
      `<choice-option value="Mood: practical">Something I can apply at work tomorrow</choice-option>`,
      `<choice-option value="Mood: deep">A deep dive that changes how I think</choice-option>`,
      `<choice-option value="Mood: short">Short enough for a weekend</choice-option>`,
      `<choice-option value="Mood: story">A story, not a manual</choice-option>`,
      `</choice-form>`,
    ].join("\n");
  }

  const mood = /^mood: (\w+)/.exec(asked)?.[1];
  if (mood) {
    const match = BOOKS.find((entry) => entry.mood === mood) ?? BOOKS[0]!;
    return [
      `Then this is your book.`,
      "",
      card(match),
      "",
      `<ask-button say="Add ${match.title} to my reading log">Log it as started</ask-button>`,
    ].join("\n");
  }

  if (/log|track|started|finished/.test(asked) && !asked.startsWith("book:")) {
    return [
      "Fill this in and I will add it to your reading log.",
      "",
      `<input-form title="Reading log entry" submit="Save entry">`,
      `<text-field label="Book" name="Book" />`,
      `<text-field label="Pages read" name="Pages read" />`,
      `<text-field label="One-line note" name="Note" />`,
      `</input-form>`,
    ].join("\n");
  }

  if (asked.startsWith("book:")) {
    return [
      "Saved. Your entry, as the form sent it:",
      "",
      "```",
      text,
      "```",
      "",
      "The form was plain HTML, so this worked without any JavaScript on the page.",
    ].join("\n");
  }

  if (book) {
    return [
      `**${book.title}** by ${book.author} is the one I would start with if you want something ${book.mood}.`,
      "",
      `<card-grid>`,
      `<stat-tile label="Rating" value="${book.rating}">out of 5</stat-tile>`,
      `<stat-tile label="Length" value="${book.pages}">pages</stat-tile>`,
      `<stat-tile label="Published" value="${book.year}">first edition</stat-tile>`,
      `</card-grid>`,
      "",
      book.blurb,
      "",
      `<ask-button say="Hold a copy of ${book.title}">Hold a copy</ask-button>`,
      `<ask-button say="Compare the page counts of every book">Compare lengths</ask-button>`,
    ].join("\n");
  }

  if (/recommend|book|read|suggest/.test(asked)) {
    return [
      "Three picks from the catalog, each rendered by a `book-card` component on the server:",
      "",
      grid(BOOKS.slice(0, 3)),
      "",
      "Every card has its own button, and each button is a form that posts your next message.",
      "",
      `<ask-button say="Help me choose a book">Help me choose</ask-button>`,
      `<ask-button say="Compare the page counts of every book">Compare lengths</ask-button>`,
    ].join("\n");
  }

  return [
    `You said: ${text}`,
    "",
    "I am the scripted demo model, so I only know about four books. Anything you type is shown as text, never run: try sending `<script>alert(1)</script>` or a made-up `<admin-panel>` tag.",
    "",
    "# Things to try",
    "- Ask for a recommendation",
    "- Ask me to compare the books",
    "- Let me help you choose",
    "- Ask for a diagram of how I pick a book",
    "- Ask me to hold a copy of a book",
    "- Ask whether the shop is open now",
    "",
    `<ask-button say="Recommend a book">Recommend a book</ask-button>`,
    `<ask-button say="Add a book to my reading log">Open the reading log form</ask-button>`,
  ].join("\n");
}

export const demoModel: Model = scriptedModel(
  (request) => {
    const last = request.messages.at(-1);
    return last?.role === "assistant"
      ? afterTool(last)
      : reply(last?.content ?? "");
  },
  { chunkSize: 6, delayMs: Number(process.env.DEMO_MODEL_DELAY_MS ?? 14) },
);
