/**
 * The bookshop's one tool that changes something: it holds a copy at the
 * front desk. A hold is the shop's to keep, so the reader has to allow it
 * before it runs (`approval: true`).
 */
import type { Tool } from "@bascik/genui";
import { BOOKS, findBook } from "./books.ts";

/** A hold number that is the same for the same title, so tests can name it. */
const holdNumber = (title: string): string => {
  let sum = 0;
  for (const character of title)
    sum = (sum * 31 + character.charCodeAt(0)) % 9000;
  return `H-${1000 + sum}`;
};

/** The shop's hours, in the reader's own local time: it is a neighborhood shop. */
export const OPENS = 9;
export const CLOSES = 18;

export const bookTools: Tool[] = [
  {
    name: "list_books",
    description:
      "List the books this shop stocks, as JSON: title, author, rating, pages, year, mood, and a one-sentence blurb. Recommend only books from this list.",
    inputSchema: { type: "object", properties: {} },
    note: () => `<tool-note>Checked the shelves</tool-note>`,
    run: () => JSON.stringify(BOOKS),
  },
  {
    name: "local_time",
    description:
      "Ask the reader's browser for their local time and time zone, as text such as `14:55 Europe/Lisbon`. Use it before saying whether the shop is open now. The shop is open 9:00 to 18:00.",
    inputSchema: { type: "object", properties: {} },
    // No `run`: the page draws this call as a form, and a script in it, or
    // the reader, sends the answer to /api/result.
    client: true,
    note: () => `<tool-note>Checked your local time</tool-note>`,
  },
  {
    name: "place_hold",
    description:
      "Hold one copy of a book at the front desk for three days. Give the exact title. The reader is asked to allow it first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The book's exact title" },
      },
      required: ["title"],
    },
    approval: true,
    note: (input) =>
      `<tool-note>Holding a copy of ${String(input.title).replace(/[<>]/g, "")}</tool-note>`,
    run: (input) => {
      const book = findBook(String(input.title));
      if (!book) throw new Error(`The shop has no book titled ${input.title}.`);
      return `A copy of ${book.title} is held at the front desk for three days. Hold number ${holdNumber(book.title)}.`;
    },
  },
];
