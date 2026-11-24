/**
 * The apps this site serves. Each is the same chat shell with its own
 * instructions, tools, and offline stand-in for the model.
 */
import type { Model, Tool } from "@bascik/genui";
import { scriptedModel } from "@bascik/genui";
import { dataTools, runSql, SCHEMA } from "./data-tools.ts";
import { demoModel } from "./demo-model.ts";
import { docsTools, searchDocs } from "./docs-tools.ts";

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

const TABLE = ["table", "thead", "tbody", "tr", "th", "td"];
const delayMs = Number(process.env.DEMO_MODEL_DELAY_MS ?? 14);

/** Text placed in a double-quoted attribute of the model's output format. */
const attribute = (value: unknown): string =>
  String(value).replace(/"/g, "'").replace(/\s+/g, " ");

/* ---- Docs: keyword search when offline ---- */

const docsOffline: Model = async function* (request) {
  const question = request.messages.at(-1)?.content ?? "";
  const hits = await searchDocs(question);
  const text =
    hits.length === 0
      ? "No model is connected, so I can only search the docs by keyword, and nothing matched. Try the words a docs page would use."
      : [
          "No model is connected, so this is a keyword search of the docs, not a written answer. The closest sections:",
          "",
          ...hits.map(
            (hit) =>
              `<doc-link title="${attribute(hit.section ? `${hit.title}: ${hit.section}` : hit.title)}" href="${attribute(hit.url)}">${hit.snippet}</doc-link>`,
          ),
        ].join("\n");
  yield* scriptedModel(() => text, { chunkSize: 24, delayMs })(request);
};

/* ---- Data: a few canned questions when offline ---- */

const money = (value: unknown): string =>
  `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

function table(columns: string[], rows: unknown[][]): string {
  return [
    "<table>",
    `<thead><tr>${columns.map((column) => `<th>${column}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...rows.map(
      (row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`,
    ),
    "</tbody>",
    "</table>",
  ].join("\n");
}

function chart(
  title: string,
  rows: unknown[][],
  label: number,
  value: number,
): string {
  const max = Math.max(...rows.map((row) => Number(row[value])));
  return [
    `<bar-chart title="${attribute(title)}">`,
    ...rows.map(
      (row) =>
        `<bar-row label="${attribute(row[label])}" value="${Math.round(Number(row[value]))}" max="${Math.round(max)}" />`,
    ),
    "</bar-chart>",
  ].join("\n");
}

const CANNED: {
  match: RegExp;
  sql: string;
  write: (rows: unknown[][]) => string;
}[] = [
  {
    match: /top|best|seller|popular/,
    sql: "SELECT b.title, b.author, SUM(o.quantity) AS units, ROUND(SUM(o.quantity * b.price)) AS revenue FROM orders o JOIN books b ON b.id = o.book_id GROUP BY b.id ORDER BY units DESC LIMIT 8",
    write: (rows) =>
      [
        `**${rows[0]![0]}** leads with ${rows[0]![2]} copies sold.`,
        "",
        chart("Copies sold, top 8 books", rows, 0, 2),
        "",
        table(
          ["Title", "Author", "Units", "Revenue"],
          rows.map((row) => [row[0], row[1], row[2], money(row[3])]),
        ),
      ].join("\n"),
  },
  {
    match: /month|trend|over time|growth/,
    sql: "SELECT substr(o.ordered_on, 1, 7) AS month, ROUND(SUM(o.quantity * b.price)) AS revenue, COUNT(*) AS orders FROM orders o JOIN books b ON b.id = o.book_id GROUP BY month ORDER BY month",
    write: (rows) =>
      [
        `Revenue grew from ${money(rows[0]![1])} in ${rows[0]![0]} to ${money(rows.at(-1)![1])} in ${rows.at(-1)![0]}.`,
        "",
        chart("Revenue by month", rows, 0, 1),
      ].join("\n"),
  },
  {
    match: /region|channel|where/,
    sql: "SELECT o.region, o.channel, ROUND(SUM(o.quantity * b.price)) AS revenue, COUNT(*) AS orders FROM orders o JOIN books b ON b.id = o.book_id GROUP BY o.region, o.channel ORDER BY revenue DESC",
    write: (rows) =>
      [
        "Revenue by region and sales channel, highest first.",
        "",
        table(
          ["Region", "Channel", "Revenue", "Orders"],
          rows.map((row) => [row[0], row[1], money(row[2]), row[3]]),
        ),
      ].join("\n"),
  },
  {
    match: /genre|category/,
    sql: "SELECT b.genre, COUNT(DISTINCT b.id) AS titles, SUM(o.quantity) AS units, ROUND(SUM(o.quantity * b.price)) AS revenue FROM orders o JOIN books b ON b.id = o.book_id GROUP BY b.genre ORDER BY revenue DESC",
    write: (rows) =>
      [
        "<card-grid>",
        ...rows.map(
          (row) =>
            `<stat-tile label="${attribute(row[0])}" value="${money(row[3])}">${row[2]} copies, ${row[1]} titles</stat-tile>`,
        ),
        "</card-grid>",
        "",
        chart("Revenue by genre", rows, 0, 3),
      ].join("\n"),
  },
];

const dataOffline: Model = scriptedModel(
  (request) => {
    const question = (request.messages.at(-1)?.content ?? "").toLowerCase();
    const canned = CANNED.find((entry) => entry.match.test(question));
    if (!canned) {
      return [
        "No model is connected, so I can only answer a few fixed questions. The queries and the numbers are real.",
        "",
        `<ask-button say="What are the top selling books?">Top sellers</ask-button>`,
        `<ask-button say="Show revenue by month">Revenue by month</ask-button>`,
        `<ask-button say="Break revenue down by region and channel">By region</ask-button>`,
        `<ask-button say="Compare genres">By genre</ask-button>`,
      ].join("\n");
    }
    const result = runSql(canned.sql);
    return [
      "<tool-note>Querying the database</tool-note>",
      canned.write(result.rows),
      "",
      "```sql",
      canned.sql,
      "```",
    ].join("\n");
  },
  { chunkSize: 24, delayMs },
);

export const APPS: ChatApp[] = [
  {
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
    ],
    instructions:
      "You are a reading assistant for a small bookshop. Be brief and concrete.",
    tools: [],
    elements: [],
    offline: demoModel,
  },
  {
    id: "docs",
    path: "/docs",
    name: "Ask the docs",
    heading: "Ask the Bascik docs",
    tagline:
      "Answers from the documentation, with links to the pages they came from.",
    suggestions: [
      {
        label: "Stream a slow list",
        say: "How do I stream rows from a slow source?",
      },
      {
        label: "Scoped CSS",
        say: "How does CSS scoping work without Shadow DOM?",
      },
      { label: "Deploy to Cloudflare", say: "How do I deploy to Cloudflare?" },
    ],
    instructions: [
      "You answer questions about Bascik, a build tool for HTML components, using its documentation.",
      "Always search the docs first, and read a page before you quote code or details from it. Answer only from what you found; if the docs do not cover it, say so.",
      "Keep answers short. Show code in fences. Use step-list for procedures and note-box for a warning or limit. End with one doc-link per page you used, so the reader can check the source.",
    ].join("\n"),
    tools: docsTools,
    elements: ["ul", "ol", "li", ...TABLE],
    offline: docsOffline,
  },
  {
    id: "data",
    path: "/data",
    name: "Sales analyst",
    heading: "Ask the bookshop's sales data",
    tagline:
      "Questions become SQL, and the results come back as tables and charts.",
    suggestions: [
      { label: "Top sellers", say: "What are the top selling books?" },
      { label: "Revenue by month", say: "Show revenue by month" },
      { label: "By genre", say: "Compare genres" },
    ],
    instructions: [
      "You are a data analyst for a bookshop. Answer questions by querying the database with run_sql, then present the result.",
      "Lead with the answer in one sentence. Use a bar-chart to compare up to about twelve values, a table for detail, and stat-tile for headline numbers. Format money with a $ and no cents. Never invent a number: every figure comes from a query result.",
      "After the answer, show the SQL you ran in a fence.",
    ].join("\n"),
    tools: dataTools,
    elements: TABLE,
    offline: dataOffline,
  },
];

export { SCHEMA };
