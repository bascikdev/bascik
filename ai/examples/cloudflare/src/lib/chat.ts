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
export const WELCOME = booksApp({ delayMs: 0 });

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

function makeChat(env: Env): Chat {
  const app = booksApp({
    delayMs: numberVar(env.DEMO_MODEL_DELAY_MS, DELAY_MS),
  });
  const stores = readerStores(env.READER);
  return createChat({
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
    sessions: cookieSessions(APP_ID, {
      // The data is kept 24 hours, so the visitor cookie is too.
      maxAgeSeconds: 86_400,
      secure: env.GENUI_SECURE_COOKIES !== "0",
      ...(env.SESSION_SECRET ? { secret: env.SESSION_SECRET } : {}),
    }),
    maxConversations: 20,
    maxConversationBytes: 256 * 1024,
    // A reply has to fit in the time the platform keeps a request's work
    // going after the reader leaves.
    turnLimitMs: 25_000,
    maxRounds: 4,
    page: app.path,
  });
}

let made: { env: Env; chat: Chat } | undefined;

/** The chat for this deployment's bindings: one per isolate. */
export function chatFor(env: Env): Chat {
  if (made?.env !== env) made = { env, chat: makeChat(env) };
  return made.chat;
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

type Handler =
  "send" | "approve" | "answer" | "forget" | "stop" | "open" | "file";

/** A route for one of the chat's handlers: `export const POST = route("send");` */
export const route =
  (handler: Handler) =>
  async (request: Request, context?: RequestContext): Promise<Response> => {
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
