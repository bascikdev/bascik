/**
 * This project's chat. The parts on the page read its default export
 * (chat-turns, chat-find, chat-conversations), and each file in src/api is
 * one of its handlers. Everything a project chooses is here: where
 * conversations are kept, which components the model may write, which model
 * answers, and what an empty conversation says.
 */
import { join } from "node:path";
import { readCatalog, scriptedModel } from "@bascik/ai";
import { createChat, fileStore, type ChatProject } from "@bascik/ai/app";
import { diskFiles } from "@bascik/ai/files";

/** Conversations and attached files, in a folder beside the project. */
const DATA_DIR = join(process.cwd(), ".data");

/**
 * The components the model may write. In a project that ran
 * `npx bascik add @bascik/ai` this is `src/components/catalog`.
 */
const CATALOG_DIR = join(process.cwd(), "..", "..", "components", "catalog");

/**
 * A stand-in for a model, so the project runs with no key: it writes the
 * same reply to every message, in the model's output format. Replace it with
 * a real one, such as `anthropicModel({ model: "claude-sonnet-5-5" })` from
 * `@bascik/ai/anthropic`.
 */
const model = scriptedModel(
  (request) =>
    [
      `You said: “${request.messages.at(-1)?.content ?? ""}”. No model is connected yet, so this reply is a script. A real model writes components the same way:`,
      "",
      "<card-grid>",
      '<stat-tile label="Refactoring the Monolith" value="4.7">Grace Lin</stat-tile>',
      '<stat-tile label="Practical Type Systems" value="4.5">Ada Okafor</stat-tile>',
      '<stat-tile label="Shipping Small Changes" value="4.8">Sam Rivera</stat-tile>',
      "</card-grid>",
      "",
      '<ask-button say="Which of these is the shortest?">Which is the shortest?</ask-button>',
    ].join("\n"),
  { delayMs: Number(process.env.STARTER_MODEL_DELAY_MS ?? 12) },
);

const chat = createChat({
  store: fileStore(join(DATA_DIR, "conversations")),
  files: diskFiles(join(DATA_DIR, "files")),
  catalog: () => readCatalog(CATALOG_DIR),
  model: () => model,
  system: "You are a bookshop assistant. Keep answers short.",
});

export default {
  chat,
  welcome: {
    heading: "What are you reading next?",
    tagline: "Ask for a book, or start with one of these.",
    suggestions: [
      { label: "Recommend a book", say: "Recommend a book" },
      { label: "Something short", say: "Recommend a short book" },
    ],
  },
} satisfies ChatProject;
