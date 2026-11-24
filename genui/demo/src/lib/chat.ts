/**
 * Everything the chat page and its API routes share: the conversation store,
 * the catalog, and the model.
 */
import { randomUUID } from "node:crypto";
import { html, type SafeHtml } from "@bascik/bascik/html";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  abandonToolCalls,
  catalogPrompt,
  createBroadcast,
  readCatalog,
  renderTurn,
  runTurn,
  turnPending,
  type Broadcast,
  type Catalog,
  type ChatMessage,
  type Model,
  type ToolPart,
  type TurnRenderOptions,
} from "@bascik/genui";
import { MERMAID_PROMPT, mermaidFence } from "@bascik/genui/mermaid";
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

/* ---- Live turns: a reply is written once, whoever is watching ---- */

/**
 * A reply being written. It belongs to the conversation, not to the request
 * that started it: the page that asked, a reload of it, and a second tab all
 * read the same `html` from its start, and the reply is finished and stored
 * even when the reader has left. Only Stop, or the time limit, ends it early.
 *
 * This is one process's memory. With several servers, a reader who lands on
 * another one mid-reply starts a second reply; put the broadcast in a shared
 * store to fix that.
 */
export interface LiveTurn {
  /** The conversation as it was when the turn started: what a page shows above the reply. */
  messages: Conversation["messages"];
  html: Broadcast<string>;
  stop: AbortController;
  /** Settles once the turn's message is stored. */
  over: Promise<void>;
}

const live = new Map<string, LiveTurn>();
/** The longest one reply may take, tools included. */
const TURN_LIMIT_MS = 120_000;

function startTurn(
  session: Session,
  conversation: Conversation,
  request: Request,
): LiveTurn {
  const { app } = session;
  const html = createBroadcast<string>();
  const stop = new AbortController();
  const messages = conversation.messages;
  const carriedOn = messages.at(-1)!.role === "assistant";
  const write = async (): Promise<void> => {
    const turn = runTurn({
      // The model the visitor who started this reply has picked.
      model: await loadModel(app, request),
      system: await systemPrompt(app),
      messages,
      tools: app.tools,
      signal: AbortSignal.any([
        stop.signal,
        AbortSignal.timeout(TURN_LIMIT_MS),
      ]),
    });
    const { message } = turn;
    try {
      for await (const chunk of renderTurn(
        turn.events,
        await loadCatalog(),
        renderOptions(app),
      )) {
        html.push(chunk);
      }
    } catch (error) {
      console.error(`[${app.id}] the model failed:`, error);
      const sorry = "Something went wrong while writing this reply.";
      message.parts!.push({ type: "text", text: `\n\n${sorry}` });
      message.content = `${message.content}\n\n${sorry}`.trim();
      html.push(`<p class="failed" data-testid="turn-failed">${sorry}</p>`);
    } finally {
      if (message.parts!.length === 0) {
        delete message.parts;
        message.content = "(no reply)";
      }
      // Read the conversation again: the reader may have sent something else
      // while this was being written, and that must not be lost.
      const latest =
        (await loadConversation(session, conversation.id)) ?? conversation;
      const at = messages.length - (carriedOn ? 1 : 0);
      latest.messages.splice(at, carriedOn ? 1 : 0, message);
      await saveConversation(session, latest);
    }
  };
  const entry: LiveTurn = {
    messages,
    html,
    stop,
    over: write()
      .catch((error: unknown) => {
        console.error(`[${app.id}] the reply could not be stored:`, error);
      })
      .finally(() => {
        if (live.get(conversation.id) === entry) live.delete(conversation.id);
        html.end();
      }),
  };
  live.set(conversation.id, entry);
  return entry;
}

/** What one page request shows: the stored conversation, and the reply being written, if any. */
export interface ThreadState {
  session: Session;
  messages: Conversation["messages"];
  turn: LiveTurn | undefined;
}

const states = new WeakMap<Request, Promise<ThreadState>>();

/**
 * The thread's two stream scripts both call this, and get one answer per
 * request. When a reply is already being written for the conversation, the
 * page joins it; when the conversation is waiting for one, this starts it.
 */
export function threadState(request: Request): Promise<ThreadState> {
  let state = states.get(request);
  if (!state) {
    state = (async () => {
      const session = sessionFor(request);
      let conversation = await loadConversation(session);
      let turn = conversation && live.get(conversation.id);
      if (conversation && !turn && turnPending(conversation.messages)) {
        // No reply is being written right now, so the store is settled: read
        // it once more, and start the turn with nothing awaited in between.
        conversation = (await loadConversation(session)) ?? conversation;
        turn = live.get(conversation.id);
        if (!turn && turnPending(conversation.messages)) {
          turn = startTurn(session, conversation, request);
        }
      }
      return {
        session,
        messages: turn?.messages ?? conversation?.messages ?? [],
        turn: turn ?? undefined,
      };
    })();
    states.set(request, state);
  }
  return state;
}

/** Stop the conversation's reply, and wait until what it wrote is stored. */
export async function stopTurn(conversationId: string): Promise<boolean> {
  const entry = live.get(conversationId);
  if (!entry) return false;
  entry.stop.abort();
  await entry.over;
  return true;
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
  (catalog ??= readCatalog([
    // The catalog the package brings. A project that ran
    // `bascik add @bascik/genui` has it at src/components/catalog instead.
    join(import.meta.dirname, "..", "..", "..", "components", "catalog"),
    // This demo's own: books, review forms, diagrams.
    join(import.meta.dirname, "..", "genui"),
  ]));

/** One renderer for every reply, so a diagram is drawn once and remembered. */
const mermaid = mermaidFence();

/** `place_hold` as "Place hold": what a tool call is called on the page. */
const actionName = (part: ToolPart): string => {
  const words = part.name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * How a tool call looks in each state. A call that waits for the reader is
 * an approval card; one that was refused or failed is a line that says so.
 * A call that is running or done is shown as its tool's own note (null).
 */
function toolView(app: ChatApp, part: ToolPart): SafeHtml | null {
  switch (part.state) {
    case "approval-requested":
      return html`<tool-approval
        data-bascik-prop-app="${app.id}"
        data-bascik-prop-call="${part.id}"
        data-bascik-prop-action="${actionName(part)}"
        >${Object.entries(part.input).map(
          ([name, value]) =>
            html`<dt>${name}</dt>
              <dd>${String(value)}</dd>`,
        )}</tool-approval
      >`;
    case "client-requested":
      // A client tool is drawn by the component that can answer it.
      return part.name === "local_time"
        ? html`<client-local-time
            data-bascik-prop-app="${app.id}"
            data-bascik-prop-call="${part.id}"
          ></client-local-time>`
        : null;
    case "denied":
      return html`<tool-status
        >You did not allow: ${actionName(part)}</tool-status
      >`;
    case "failed":
      return html`<tool-status
        >${actionName(part)} failed: ${part.error ?? ""}</tool-status
      >`;
    default:
      return null;
  }
}

/**
 * How an app's replies are rendered, live and from history: the HTML
 * elements it may pass through, ```mermaid fences drawn as diagrams, and its
 * tool calls.
 */
export const renderOptions = (app: ChatApp): TurnRenderOptions => ({
  elements: app.elements,
  fences: { mermaid },
  tools: app.tools,
  view: (part) => toolView(app, part),
});

/**
 * The reader moved on without answering an approval card or a client tool:
 * the calls that were waiting are refused.
 */
export const abandonApprovals = (conversation: Conversation): void =>
  abandonToolCalls(conversation.messages);

export async function systemPrompt(app: ChatApp): Promise<string> {
  return [
    app.instructions,
    "",
    catalogPrompt(await loadCatalog(), {
      elements: app.elements,
      fences: { mermaid: MERMAID_PROMPT },
    }),
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
