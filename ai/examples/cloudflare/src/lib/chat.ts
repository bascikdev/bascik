/**
 * The books chat on Workers: the demo's bookshop app (ai/demo/src/lib/
 * books-app.ts) over this example's Durable Objects. Nothing here reads the
 * file system or `process.env`: bindings and vars come from the platform
 * context Bascik hands each route and stream script, and the catalog was
 * written at build time.
 *
 * `chatFor(env)` makes one chat per isolate. The env object is the same for
 * every request to one deployment, and the chat keeps only namespace
 * bindings from it, never a stub (see cf-stores.ts).
 */
import { html, type SafeHtml } from "@bascik/bascik/html";
import type { Catalog, ToolPart } from "@bascik/ai";
import {
  cookieSessions,
  createChat,
  type Chat,
  type ChatProject,
  type ChatSessions,
  type HostContext,
} from "@bascik/ai/app";
import { savedMemory } from "@bascik/ai/memory";
import {
  SANDBOX_LANGUAGE,
  SANDBOX_PROMPT,
  sandboxFence,
} from "@bascik/ai/sandbox";
import { booksApp } from "../../../../demo/src/lib/books-app.ts";
import { CATALOG_ENTRIES } from "./catalog.generated.ts";
import { liveShared, readerStores } from "./cf-stores.ts";
import { DEMO_FULL, numberVar, type Env, type RequestContext } from "./env.ts";
import { refusal, type Handler } from "./limits.ts";

/** The app's id: its cookie, its forms' `app` field, and its shared keys. */
export const APP_ID = "books";

/** The model's pace when `DEMO_MODEL_DELAY_MS` is not set. */
const DELAY_MS = 20;

/** What a reader may attach: two small files a message. */
export const FILE_LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxFiles: 2,
  maxTotalBytes: 2 * 1024 * 1024,
  types: [
    "image/png",
    "image/jpeg",
    "image/webp",
    "text/plain",
    "text/markdown",
    "application/pdf",
  ],
} as const;

/** The app's words for the welcome: heading, tagline, suggestions. Its model is not used. */
const WELCOME = booksApp({ delayMs: 0 });

const catalog: Catalog = new Map(
  CATALOG_ENTRIES.map((entry) => [entry.name, entry]),
);

/** Whole pages the model writes in ```html-app fences, each in a sandboxed frame. */
const sandbox = sandboxFence();

/** `place_hold` as "Place hold": what a tool call is called on the page. */
const actionName = (part: ToolPart): string => {
  const words = part.name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * How a tool call looks in each state, as in the Node demo: a call that
 * waits for the reader is an approval card, a client tool is the form that
 * answers it, one that was refused or failed is a line that says so, and a
 * memory just saved is its words with an Undo button.
 */
function toolView(part: ToolPart): SafeHtml | null {
  switch (part.state) {
    case "approval-requested":
      return html`<tool-approval
        data-bascik-prop-app="${APP_ID}"
        data-bascik-prop-call="${part.id}"
        data-bascik-prop-action="${actionName(part)}"
        >${Object.entries(part.input).map(
          ([name, value]) =>
            html`<dt>${name}</dt>
              <dd>${String(value)}</dd>`,
        )}</tool-approval
      >`;
    case "client-requested":
      return part.name === "local_time"
        ? html`<client-local-time
            data-bascik-prop-app="${APP_ID}"
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
    case "done": {
      const saved = savedMemory(part);
      return saved
        ? html`<memory-note
            data-bascik-prop-app="${APP_ID}"
            data-bascik-prop-memory="${saved.id}"
            >${saved.text}</memory-note
          >`
        : null;
    }
    default:
      return null;
  }
}

function makeChat(env: Env): { chat: Chat; sessions: ChatSessions } {
  const app = booksApp({
    delayMs: numberVar(env.DEMO_MODEL_DELAY_MS, DELAY_MS),
  });
  const stores = readerStores(env.READER);
  const sessions = cookieSessions(APP_ID, {
    // The data is kept 24 hours, so the visitor cookie is too.
    maxAgeSeconds: 86_400,
    secure: env.GENUI_SECURE_COOKIES !== "0",
    ...(env.SESSION_SECRET ? { secret: env.SESSION_SECRET } : {}),
  });
  const chat = createChat({
    id: APP_ID,
    store: stores.conversations,
    memory: stores.memories,
    files: stores.files,
    fileLimits: { ...FILE_LIMITS, types: [...FILE_LIMITS.types] },
    shared: liveShared(env.LIVE, {
      development: env.GENUI_DEVELOPMENT === "1",
    }),
    // On Workers one request must never read another's streams or
    // promises: every follower goes through the ConversationLive object.
    followLocally: false,
    catalog,
    // The scripted bookshop model: there is no provider key anywhere.
    model: () => app.offline,
    tools: app.tools,
    memoryApproval: true,
    history: true,
    system: app.instructions,
    fencePrompts: { [SANDBOX_LANGUAGE]: SANDBOX_PROMPT },
    render: {
      elements: app.elements,
      fences: { [SANDBOX_LANGUAGE]: sandbox },
      view: toolView,
    },
    sessions,
    maxConversations: 20,
    maxConversationBytes: 256 * 1024,
    // A reply has to fit in the time the platform keeps a request's work
    // going after the reader leaves.
    turnLimitMs: 25_000,
    maxRounds: 4,
    page: app.path,
  });
  return { chat, sessions };
}

let made: { env: Env; chat: Chat; sessions: ChatSessions } | undefined;

function madeFor(env: Env): { chat: Chat; sessions: ChatSessions } {
  if (made?.env !== env) made = { env, ...makeChat(env) };
  return made;
}

/** The chat for this deployment's bindings: one per isolate. */
export function chatFor(env: Env): Chat {
  return madeFor(env).chat;
}

/**
 * Whether the request carries a visitor cookie this server issued (signed
 * with SESSION_SECRET when one is set). Without one, `identify` makes up a
 * new random reader on every call, so two calls disagree.
 */
export function knownReader(env: Env, request: Request): boolean {
  const { sessions } = madeFor(env);
  return (
    sessions.identify(request).reader === sessions.identify(request).reader
  );
}

/** The bindings in a request's context. Throws off Cloudflare. */
export function envOf(context: RequestContext | undefined): Env {
  const env = context?.platform?.env as Env | undefined;
  if (!env?.READER || !env.LIVE || !env.BUDGET) {
    throw new Error(
      "This example runs on Cloudflare Workers, with its Durable Object bindings: start it with `yarn ai:cf:dev`.",
    );
  }
  return env;
}

/** The host's context for the chat: `waitUntil`, so a reply outlives its page. */
export function hostOf(context: RequestContext | undefined): HostContext {
  const waitUntil = context?.platform?.waitUntil;
  return waitUntil ? { waitUntil } : {};
}

/** The chat and host context of one request. */
export function chatOf(context: RequestContext | undefined): {
  chat: Chat;
  host: HostContext;
} {
  return { chat: chatFor(envOf(context)), host: hostOf(context) };
}

/**
 * What the package's data parts read (chat-turns, chat-find,
 * chat-conversations, chat-memories): the chat for the request's bindings,
 * the platform's waitUntil, so a reply a page starts is finished and stored
 * after the reader leaves, and the words of the welcome.
 */
export default function project(
  _request: Request,
  context?: RequestContext,
): ChatProject {
  return {
    ...chatOf(context),
    app: APP_ID,
    // The sidebar is on the memory page too: a search from there loads the chat.
    page: "/",
    welcome: {
      heading: WELCOME.heading,
      tagline: WELCOME.tagline,
      note: html`<p data-testid="chat-retention">
        Demo chats are kept for 24 hours after your last message.
      </p>`,
      suggestions: WELCOME.suggestions,
    },
  };
}

/**
 * A route for one of the chat's handlers: `export const POST = route("send");`.
 * The limits in src/lib/limits.ts come first, here in the route, so they
 * hold for every path Bascik routes to it.
 */
export const route =
  (handler: Handler) =>
  async (request: Request, context?: RequestContext): Promise<Response> => {
    const env = envOf(context);
    const refused = await refusal(
      handler,
      request,
      env,
      knownReader(env, request),
    );
    if (refused) return refused;
    const { chat, host } = chatOf(context);
    try {
      return await chat[handler](request, host);
    } catch (error) {
      // A new reader on a day the cap is reached: say so, not a 500.
      if (error instanceof Error && error.message.includes(DEMO_FULL)) {
        return new Response(`${DEMO_FULL}\n`, {
          status: 503,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "retry-after": "3600",
          },
        });
      }
      throw error;
    }
  };
