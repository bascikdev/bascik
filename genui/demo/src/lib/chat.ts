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
import { APPS, type ChatApp } from "./apps.ts";
import { listModels, modelFor, pickModel, requestedModel } from "./models.ts";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

/* ---- Who is asking, and about what ---- */

const byPath = (pathname: string): ChatApp | undefined => {
  const path = pathname.replace(/\/$/, "") || "/";
  return APPS.find((app) => app.path === path);
};

/**
 * A page request names its app by its own path. A form post names it in an
 * `app` field, or, for a form the model generated, by the page it was sent
 * from.
 */
function appFor(request: Request, named?: string): ChatApp {
  const fromField = APPS.find((app) => app.id === named);
  if (fromField) return fromField;
  const own = byPath(new URL(request.url).pathname);
  if (own) return own;
  const referer = request.headers.get("referer");
  if (referer && URL.canParse(referer)) {
    const from = byPath(new URL(referer).pathname);
    if (from) return from;
  }
  return APPS[0]!;
}

const ID = /^[0-9a-f-]{36}$/;
const cookie = (request: Request, name: string): string | undefined =>
  new RegExp(`(?:^|;\\s*)${name}=([0-9a-f-]{36})(?:;|$)`).exec(
    request.headers.get("cookie") ?? "",
  )?.[1];

/**
 * One request's place in the app: which app, which visitor, and which of that
 * visitor's conversations is open. A visitor is an anonymous cookie, so
 * people never see each other's conversations. Swap it for your sign-in.
 */
export interface Session {
  app: ChatApp;
  visitor: string;
  conversationId: string | undefined;
}

export function sessionFor(request: Request, named?: string): Session {
  const app = appFor(request, named);
  return {
    app,
    visitor: cookie(request, "visitor") ?? randomUUID(),
    conversationId: cookie(request, `chat_${app.id}`),
  };
}

/* ---- Store: one JSON file per conversation. Swap for a database. ---- */

const DATA_DIR = join(process.cwd(), ".data");
const folderFor = (session: Session): string =>
  join(DATA_DIR, session.app.id, session.visitor);

export async function loadConversation(
  session: Session,
  id: string | undefined = session.conversationId,
): Promise<Conversation | null> {
  if (!id || !ID.test(id)) return null;
  try {
    return JSON.parse(
      await readFile(join(folderFor(session), `${id}.json`), "utf8"),
    );
  } catch {
    return null;
  }
}

export async function saveConversation(
  session: Session,
  conversation: Conversation,
): Promise<void> {
  conversation.updatedAt = Date.now();
  await mkdir(folderFor(session), { recursive: true });
  await writeFile(
    join(folderFor(session), `${conversation.id}.json`),
    JSON.stringify(conversation),
  );
}

export const newConversation = (): Conversation => ({
  id: randomUUID(),
  title: "New chat",
  updatedAt: Date.now(),
  messages: [],
});

/** The visitor's own conversations in this app, newest first. */
export async function listConversations(
  session: Session,
): Promise<Conversation[]> {
  let files: string[];
  try {
    files = await readdir(folderFor(session));
  } catch {
    return [];
  }
  const all = await Promise.all(
    files.map((file) => loadConversation(session, file.replace(/\.json$/, ""))),
  );
  return all
    .filter((entry): entry is Conversation => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A 303 back to the app's page, so a form POST ends in a GET (and reload is safe). */
export function backToChat(session: Session, id: string): Response {
  const headers = new Headers({ location: session.app.path });
  const attributes = "Path=/; HttpOnly; SameSite=Lax";
  headers.append("set-cookie", `chat_${session.app.id}=${id}; ${attributes}`);
  headers.append(
    "set-cookie",
    `visitor=${session.visitor}; Max-Age=31536000; ${attributes}`,
  );
  return new Response(null, { status: 303, headers });
}

/* ---- Catalog and model ---- */

let catalog: Promise<Catalog> | undefined;

/** The components a model may write: everything in src/genui. */
export const loadCatalog = (): Promise<Catalog> =>
  (catalog ??= readCatalog(join(import.meta.dirname, "..", "genui")));

export async function systemPrompt(app: ChatApp): Promise<string> {
  return [
    app.instructions,
    "",
    catalogPrompt(await loadCatalog(), { elements: app.elements }),
  ].join("\n");
}

/** The model the visitor picked, from what this server offers (lib/models.ts). */
export async function loadModel(
  app: ChatApp,
  request: Request,
): Promise<Model> {
  const choice = pickModel(await listModels(), requestedModel(request));
  return modelFor(choice, app);
}
