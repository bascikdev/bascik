/**
 * Everything the chat page and its API routes share: the conversation store,
 * the catalog, and the model.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  catalogPrompt,
  readCatalog,
  type Catalog,
  type ChatMessage,
  type Model,
} from "@bascik/genui";
import { demoModel } from "./demo-model.ts";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

/* ---- Store: one JSON file per conversation. Swap for a database. ---- */

const DATA_DIR = join(process.cwd(), ".data", "conversations");
const ID = /^[0-9a-f-]{36}$/;

export async function loadConversation(
  id: string | undefined,
): Promise<Conversation | null> {
  if (!id || !ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(join(DATA_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function saveConversation(
  conversation: Conversation,
): Promise<void> {
  conversation.updatedAt = Date.now();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    join(DATA_DIR, `${conversation.id}.json`),
    JSON.stringify(conversation),
  );
}

export const newConversation = (): Conversation => ({
  id: randomUUID(),
  title: "New chat",
  updatedAt: Date.now(),
  messages: [],
});

export async function listConversations(): Promise<Conversation[]> {
  let files: string[];
  try {
    files = await readdir(DATA_DIR);
  } catch {
    return [];
  }
  const all = await Promise.all(
    files.map((file) => loadConversation(file.replace(/\.json$/, ""))),
  );
  return all
    .filter((entry): entry is Conversation => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ---- The current conversation is named by a cookie. ---- */

const COOKIE = "chat";

export function currentId(request: Request): string | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  return new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f-]{36})`).exec(cookies)?.[1];
}

/** A 303 back to the chat page, so a form POST ends in a GET (and reload is safe). */
export function backToChat(request: Request, id: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/", request.url).pathname,
      "set-cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
}

/* ---- Catalog and model ---- */

let catalog: Promise<Catalog> | undefined;

/** The components the model may write: everything in src/genui. */
export const loadCatalog = (): Promise<Catalog> =>
  (catalog ??= readCatalog(join(process.cwd(), "src", "genui")));

export async function systemPrompt(): Promise<string> {
  return [
    "You are a reading assistant for a small bookshop. Be brief and concrete.",
    "",
    catalogPrompt(await loadCatalog()),
  ].join("\n");
}

/** Claude when a key is set, the offline scripted model otherwise. */
export async function loadModel(): Promise<Model> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    const { anthropicModel } = await import("@bascik/genui/anthropic");
    return anthropicModel();
  }
  return demoModel;
}
