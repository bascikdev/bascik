/**
 * The model used when no API key is set: it answers from a script, so the
 * demo runs offline and its tests are deterministic. It writes exactly what a
 * real model would be asked to write: prose plus catalog tags.
 */
import {
  filesOf,
  scriptedModel,
  type FilePart,
  type ChatMessage,
  type Model,
  type ModelEvent,
  type ToolPart,
} from "@bascik/ai";
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
  if (call?.name === "remember") {
    return call.state === "done"
      ? [
          "Got it, I will remember that. You can see everything I keep, and remove any of it, under **What I remember** in the sidebar.",
          "",
          `<ask-button say="What do you know about me?">What do you know about me?</ask-button>`,
        ].join("\n")
      : "I could not save that, so I will not remember it. Say it again in a short sentence and I will try once more.";
  }
  if (call?.name === "recall") {
    const found =
      call.state === "done"
        ? ((
            JSON.parse(call.output ?? "{}") as { memories?: { text: string }[] }
          ).memories ?? [])
        : [];
    return found.length === 0
      ? [
          "I do not know anything about you yet. Tell me something to remember, such as that you prefer short books.",
          "",
          `<ask-button say="Remember that I prefer short books">Remember that I prefer short books</ask-button>`,
        ].join("\n")
      : [
          "This is what I remember about you:",
          "",
          ...found.map((memory) => `- ${memory.text}`),
          "",
          `<ask-button say="Recommend a book">Recommend a book</ask-button>`,
        ].join("\n");
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

/**
 * What the offline model says to attached files: each one by name and type.
 * A real model is sent the files themselves (see the adapters); this one only
 * reads what the message says about them, so a test can tell they arrived.
 */
function acknowledge(files: FilePart[], text: string): string {
  return [
    `I received ${files.length} file${files.length === 1 ? "" : "s"}:`,
    "",
    ...files.map(
      (file) => `- ${file.name.replace(/[`<>]/g, "'")} (${file.mediaType})`,
    ),
    "",
    text ? `You said: ${text.replace(/[<>]/g, "")}` : "",
  ].join("\n");
}

/** The page the offline model writes when asked for a reading timer. */
const TIMER_PAGE = `<h1 style="font-size:1.1rem;margin:0 0 8px">Reading timer</h1>
<p id="clock" style="font-size:2.5rem;margin:0" data-testid="timer-clock">25:00</p>
<p>
  <button id="start" data-testid="timer-start">Start</button>
  <button id="log" data-testid="timer-log">Log my reading</button>
</p>
<script>
  let left = 25 * 60;
  let tick = null;
  const clock = document.getElementById("clock");
  const show = () => {
    const m = String(Math.floor(left / 60)).padStart(2, "0");
    const s = String(left % 60).padStart(2, "0");
    clock.textContent = m + ":" + s;
  };
  document.getElementById("start").addEventListener("click", (event) => {
    if (tick) {
      clearInterval(tick);
      tick = null;
      event.target.textContent = "Start";
      return;
    }
    event.target.textContent = "Pause";
    tick = setInterval(() => {
      left = Math.max(0, left - 1);
      show();
    }, 1000);
  });
  document.getElementById("log").addEventListener("click", () => {
    const minutes = Math.max(1, Math.round((25 * 60 - left) / 60));
    bascik.suggest("Log " + minutes + (minutes === 1 ? " minute" : " minutes") + " of reading");
  });
</script>`;

/**
 * What a swipe deck of the shop's books sent: one "Title: yes" or "Title: no"
 * line per card. Null for any other message.
 */
function swiped(text: string): { kept: Book[]; skipped: Book[] } | null {
  const lines = text.split("\n").filter((line) => line.trim());
  const kept: Book[] = [];
  const skipped: Book[] = [];
  for (const line of lines) {
    const match = /^(.+): (yes|no)$/.exec(line.trim());
    const book = match && BOOKS.find((entry) => entry.title === match[1]);
    if (!book) return null;
    (match[2] === "yes" ? kept : skipped).push(book);
  }
  return lines.length > 0 ? { kept, skipped } : null;
}

function reply(text: string): string | ModelEvent[] {
  const asked = text.toLowerCase();
  const book = findBook(text);

  const deck = swiped(text);
  if (deck) {
    if (deck.kept.length === 0) {
      return [
        "None of them, then. Tell me what you are in the mood for and I will look again.",
        "",
        `<ask-button say="Help me choose a book">Help me choose</ask-button>`,
      ].join("\n");
    }
    const best = [...deck.kept].sort(
      (a, b) => Number(b.rating) - Number(a.rating),
    )[0]!;
    return [
      `Your shortlist has ${deck.kept.length} of ${BOOKS.length} books. The best rated of them is **${best.title}**.`,
      "",
      grid(deck.kept),
      "",
      `<ask-button say="Tell me more about ${best.title}">Tell me about ${best.title}</ask-button>`,
    ].join("\n");
  }

  if (/\btimer\b/.test(asked)) {
    return [
      "No component in the catalog is a timer, so this one is a small page of its own. It runs in a sandboxed frame: it cannot reach the network or this page, only put a message in your message box.",
      "",
      "```html-app",
      TIMER_PAGE,
      "```",
    ].join("\n");
  }

  if (/\b(swipe|shortlist)\b/.test(asked)) {
    return [
      "Swipe right on a book you would read, left on one you would not.",
      "",
      `<swipe-deck question="Would you read it?" yes="Keep" no="Skip">`,
      ...BOOKS.map(
        (entry) =>
          `<swipe-card title="${entry.title}">${entry.author}. ${entry.blurb}</swipe-card>`,
      ),
      `</swipe-deck>`,
    ].join("\n");
  }

  if (/\bwhat do you (know|remember)\b|\babout me\b/.test(asked)) {
    return [
      "Let me look at what I have kept about you.",
      { type: "tool-call", name: "recall", input: { query: "" } },
    ];
  }

  const remembered =
    /^\s*(?:please\s+)?remember\b[\s,:]*(?:that\b)?[\s,:]*(.+)$/is.exec(
      text,
    )?.[1];
  if (remembered) {
    return [
      "That sounds like something worth keeping, so I am saving it to your memory.",
      {
        type: "tool-call",
        name: "remember",
        input: { text: remembered.trim().replace(/[.!\s]+$/, "") },
      },
    ];
  }

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
    "- Ask me to remember something about you, then ask what I know",
    "",
    `<ask-button say="Recommend a book">Recommend a book</ask-button>`,
    `<ask-button say="Add a book to my reading log">Open the reading log form</ask-button>`,
  ].join("\n");
}

/**
 * The bookshop's offline model. `delayMs` is the pause between chunks; the
 * caller reads it from wherever it runs (the Node demo reads
 * `DEMO_MODEL_DELAY_MS` in apps.ts), so this module reads no environment.
 */
export const demoModel = ({ delayMs }: { delayMs: number }): Model =>
  scriptedModel(
    (request) => {
      const last = request.messages.at(-1);
      const files = last?.role === "user" ? filesOf(last) : [];
      if (files.length) return acknowledge(files, last?.content ?? "");
      return last?.role === "assistant"
        ? afterTool(last)
        : reply(last?.content ?? "");
    },
    { chunkSize: 6, delayMs },
  );
