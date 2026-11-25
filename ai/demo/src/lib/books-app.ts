/**
 * The bookshop app, built with no environment or file-system reads, so any
 * runtime (the Node demo, a Worker) can import it. The caller passes the
 * offline model's delay.
 */
import type { Model, Tool } from "@bascik/ai";
import { bookTools } from "./book-tools.ts";
import { demoModel } from "./demo-model.ts";

export interface ChatApp {
  id: string;
  /** The page that serves it. */
  path: string;
  name: string;
  heading: string;
  tagline: string;
  suggestions: { label: string; say: string }[];
  /** What the model is told, before the catalog. */
  instructions: string;
  tools: Tool[];
  /** Plain HTML elements the model may write besides the catalog. */
  elements: string[];
  /** Answers when no API key is set. Deterministic, so tests can rely on it. */
  offline: Model;
}

export function booksApp(options: { delayMs: number }): ChatApp {
  return {
    id: "books",
    path: "/",
    name: "Bookshop",
    heading: "What are you reading next?",
    tagline: "A shop assistant that answers with cards, charts, and forms.",
    suggestions: [
      { label: "Recommend a book", say: "Recommend a book" },
      {
        label: "Compare the books",
        say: "Compare the page counts of every book",
      },
      { label: "Help me choose", say: "Help me choose a book" },
      {
        label: "Swipe a shortlist",
        say: "Swipe through the books for a shortlist",
      },
    ],
    instructions:
      "You are a reading assistant for a small bookshop. Be brief and concrete. Call list_books before recommending, and recommend only books the shop stocks. When the reader wants a copy kept for them, call place_hold; say first, in one sentence, what you are about to hold.",
    tools: bookTools,
    elements: [],
    offline: demoModel({ delayMs: options.delayMs }),
  };
}
