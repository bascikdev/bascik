/**
 * What an app needs around the renderer and the turn loop: a conversation
 * store, the reader's session, replies that are written once whoever is
 * watching, and the handlers a chat page posts to.
 *
 * `createChat` holds what the routes share, and each handler is a web
 * standard `(request: Request) => Promise<Response>`, so a route file is one
 * line: `export const POST = chat.send;`. Every piece also works alone: take
 * the store and write your own handlers, or take the handlers over your own
 * store.
 *
 * Nothing here reads the environment or keeps a global. Where conversations
 * live, who the reader is, which model answers, and which voice provider is
 * offered are all passed in, and a client never chooses any of them.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { catalogPrompt, type Catalog } from "./catalog.ts";
import { createBroadcast, type Broadcast } from "./broadcast.ts";
import {
  forgetMemory,
  memoryPrompt,
  memoryTools,
  type Memory,
  type MemoryStore,
} from "./memory.ts";
import type { ChatMessage, FilePart, Model, Tool } from "./model.ts";
import {
  checkUploads,
  fileResponse,
  refusals,
  refusedPage,
  resolveLimits,
  type FileLimits,
  type FileStore,
} from "./files.ts";
import { renderTurn, type TurnRenderOptions } from "./render-turn.ts";
import {
  abandonToolCalls,
  answerToolCall,
  decideToolCall,
  runTurn,
  turnPending,
} from "./turn.ts";
import { historyTool } from "./history.ts";
import {
  MAX_QUERY,
  MIN_QUERY,
  isSafeKey,
  newConversation,
  searchConversations,
  type Conversation,
  type ConversationStore,
  type SearchMatch,
} from "./store.ts";
import {
  inProcessShared,
  type ChannelEvent,
  type Lease,
  type Shared,
} from "./shared.ts";
import {
  finishVoiceTool,
  newVoiceTurn,
  voiceCallId,
  noteVoiceView,
  settleVoiceTool,
  startVoiceTool,
  voiceMessages,
  voicePrompt,
  voiceTools,
  type VoiceProvider,
  type VoiceTurn,
} from "./voice.ts";

export {
  fileMemories,
  inMemoryMemories,
  type Memory,
  type MemoryStore,
} from "./memory.ts";
export {
  fileStore,
  memoryStore,
  newConversation,
  searchConversations,
  type Conversation,
  type ConversationStore,
  type SearchMatch,
} from "./store.ts";

/* ---- Who is asking, and about what ---- */

/** One request's place in the app: which reader, and which of their conversations is open. */
export interface Session {
  /** Who is asking. A store keeps each reader's conversations apart. */
  reader: string;
  /** The reader's open conversation, when the request names one. */
  conversationId: string | undefined;
}

/**
 * How a request says who the reader is and which conversation is open, and
 * how a response remembers it. Replace it with your sign-in: `identify`
 * answers from the request, and `remember` returns the headers (cookies, for
 * example) that make the next request say the same.
 */
export interface ChatSessions {
  identify(request: Request): Session;
  remember(session: Session, conversationId: string): Headers;
}

/** An id as `randomUUID` writes it. */
const COOKIE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) {
      return pair.slice(at + 1).trim();
    }
  }
  return undefined;
}

const cookieId = (value: string | undefined): string | undefined =>
  value !== undefined && COOKIE_ID.test(value) ? value : undefined;

export interface CookieSessionOptions {
  /**
   * Default true: both cookies are Secure, on every response. Chrome and
   * Firefox keep a Secure cookie on http://localhost and http://127.0.0.1
   * too. False is the opt-out, for development on a browser that drops them
   * (Safari on plain http) or from another device over plain http. It is
   * never guessed from the request: behind a proxy, a public https site's
   * requests can look like plain http to 127.0.0.1.
   */
  secure?: boolean;
  /**
   * Signs the reader id this server issues with an HMAC, and refuses a
   * `visitor` cookie it did not sign (a new reader is made instead). This
   * stops an id the server never issued. It does not stop one the server did
   * issue (to an attacker, say) being planted in someone else's browser.
   */
  secret?: string;
  /**
   * Default false. True names both cookies with the `__Host-` prefix
   * (`__Host-visitor`, `__Host-chat_<id>`) and reads only those. A browser
   * accepts a `__Host-` cookie only from a secure origin, with Secure,
   * `Path=/` and no Domain, so a sibling subdomain or a plain-http response
   * cannot plant one. Turning it on starts every existing reader over, and
   * it needs `secure` left on.
   */
  hostPrefix?: boolean;
}

/**
 * The default sessions: an anonymous reader and an open conversation, each in
 * an HttpOnly cookie (`visitor`, and `chat_<id>` so apps on one site keep
 * their own). Readers never see each other's conversations, and a reader who
 * clears cookies starts over. See `CookieSessionOptions` for Secure, for
 * signing the reader id, and for the `__Host-` prefix.
 */
export function cookieSessions(
  id = "chat",
  options: CookieSessionOptions = {},
): ChatSessions {
  const { secret, secure = true, hostPrefix = false } = options;
  if (secret === "") throw new Error("cookieSessions: the secret is empty.");
  if (hostPrefix && !secure) {
    throw new Error(
      "cookieSessions: hostPrefix needs Secure cookies; a browser drops a __Host- cookie without it.",
    );
  }
  const prefix = hostPrefix ? "__Host-" : "";
  const visitorName = `${prefix}visitor`;
  const chatName = `${prefix}chat_${id}`;
  const tail = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  const sign = (reader: string): string =>
    createHmac("sha256", secret!)
      .update(`visitor:${reader}`)
      .digest("base64url");
  const readerOf = (value: string | undefined): string | undefined => {
    if (secret === undefined) return cookieId(value);
    const dot = value?.indexOf(".") ?? -1;
    const reader = cookieId(value?.slice(0, dot));
    if (dot < 0 || reader === undefined) return undefined;
    const given = Buffer.from(value!.slice(dot + 1));
    const expected = Buffer.from(sign(reader));
    return given.length === expected.length && timingSafeEqual(given, expected)
      ? reader
      : undefined;
  };
  return {
    identify(request) {
      return {
        reader: readerOf(cookieValue(request, visitorName)) ?? randomUUID(),
        conversationId: cookieId(cookieValue(request, chatName)),
      };
    },
    remember(session, conversationId) {
      const visitor =
        secret === undefined
          ? session.reader
          : `${session.reader}.${sign(session.reader)}`;
      const headers = new Headers();
      headers.append("set-cookie", `${chatName}=${conversationId}; ${tail}`);
      headers.append(
        "set-cookie",
        `${visitorName}=${visitor}; Max-Age=31536000; ${tail}`,
      );
      return headers;
    },
  };
}

/* ---- Live turns ---- */

/**
 * A reply being written. It belongs to the conversation, not to the request
 * that started it: the page that asked, a reload of it, and a second tab all
 * read the same `html` from its start, and the reply is finished and stored
 * even when the reader has left. Only Stop, or the time limit, ends it early.
 *
 * The server that holds the reply's lease writes it. On any other server,
 * `html` is fed from the shared channel (`ChatOptions.shared`), so a reader
 * who lands there mid-reply joins it instead of starting a second one.
 */
export interface LiveTurn {
  /** The conversation as it was when the turn started: what a page shows above the reply. */
  messages: ChatMessage[];
  html: Broadcast<string>;
  stop: AbortController;
  /** Settles once the turn's message is stored. */
  over: Promise<void>;
}

/** What one page request shows: the stored conversation, and the reply being written, if any. */
export interface ThreadState {
  session: Session;
  messages: ChatMessage[];
  turn: LiveTurn | undefined;
}

/* ---- The chat ---- */

export interface ChatOptions {
  /** Names this chat: its cookie and its log lines. Give each app of one site its own. Default `chat`. */
  id?: string;
  /** Where conversations are kept. */
  store: ConversationStore;
  /** The components a model may write, or a function that loads them (called once, on first use). */
  catalog: Catalog | (() => Catalog | Promise<Catalog>);
  /**
   * The model that answers a request (a fixed one is `() => model`). Pick it from what the server offers,
   * never from a URL or a key the request carries. It is called when a reply
   * starts, with the request that started it.
   */
  model: (request: Request) => Model | Promise<Model>;
  tools?: Tool[];
  /**
   * What the assistant knows about each reader across conversations. When
   * set, every reply (typed or spoken) gets the reader's `remember`,
   * `recall`, and `forget` tools, and the prompt lists what is known. See
   * `@bascik/ai/memory`.
   */
  memory?: MemoryStore;
  /** True to make `remember` and `forget` wait for the reader's OK. Default false: the reply shows each one, and the reader can undo it. */
  memoryApproval?: boolean;
  /**
   * What the model is told. A string is the app's own instructions: the
   * catalog prompt (or, in a voice session, the voice prompt) follows it. A
   * function returns the whole prompt.
   */
  system:
    | string
    | ((context: {
        catalog: Catalog;
        voice: boolean;
      }) => string | Promise<string>);
  /** The sentence that tells the model what each code fence it may write is drawn as, by language. */
  fencePrompts?: Readonly<Record<string, string>>;
  /** How replies are drawn, live and from history. `tools` defaults to the chat's own. */
  render?: TurnRenderOptions;
  /**
   * The voice provider to offer, or a function that picks one by the
   * `?provider=` the request names (null when it names none). Without one,
   * the voice handlers answer 404. With a function, the tool call and turn
   * handlers serve only a conversation it opened a voice session for.
   */
  voice?:
    | VoiceProvider
    | ((
        protocol: string | null,
      ) => VoiceProvider | null | Promise<VoiceProvider | null>);
  /**
   * Give the model a `search_conversations` tool for the reader's own past
   * conversations, in typed chat and in voice. Default false. What it finds
   * is handed over as quoted data, never as instructions.
   */
  history?: boolean;
  /**
   * Where attached files are kept. With it, `send` accepts
   * `multipart/form-data` with a `files` field and `file` serves them back;
   * without it, uploads are ignored.
   */
  files?: FileStore;
  /** What is let in: sizes, count, types. Defaults in `@bascik/ai/files`. */
  fileLimits?: FileLimits;
  /** Who the reader is and which conversation is open. Default `cookieSessions(id, { secret: sessionSecret })`. */
  sessions?: ChatSessions;
  /**
   * The secret the default sessions sign reader ids with (see
   * `cookieSessions`). Recommended: without it, a cookie planted on the site
   * can choose a visitor's reader id. Ignored when `sessions` is given.
   */
  sessionSecret?: string;
  /**
   * The most bytes a form handler reads of a request body; past it, the
   * handler answers 413 (`send` with `files` answers its refused page)
   * without reading the rest. Default: `fileLimits.maxTotalBytes` plus 256 KB
   * when `files` is set, else 256 KB.
   */
  maxBodyBytes?: number;
  /**
   * The most bytes one conversation holds, as stored JSON. Once a typed
   * message or a voice turn would take it past this, it is refused with 413
   * ("This conversation is full."), and the reader starts a new one. Default 2 MB.
   */
  maxConversationBytes?: number;
  /** The page the form handlers send the reader back to. Default `/`. */
  page?: string;
  /** The longest one reply may take, tools included. Default two minutes. */
  turnLimitMs?: number;
  /**
   * State that must be the same on every server: the reply being written,
   * Stop, and a voice call's turn. Default `inProcessShared()`, which is
   * right for one server. For several, pass an implementation over a store
   * they all reach (see `@bascik/ai/shared`).
   */
  shared?: Shared;
  /** Told about a failure the reader is not shown. Default: `console.error`. */
  onError?: (error: unknown, what: string) => void;
}

export interface Chat {
  /* Handlers: `export const POST = chat.send;` */

  /** Add the reader's message and go back to the page, which streams the reply. */
  send: (request: Request) => Promise<Response>;
  /** Record the reader's answer to a tool call that needs their say-so. */
  approve: (request: Request) => Promise<Response>;
  /** Record the result of a client tool call. */
  answer: (request: Request) => Promise<Response>;
  /** End the reply being written for the open conversation. 204, or 404 when none is. */
  stop: (request: Request) => Promise<Response>;
  /** Open one of the reader's conversations, or start a new one. */
  open: (request: Request) => Promise<Response>;
  /**
   * Remove one of the reader's memories: a form post with `id`, and an
   * optional `back`, a path on this site to return to (default: the chat's
   * page). A memory that is not there is not an error: the form is safe to
   * send twice.
   */
  forget: (request: Request) => Promise<Response>;
  /** The reader's memories as JSON, newest first: `{ memories }`. */
  memoryList: (request: Request) => Promise<Response>;
  /** Start a spoken conversation: answers with a ticket for the voice provider. */
  voiceSession: (request: Request) => Promise<Response>;
  /**
   * Serve one attached file: `GET` with `?id=<file id>`. Only to the reader
   * it belongs to; 404 for anyone else, and for an id that is not one.
   */
  file: (request: Request) => Promise<Response>;
  /** Run a tool call a voice model made. */
  voiceTool: (request: Request) => Promise<Response>;
  /** Store what was just said in a spoken conversation. */
  voiceTurn: (request: Request) => Promise<Response>;

  /* What a page needs */

  /**
   * The open conversation and the reply being written, if any. The thread's
   * stream scripts both call this and get one answer per request. When the
   * conversation is waiting for a reply and none is being written, this
   * starts it.
   */
  thread(request: Request): Promise<ThreadState>;
  /** The reader's memories, newest first (none when the chat has no `memory`). For a page that lists them. */
  memories(request: Request): Promise<Memory[]>;
  /** The HTML of what a voice tool call put on screen ("" when it put nothing). */
  voiceView(request: Request, call: string): Promise<string>;
  /**
   * The reader's past conversations that match the request's `?q=`: the
   * search box is a plain GET form, so a page needs nothing else. Nothing
   * matches an empty or too short query.
   */
  search(request: Request): Promise<SearchResults>;
  /** The loaded catalog. */
  catalog(): Promise<Catalog>;
  /** The options that render this chat's replies: `renderTurn`, `renderMessage`. */
  renderOptions: TurnRenderOptions;
  /** What a text reply's model is told. */
  systemPrompt(): Promise<string>;

  /* For handlers of your own */

  sessions: ChatSessions;
  store: ConversationStore;
  /** The file store the chat was given, if any. */
  files: FileStore | undefined;
  /** The request's session. */
  session(request: Request): Session;
  /** A conversation of the session's reader (the open one by default), or null. */
  load(session: Session, id?: string): Promise<Conversation | null>;
  /**
   * Store a conversation, stamping `updatedAt`, in turn with every other
   * write to it. When it came from `load` and was stored again since (a
   * spoken turn, an approval, a reply), what you changed is applied over that:
   * messages you added follow the ones stored since, and a field you changed
   * replaces it. When both writes changed or removed messages that were
   * there when it was loaded, even different ones, `save` throws and stores
   * nothing. A save that fails leaves the conversation as you changed it, so
   * it can be saved again. One that came from neither `load` nor `change`
   * replaces what is stored. Prefer `change`.
   */
  save(session: Session, conversation: Conversation): Promise<void>;
  /**
   * Read the reader's conversation (the open one by default, a new one when
   * there is none), let `edit` change it, and store it, in turn with every
   * other write to it, so no write made at the same time is lost. Returns
   * what was stored. `edit` must not itself save, change or add a message to
   * the same conversation: that waits for this one to finish, which never
   * comes.
   */
  change(
    session: Session,
    edit: (conversation: Conversation) => void | Promise<void>,
    id?: string,
  ): Promise<Conversation>;
  /** The session's reader's conversations, newest first. */
  list(session: Session): Promise<Conversation[]>;
  /**
   * Add the reader's message to their open conversation (a new one when none
   * is open) and store it. The conversation's first message titles it, unless
   * `title` does. Tool calls still waiting for the reader are refused.
   * Rejects with `ConversationFullError` when the message would take the
   * conversation past `maxConversationBytes`; answer it with 413 (the `send`
   * handler does).
   */
  addMessage(
    session: Session,
    text: string,
    options?: { title?: string; files?: FilePart[] },
  ): Promise<Conversation>;
  /** A 303 to the page, remembering the open conversation: a form POST ends in a GET, so reload is safe. */
  redirect(session: Session, conversationId: string): Response;
  /** Stop the conversation's reply, and wait until what it wrote is stored. False when none is being written. */
  stopTurn(conversationId: string): Promise<boolean>;
}

/** What `chat.search` answers. */
export interface SearchResults {
  /** The query as it was used: trimmed and cut to `MAX_QUERY` characters. */
  query: string;
  /** True when the query is too short to search for. */
  tooShort: boolean;
  matches: SearchMatch[];
}

/** The most matches a search page shows. */
const SEARCH_LIMIT = 20;

/** A message the reader sends is kept to this many characters. */
const MAX_MESSAGE = 4000;
/** What a voice session stores of one turn's speech. */
const MAX_SPEECH = 8000;
/** A voice tool call's input, as sent. */
const MAX_TOOL_INPUT = 64_000;
const NO_STORE = { "cache-control": "no-store" };

/** `ChatOptions.maxConversationBytes` when it is not given: 2 MB. */
const DEFAULT_MAX_CONVERSATION_BYTES = 2 * 1024 * 1024;

/**
 * Thrown by `addMessage` when the conversation has no room for the message
 * (see `ChatOptions.maxConversationBytes`). The handlers answer it with 413.
 */
export class ConversationFullError extends Error {
  constructor() {
    super("This conversation is full. Start a new conversation to go on.");
    this.name = "ConversationFullError";
  }
}

const conversationFull = (): Response =>
  new Response(new ConversationFullError().message, {
    status: 413,
    headers: NO_STORE,
  });
/**
 * A path on this site: one slash first, never `//host` or `/\host`, and no
 * control characters (a URL parser drops a tab, so `/\t/host` is `//host`).
 */
const LOCAL_PATH = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/;
/** Where a `back` field sends the reader: its path on this site, or undefined. */
function localPath(back: string | undefined): string | undefined {
  if (back === undefined || !LOCAL_PATH.test(back)) return undefined;
  // Resolved the way a browser resolves Location, then kept only when it
  // stays on the same origin and the result is itself a local path: taking
  // out dot segments can leave `//host` (`/.//host`, `/a/..//host`,
  // `/%2e//host`), which the browser would then resolve to another site.
  const base = "http://this.invalid";
  const url = new URL(back, base);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === base && LOCAL_PATH.test(path) ? path : undefined;
}
/** What a multipart body may carry besides its files: the text and the field framing. */
const MULTIPART_ROOM = 256 * 1024;

/** A conversation's title: the first words of what began it. */
const titleOf = (text: string): string =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
/** Whether `list` begins with every item of `head`, unchanged. */
const startsWith = (list: unknown[], head: unknown[]): boolean =>
  list.length >= head.length && head.every((item, i) => same(item, list[i]));

/**
 * `latest` (what other writes stored since `base`) with the changes in `ours`
 * (`base` as it was loaded, then changed by a caller) applied over it, as a
 * new conversation: `ours` is left as it is, so a save that fails can be
 * tried again. Messages one side added after `base` follow the other side's;
 * a field the caller changed replaces the stored one. When both sides
 * changed or removed messages that `base` had, even different ones, they
 * cannot be put together, and this throws.
 */
function applyChanges(
  ours: Conversation,
  base: Conversation,
  latest: Conversation,
): Conversation {
  let messages = ours.messages;
  if (same(ours.messages, base.messages)) messages = latest.messages;
  else if (!same(latest.messages, base.messages)) {
    if (startsWith(ours.messages, base.messages)) {
      messages = [
        ...latest.messages,
        ...ours.messages.slice(base.messages.length),
      ];
    } else if (startsWith(latest.messages, base.messages)) {
      messages = [
        ...ours.messages,
        ...latest.messages.slice(base.messages.length),
      ];
    } else {
      throw new Error(
        `Conversation ${ours.id} was changed by another write since it was loaded, in the same messages: load it again, or use chat.change.`,
      );
    }
  }
  const merged = JSON.parse(JSON.stringify(ours)) as Conversation;
  const fields = merged as unknown as Record<string, unknown>;
  const was = base as unknown as Record<string, unknown>;
  const now = latest as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key === "id" || key === "messages" || key === "updatedAt") continue;
    if (!same(fields[key], was[key])) continue;
    if (key in now) fields[key] = now[key];
    else delete fields[key];
  }
  merged.messages = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  return merged;
}

const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

/** A form with a `text` field sends that; any other form sends `Label: value` lines. */
function messageFrom(form: FormData): string {
  const text = form.get("text");
  if (typeof text === "string") return text.trim();
  const lines: string[] = [];
  for (const [name, value] of form) {
    // `app` names which chat the form is for, and `voice` how to answer it.
    if (
      name !== "app" &&
      name !== "voice" &&
      typeof value === "string" &&
      value.trim()
    ) {
      lines.push(`${name}: ${value.trim()}`);
    }
  }
  return lines.join("\n");
}

const badRequest = (message: string): Response =>
  new Response(message, { status: 400 });

/**
 * The request's form, or why there is none: it is not a form, or it is longer
 * than `limit` bytes. The body is counted as it streams, so a body with no
 * Content-Length (or a false one) is cut off at the limit, never read whole.
 */
async function readForm(
  request: Request,
  limit: number,
): Promise<FormData | "not a form" | "too large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return "too large";
  let over = false;
  let seen = 0;
  const body =
    request.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) {
            over = true;
            controller.error(new RangeError("The body is too large."));
          } else {
            controller.enqueue(chunk);
          }
        },
      }),
    ) ?? null;
  const type = request.headers.get("content-type");
  try {
    return await new Response(body, {
      headers: type === null ? {} : { "content-type": type },
    }).formData();
  } catch {
    return over ? "too large" : "not a form";
  }
}

/** How long a server's claim on a conversation's reply lasts without being renewed. */
const LEASE_MS = 15_000;
/** How often the server writing a reply looks for a Stop. The claim is renewed every `RENEW_MS`. */
const WATCH_MS = 500;
const RENEW_MS = 5000;
/** How long a server following a reply waits in silence before it asks whether the writer is still there. */
const FOLLOW_IDLE_MS = 2000;
/** How long a voice call's recorded turn and shown views are kept after the last tool call. */
const VOICE_MS = 2 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const WRITER_GONE =
  "The server writing this reply stopped. Reload the page to write it again.";

/** `promise`'s result, or undefined when it takes longer than `ms`. The promise is left running. */
const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const failedNotice = (message: string): string =>
  `<p class="failed" data-testid="turn-failed">${message}</p>`;

/** What the server writing a reply tells the others: which turn, and how much of the conversation was above it. */
interface TurnRecord {
  turn: string;
  count: number;
}

export function createChat(options: ChatOptions): Chat {
  const {
    id = "chat",
    store,
    tools = [],
    memory,
    memoryApproval = false,
    page = "/",
    turnLimitMs = 120_000,
  } = options;
  const sessions =
    options.sessions ??
    cookieSessions(
      id,
      options.sessionSecret === undefined
        ? {}
        : { secret: options.sessionSecret },
    );
  const onError =
    options.onError ??
    ((error: unknown, what: string) =>
      console.error(`[${id}] ${what}:`, error));
  const renderOptions: TurnRenderOptions = {
    ...options.render,
    // The memory tools are built per reader to run, but a note reads only
    // the call's input, so these (for no reader) are all drawing needs.
    tools:
      options.render?.tools ??
      (memory ? [...tools, ...memoryTools(memory, "")] : tools),
  };

  /** The tools of one request: the app's, and its reader's memory. */
  /**
   * The tools one request's model gets: the chat's own, and the ones made for
   * this reader. `tools` is read once; this runs at each place a model is
   * given tools, so a tool can know whose memories and conversations it may
   * look in.
   */
  const toolsFor = (session: Session, conversationId?: string): Tool[] => {
    const open = conversationId ?? session.conversationId;
    return [
      ...tools,
      ...(memory
        ? memoryTools(memory, session.reader, {
            approval: memoryApproval,
            ...(open ? { conversationId: open } : {}),
          })
        : []),
      ...(options.history
        ? [historyTool(store, { ...session, conversationId: open })]
        : []),
    ];
  };

  /* Catalog and prompts */

  let loaded: Promise<Catalog> | undefined;
  const catalog = (): Promise<Catalog> =>
    (loaded ??= Promise.resolve()
      .then(() =>
        typeof options.catalog === "function"
          ? options.catalog()
          : options.catalog,
      )
      .catch((error: unknown) => {
        loaded = undefined;
        throw error;
      }));

  const promptOptions = {
    elements: renderOptions.elements,
    fences: options.fencePrompts,
  };
  const basePrompt = async (voice: boolean): Promise<string> => {
    const catalogNow = await catalog();
    if (typeof options.system === "function") {
      return options.system({ catalog: catalogNow, voice });
    }
    return [
      options.system,
      "",
      (voice ? voicePrompt : catalogPrompt)(catalogNow, promptOptions),
    ].join("\n");
  };
  // With memory, the section about it follows, listing this reader's notes
  // (none when no reader is asking, as for `systemPrompt()`).
  const promptFor = async (
    voice: boolean,
    session?: Session,
  ): Promise<string> => {
    const base = await basePrompt(voice);
    if (!memory) return base;
    const known = session ? await memory.list(session.reader) : [];
    return `${base}\n\n${memoryPrompt(known)}`;
  };

  /* Conversations */

  const load: Chat["load"] = async (session, conversationId) =>
    store.load(session.reader, conversationId ?? session.conversationId ?? "");
  const maxConversationBytes =
    options.maxConversationBytes ?? DEFAULT_MAX_CONVERSATION_BYTES;
  /** Whether `conversation` has room for `adding`, as stored JSON. */
  const roomIn = (
    conversation: Conversation,
    adding: readonly ChatMessage[],
  ): boolean =>
    new TextEncoder().encode(
      JSON.stringify({
        ...conversation,
        messages: [...conversation.messages, ...adding],
      }),
    ).length <= maxConversationBytes;
  const save: Chat["save"] = async (session, conversation) => {
    conversation.updatedAt = Date.now();
    await store.save(session.reader, conversation);
  };
  const redirect: Chat["redirect"] = (session, conversationId) => {
    const headers = sessions.remember(session, conversationId);
    headers.set("location", page);
    return new Response(null, { status: 303, headers });
  };
  /**
   * Changes to one conversation, one at a time: each reads the conversation
   * afresh and stores it before the next reads, so two writes at once (two
   * tabs sending, a message sent as a reply is stored) never lose one. This
   * holds within one server; across several, the store has to arbitrate.
   */
  const writing = new Map<string, Promise<unknown>>();
  function serialized<T>(
    session: Session,
    conversationId: string,
    change: () => Promise<T>,
  ): Promise<T> {
    const key = `${session.reader}\n${conversationId}`;
    const run = (writing.get(key) ?? Promise.resolve()).then(change);
    const settled = run.then(
      () => {},
      () => {},
    );
    writing.set(key, settled);
    void settled.then(() => {
      if (writing.get(key) === settled) writing.delete(key);
    });
    return run;
  }
  /**
   * Read the reader's open conversation and change it, in turn with every
   * other write to it. `change` gets null when none is open, and stores what
   * it changes before it returns. Every handler that changes a stored
   * conversation goes through here (or `serialized`).
   */
  function changingOpen<T>(
    session: Session,
    change: (conversation: Conversation | null) => Promise<T>,
  ): Promise<T> {
    const open = session.conversationId;
    return open === undefined
      ? change(null)
      : serialized(session, open, async () =>
          change(await load(session, open)),
        );
  }
  /*
   * The public load and save, for handlers of your own. What `load` handed
   * out is remembered as it was, so a `save` of it later can tell what the
   * caller changed from what other writes stored in between, and keep both.
   */
  const loadedAs = new WeakMap<Conversation, string>();
  const loadForCaller: Chat["load"] = async (session, conversationId) => {
    const found = await load(session, conversationId);
    if (found) loadedAs.set(found, JSON.stringify(found));
    return found;
  };
  const saveForCaller: Chat["save"] = (session, conversation) =>
    serialized(session, conversation.id, async () => {
      const base = loadedAs.get(conversation);
      let merged = conversation;
      if (base !== undefined) {
        const latest = await load(session, conversation.id);
        if (latest && JSON.stringify(latest) !== base) {
          merged = applyChanges(
            conversation,
            JSON.parse(base) as Conversation,
            latest,
          );
        }
      }
      await save(session, merged);
      // Only a stored merge becomes the caller's: a failed save leaves their
      // conversation, and what it was loaded as, for a retry to merge again.
      if (merged !== conversation) {
        const fields = conversation as unknown as Record<string, unknown>;
        for (const key of Object.keys(fields)) {
          if (!(key in merged)) delete fields[key];
        }
        Object.assign(conversation, merged);
      }
      loadedAs.set(conversation, JSON.stringify(conversation));
    });
  const change: Chat["change"] = (session, edit, conversationId) => {
    const wanted = conversationId ?? session.conversationId;
    const run = async (): Promise<Conversation> => {
      const conversation =
        (wanted === undefined ? null : await load(session, wanted)) ??
        newConversation();
      await edit(conversation);
      await save(session, conversation);
      // What `change` returns saves like what `load` returns.
      loadedAs.set(conversation, JSON.stringify(conversation));
      return conversation;
    };
    return wanted === undefined ? run() : serialized(session, wanted, run);
  };
  const addMessage: Chat["addMessage"] = async (session, text, titled) =>
    session.conversationId === undefined
      ? appendMessage(session, text, titled)
      : serialized(session, session.conversationId, () =>
          appendMessage(session, text, titled),
        );
  const appendMessage: Chat["addMessage"] = async (session, text, titled) => {
    const conversation = (await load(session)) ?? newConversation();
    const attached = titled?.files ?? [];
    if (conversation.messages.length === 0) {
      conversation.title =
        titled?.title ?? titleOf(text || attached[0]?.name || "Files");
    }
    const message: ChatMessage = attached.length
      ? {
          role: "user",
          content: text,
          parts: [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...attached,
          ],
        }
      : { role: "user", content: text };
    if (!roomIn(conversation, [message])) throw new ConversationFullError();
    abandonToolCalls(conversation.messages);
    conversation.messages.push(message);
    await save(session, conversation);
    return conversation;
  };

  /* Attached files: how a model reads one, and what a send accepts */

  const fileStore = options.files;
  const fileLimits = resolveLimits(options.fileLimits);
  const maxBodyBytes =
    options.maxBodyBytes ??
    (fileStore ? fileLimits.maxTotalBytes + MULTIPART_ROOM : MULTIPART_ROOM);
  /** A form handler's form, or its answer when there is none. */
  const formOf = async (
    request: Request,
    notAForm: string,
  ): Promise<FormData | Response> => {
    const form = await readForm(request, maxBodyBytes);
    if (form === "not a form") return badRequest(notAForm);
    if (form === "too large") {
      return new Response("The request is too large.", {
        status: 413,
        headers: NO_STORE,
      });
    }
    return form;
  };
  const readFileFor = (session: Session) =>
    fileStore
      ? async (part: FilePart): Promise<Uint8Array | null> =>
          (await fileStore.get(session.reader, part.id))?.bytes ?? null
      : undefined;

  /**
   * The files of a send, checked and stored, as message parts; or the
   * response that refuses them. Nothing is stored unless every file passes.
   */
  async function attach(
    session: Session,
    form: FormData,
    text: string,
  ): Promise<FilePart[] | Response> {
    if (!fileStore) return [];
    // An empty file input still sends one empty, unnamed part: that is no file.
    const uploads = form
      .getAll("files")
      .filter(
        (value): value is File =>
          typeof value !== "string" && (value.size > 0 || value.name !== ""),
      );
    if (uploads.length === 0) return [];
    const checked = await checkUploads(uploads, fileLimits);
    if (!checked.ok) return refusedPage(checked.message, text, page);
    const stored: string[] = [];
    try {
      for (const file of checked.files) {
        await fileStore.put(session.reader, file.id, {
          name: file.name,
          mediaType: file.mediaType,
          size: file.bytes.byteLength,
          bytes: file.bytes,
        });
        stored.push(file.id);
      }
    } catch (error) {
      onError(error, "an attached file could not be stored");
      await Promise.all(
        stored.map((id) =>
          fileStore.remove(session.reader, id).catch(() => {}),
        ),
      );
      return refusedPage(
        "The files could not be saved. Nothing was sent; try again.",
        text,
        page,
      );
    }
    return checked.files.map((file) => ({
      type: "file" as const,
      id: file.id,
      name: file.name,
      mediaType: file.mediaType,
      size: file.bytes.byteLength,
    }));
  }

  /* Live turns: a reply is written once, whoever is watching */

  const shared = options.shared ?? inProcessShared();
  const ns = `genui:${id}:`;
  const leaseKey = (conversationId: string): string =>
    `${ns}lease:${conversationId}`;
  const recordKey = (conversationId: string): string =>
    `${ns}turn:${conversationId}`;
  const stopKey = (conversationId: string, turn: string): string =>
    `${ns}stop:${conversationId}:${turn}`;
  const channelKey = (conversationId: string, turn: string): string =>
    `${ns}reply:${conversationId}:${turn}`;

  /** Every reply this server writes or follows, by conversation. */
  const live = new Map<string, LiveTurn>();

  function startTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
    held: { lease: Lease; turn: string },
  ): LiveTurn {
    const html = createBroadcast<string>();
    const stop = new AbortController();
    const messages = conversation.messages;
    const carriedOn = messages.at(-1)!.role === "assistant";
    const channel = channelKey(conversation.id, held.turn);
    // What readers here see at once goes to the other servers in order,
    // without the model waiting on the shared store.
    let outbox: Promise<void> = Promise.resolve();
    let unreachable = false;
    const say = (event: ChannelEvent): void => {
      outbox = outbox
        .then(() => shared.publish(channel, event))
        .catch((error: unknown) => {
          if (unreachable) return;
          unreachable = true;
          onError(error, "other servers cannot follow this reply");
        });
    };
    const emit = (chunk: string): void => {
      html.push(chunk);
      say({ type: "data", data: chunk });
    };
    // Another server took the conversation over, or the shared store stayed
    // away for the claim's whole length: this reply is no longer ours to
    // write, and the new holder stores its own.
    let lost = false;
    const giveUp = (why: string): void => {
      if (lost) return;
      lost = true;
      emit(failedNotice(why));
      stop.abort();
    };
    let renewedAt = Date.now();
    let looking = false;
    const watch = setInterval(async () => {
      if (looking || lost) return;
      looking = true;
      try {
        if (await shared.get(stopKey(conversation.id, held.turn))) {
          stop.abort();
        }
        if (Date.now() - renewedAt >= RENEW_MS) {
          if (await held.lease.renew()) {
            await shared.set(
              recordKey(conversation.id),
              JSON.stringify({ turn: held.turn, count: messages.length }),
              LEASE_MS,
            );
            renewedAt = Date.now();
          } else {
            giveUp(
              "This reply moved to another server. Reload the page to see it.",
            );
          }
        }
      } catch (error) {
        if (Date.now() - renewedAt > LEASE_MS) {
          onError(error, "the shared store did not answer");
          giveUp(
            "This reply was stopped because the shared store did not answer. Reload the page to try again.",
          );
        }
      } finally {
        looking = false;
      }
    }, WATCH_MS);
    watch.unref();
    const write = async (): Promise<void> => {
      // What is stored if the turn cannot even start (a model that cannot be
      // made, a catalog that does not load): the reply being carried on, or a
      // new empty one. Either way the turn is finished, so a reload does not
      // start it again.
      const last = messages.at(-1)!;
      let message: ChatMessage = carriedOn
        ? {
            ...last,
            parts: last.parts?.map((part) => ({ ...part })) ?? [],
          }
        : { role: "assistant", content: "", parts: [] };
      delete message.awaiting;
      try {
        const model = await options.model(request);
        const turn = runTurn({
          model,
          system: await promptFor(false, session),
          messages,
          tools: toolsFor(session, conversation.id),
          readFile: readFileFor(session),
          signal: AbortSignal.any([
            stop.signal,
            AbortSignal.timeout(turnLimitMs),
          ]),
        });
        message = turn.message;
        for await (const chunk of renderTurn(
          turn.events,
          await catalog(),
          renderOptions,
        )) {
          emit(chunk);
        }
      } catch (error) {
        onError(error, "the model failed");
        const sorry = "Something went wrong while writing this reply.";
        message.parts!.push({ type: "text", text: `\n\n${sorry}` });
        message.content = `${message.content}\n\n${sorry}`.trim();
        emit(failedNotice(sorry));
      } finally {
        // A reply whose claim was lost is not stored: whoever holds the
        // conversation now writes its own, so it is stored once.
        if (!lost) {
          if (message.parts!.length === 0) {
            delete message.parts;
            message.content = "(no reply)";
          }
          // Read the conversation again, in turn with its other writes: the
          // reader may have sent something else while this was being
          // written, and that must not be lost.
          const reply = message;
          await serialized(session, conversation.id, async () => {
            const latest =
              (await load(session, conversation.id)) ?? conversation;
            const at = messages.length - (carriedOn ? 1 : 0);
            latest.messages.splice(at, carriedOn ? 1 : 0, reply);
            await save(session, latest);
          });
        }
      }
    };
    const tidy = async (what: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        onError(error, what);
      }
    };
    const entry: LiveTurn = {
      messages,
      html,
      stop,
      over: write()
        .catch((error: unknown) =>
          onError(error, "the reply could not be stored"),
        )
        .finally(async () => {
          clearInterval(watch);
          if (live.get(conversation.id) === entry) live.delete(conversation.id);
          html.end();
          // The end goes out once the reply is stored, then the record and
          // the claim: a server that sees them gone finds the message stored.
          say({ type: "end" });
          await tidy("the reply's end was not sent", () => outbox);
          if (!lost) {
            await tidy("the reply's record was not removed", () =>
              shared.delete(recordKey(conversation.id)),
            );
          }
          await tidy("Stop's signal was not removed", () =>
            shared.delete(stopKey(conversation.id, held.turn)),
          );
          await tidy("the claim was not released", () => held.lease.release());
        }),
    };
    live.set(conversation.id, entry);
    return entry;
  }

  /**
   * A reply another server is writing, followed from its channel into a
   * broadcast of its own: one subscription per reply however many pages
   * read it here, and a page that joins late gets it from the start.
   */
  function follow(conversation: Conversation, record: TurnRecord): LiveTurn {
    const html = createBroadcast<string>();
    const stop = new AbortController();
    stop.signal.addEventListener(
      "abort",
      () => {
        shared
          .set(stopKey(conversation.id, record.turn), "1", LEASE_MS)
          .catch((error: unknown) =>
            onError(error, "Stop did not reach the server writing this reply"),
          );
      },
      { once: true },
    );
    const done = new AbortController();
    const relay = async (): Promise<void> => {
      const events = shared
        .subscribe(channelKey(conversation.id, record.turn), {
          signal: done.signal,
        })
        [Symbol.asyncIterator]();
      let next = events.next();
      let gone = 0;
      for (;;) {
        const got = await within(next, FOLLOW_IDLE_MS);
        if (got === undefined) {
          // Silence: is the writer still there? Its record, renewed with its
          // claim, says. One missed look is not enough: it may be mid-cleanup.
          let there = true;
          try {
            const raw = await shared.get(recordKey(conversation.id));
            // A record of a later reply is not this writer being there.
            there =
              raw !== undefined &&
              (JSON.parse(raw) as TurnRecord).turn === record.turn;
          } catch {
            // Not knowing is not a reason to give up.
          }
          gone = there ? 0 : gone + 1;
          if (gone < 2) continue;
          html.push(failedNotice(WRITER_GONE));
          return;
        }
        gone = 0;
        if (got.done) {
          html.push(failedNotice(WRITER_GONE));
          return;
        }
        const event = got.value;
        if (event.type === "end") return;
        html.push(
          event.type === "gap"
            ? `<p data-testid="turn-gap">The start of this reply is no longer available here. All of it appears when it is finished.</p>`
            : event.data,
        );
        next = events.next();
      }
    };
    const entry: LiveTurn = {
      messages: conversation.messages.slice(0, record.count),
      html,
      stop,
      over: relay()
        .catch((error: unknown) => {
          onError(error, "this reply could not be followed");
          html.push(failedNotice(WRITER_GONE));
        })
        .finally(() => {
          done.abort();
          if (live.get(conversation.id) === entry) live.delete(conversation.id);
          html.end();
        }),
    };
    live.set(conversation.id, entry);
    return entry;
  }

  /** The reply being written for a conversation, by this server or another, or undefined. */
  async function following(
    conversation: Conversation,
  ): Promise<LiveTurn | undefined> {
    const here = live.get(conversation.id);
    if (here) return here;
    let record: TurnRecord;
    try {
      const raw = await shared.get(recordKey(conversation.id));
      if (raw === undefined) return undefined;
      record = JSON.parse(raw) as TurnRecord;
    } catch (error) {
      onError(error, "the shared store did not answer");
      return undefined;
    }
    // Another page may have joined while this one waited.
    return live.get(conversation.id) ?? follow(conversation, record);
  }

  /** Claim the conversation and start its reply, or join the reply whoever holds it is writing. */
  async function claimTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
  ): Promise<LiveTurn | undefined> {
    let lease: Lease | null = null;
    try {
      for (let tries = 0; ; tries++) {
        lease = await shared.claim(leaseKey(conversation.id), LEASE_MS);
        if (lease) break;
        // Held elsewhere: that server records its reply straight away, or
        // is just finishing the last one and lets go.
        const turn = await following(conversation);
        if (turn) return turn;
        if (tries >= 9) return undefined;
        await sleep(50);
      }
      // The holder before this one may have finished between this page's
      // reading the conversation and the claim: only a message still
      // waiting is answered.
      const fresh = (await load(session, conversation.id)) ?? conversation;
      if (!turnPending(fresh.messages)) {
        await lease.release();
        return undefined;
      }
      const turn = randomUUID();
      const record: TurnRecord = { turn, count: fresh.messages.length };
      await shared.set(
        recordKey(conversation.id),
        JSON.stringify(record),
        LEASE_MS,
      );
      return startTurn(session, fresh, request, { lease, turn });
    } catch (error) {
      onError(error, "no reply could be started");
      await lease?.release().catch(() => {});
      return undefined;
    }
  }

  /** Two pages of one server asking at once start one reply. */
  const starting = new Map<string, Promise<LiveTurn | undefined>>();
  function startOnce(
    session: Session,
    conversation: Conversation,
    request: Request,
  ): Promise<LiveTurn | undefined> {
    let pending = starting.get(conversation.id);
    if (!pending) {
      pending = claimTurn(session, conversation, request).finally(() =>
        starting.delete(conversation.id),
      );
      starting.set(conversation.id, pending);
    }
    return pending;
  }

  const states = new WeakMap<Request, Promise<ThreadState>>();

  function thread(request: Request): Promise<ThreadState> {
    let state = states.get(request);
    if (!state) {
      state = (async () => {
        const session = sessions.identify(request);
        let conversation = await load(session);
        let turn = conversation ? await following(conversation) : undefined;
        if (conversation && !turn && turnPending(conversation.messages)) {
          // No reply is being written right now, so the store is settled:
          // read it once more, and start the turn.
          conversation = (await load(session)) ?? conversation;
          turn = await following(conversation);
          if (!turn && turnPending(conversation.messages)) {
            turn = await startOnce(session, conversation, request);
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

  async function stopTurn(conversationId: string): Promise<boolean> {
    const entry = live.get(conversationId);
    if (entry) {
      entry.stop.abort();
      await entry.over;
      return true;
    }
    // Perhaps another server is writing it: ask it to stop, and wait for it.
    try {
      const raw = await shared.get(recordKey(conversationId));
      if (raw === undefined) return false;
      const record = JSON.parse(raw) as TurnRecord;
      await shared.set(stopKey(conversationId, record.turn), "1", LEASE_MS);
      for (
        const until = Date.now() + LEASE_MS;
        Date.now() < until && (await shared.get(recordKey(conversationId)));
      ) {
        await sleep(50);
      }
    } catch (error) {
      onError(error, "Stop did not reach the shared store");
      return false;
    }
    return true;
  }

  /* Voice: the turn being recorded for each conversation. It is in the
     shared store, so a call's tool calls may land on different servers. */

  /**
   * Whether a voice call may use this conversation. A fixed provider serves
   * every request. A picker serves only the conversations it opened a voice
   * session for (within `VOICE_MS` of the last use): a picker that offers no
   * provider leaves the voice handlers answering 404, like no `voice` at all.
   */
  const pickedVoice = typeof options.voice === "function";
  const voiceOpenKey = (conversationId: string): string =>
    `${ns}voice-open:${conversationId}`;
  const voiceOpen = async (conversationId: string): Promise<boolean> => {
    if (options.voice == null) return false;
    if (!pickedVoice) return true;
    const key = voiceOpenKey(conversationId);
    if ((await shared.get(key)) === undefined) return false;
    // Kept while the call goes on, as the turn is.
    await shared.set(key, "1", VOICE_MS);
    return true;
  };
  const noVoice = (): Response =>
    new Response("This server has no voice provider.", {
      status: 404,
      headers: NO_STORE,
    });
  const voiceKey = (conversationId: string): string =>
    `${ns}voice:${conversationId}`;
  /** `call` is a `voiceCallId`, so it is short and safe in a key. */
  const viewKey = (conversationId: string, call: string): string =>
    `${ns}view:${conversationId}:${call}`;
  const readVoice = async (conversationId: string): Promise<VoiceTurn> => {
    const raw = await shared.get(voiceKey(conversationId));
    return raw === undefined ? newVoiceTurn() : (JSON.parse(raw) as VoiceTurn);
  };
  /**
   * Change a conversation's recorded turn with no one else changing it. Held
   * only for the read, the change and the write, never while a tool runs.
   */
  async function updateVoice<T>(
    conversationId: string,
    change: (turn: VoiceTurn) => T | Promise<T>,
  ): Promise<T> {
    let lock: Lease | null = null;
    for (let tries = 0; !lock; tries++) {
      lock = await shared.claim(`${ns}voice-lock:${conversationId}`, 5000);
      if (!lock) {
        if (tries >= 200) throw new Error("The voice call's state is busy.");
        await sleep(25);
      }
    }
    try {
      const turn = await readVoice(conversationId);
      const result = await change(turn);
      await shared.set(
        voiceKey(conversationId),
        JSON.stringify(turn),
        VOICE_MS,
      );
      return result;
    } finally {
      await lock.release();
    }
  }

  /* Handlers */

  const send: Chat["send"] = async (request) => {
    // A body past the limit is turned away; past it, nothing more is read.
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) {
      if (fileStore && form.status === 413) {
        const declared = Number(request.headers.get("content-length"));
        return refusedPage(
          refusals.total(
            declared > maxBodyBytes ? declared : maxBodyBytes + 1,
            fileLimits.maxTotalBytes,
          ),
          "",
          page,
        );
      }
      return form;
    }
    const session = sessions.identify(request);
    const text = messageFrom(form).slice(0, MAX_MESSAGE);
    if (form.get("voice") === "1") {
      // The call stores its own turns: this only says what to say.
      return Response.json({ say: text }, { headers: NO_STORE });
    }
    const attached = await attach(session, form, text);
    if (attached instanceof Response) return attached;
    if (!text && attached.length === 0) {
      const conversation = (await load(session)) ?? newConversation();
      return redirect(session, conversation.id);
    }
    let added: Conversation;
    try {
      added = await addMessage(session, text, { files: attached });
    } catch (error) {
      if (error instanceof ConversationFullError) return conversationFull();
      throw error;
    }
    return redirect(session, added.id);
  };

  const file: Chat["file"] = async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    }
    const id = new URL(request.url).searchParams.get("id");
    const { reader } = sessions.identify(request);
    // Looked up under the reader's own key: another reader's file is not found.
    const found =
      fileStore && isSafeKey(id) ? await fileStore.get(reader, id) : null;
    return found
      ? fileResponse(found)
      : new Response("No such file.", { status: 404, headers: NO_STORE });
  };

  const approve: Chat["approve"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const call = field(form, "call");
    const verdict = form.get("verdict");
    return changingOpen(session, async (conversation) => {
      if (
        !conversation ||
        call === undefined ||
        (verdict !== "approve" && verdict !== "deny") ||
        !decideToolCall(conversation.messages, call, verdict === "approve")
      ) {
        return badRequest("No tool call is waiting for that answer.");
      }
      await save(session, conversation);
      return redirect(session, conversation.id);
    });
  };

  const answer: Chat["answer"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const call = field(form, "call");
    const output = field(form, "output")?.trim();
    return changingOpen(session, async (conversation) => {
      if (
        !conversation ||
        call === undefined ||
        !output ||
        !answerToolCall(conversation.messages, call, output)
      ) {
        return badRequest("No tool call is waiting for that result.");
      }
      await save(session, conversation);
      return redirect(session, conversation.id);
    });
  };

  const stop: Chat["stop"] = async (request) => {
    // Only the reader's own conversation: its id in a cookie is not enough.
    const conversation = await load(sessions.identify(request));
    const stopped = conversation !== null && (await stopTurn(conversation.id));
    return new Response(null, { status: stopped ? 204 : 404 });
  };

  const open: Chat["open"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const conversation =
      (await load(session, field(form, "id") ?? "")) ?? newConversation();
    return redirect(session, conversation.id);
  };

  const forget: Chat["forget"] = async (request) => {
    const form = await formOf(request, "Not a form.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const memoryId = field(form, "id");
    if (!memory || memoryId === undefined) {
      return badRequest("No memory to forget.");
    }
    await forgetMemory(memory, session.reader, memoryId);
    // Back to where the form was: a path on this site, never another one.
    const headers = session.conversationId
      ? sessions.remember(session, session.conversationId)
      : new Headers();
    headers.set("location", localPath(field(form, "back")) ?? page);
    return new Response(null, { status: 303, headers });
  };

  const memories: Chat["memories"] = async (request) =>
    memory ? memory.list(sessions.identify(request).reader) : [];

  const memoryList: Chat["memoryList"] = async (request) =>
    Response.json({ memories: await memories(request) }, { headers: NO_STORE });

  const search: Chat["search"] = async (request) => {
    const session = sessions.identify(request);
    const query = (new URL(request.url).searchParams.get("q") ?? "")
      .trim()
      .slice(0, MAX_QUERY);
    const tooShort = query.length < MIN_QUERY;
    return {
      query,
      tooShort,
      matches: tooShort
        ? []
        : await searchConversations(store, session.reader, query, SEARCH_LIMIT),
    };
  };

  const voiceSession: Chat["voiceSession"] = async (request) => {
    const session = sessions.identify(request);
    const wanted = new URL(request.url).searchParams.get("provider");
    const voice =
      typeof options.voice === "function"
        ? await options.voice(wanted)
        : (options.voice ?? null);
    if (!voice) {
      return new Response("This server has no voice provider.", {
        status: 404,
      });
    }
    // What is said is stored, so there has to be a conversation to store it
    // in. A new one has an id of its own, which nothing else writes yet.
    let conversation = await changingOpen(session, async (found) => found);
    if (!conversation) {
      const created = newConversation();
      await serialized(session, created.id, () => save(session, created));
      conversation = created;
    }
    let ticket;
    try {
      ticket = await voice.createSession({
        system: await promptFor(true, session),
        tools: voiceTools(toolsFor(session, conversation.id)),
      });
    } catch (error) {
      onError(error, "no voice session");
      return new Response("The voice provider did not answer.", {
        status: 502,
      });
    }
    if (pickedVoice) {
      // The picker offered a provider for this conversation: its tool calls
      // and turns are taken from now on.
      try {
        await shared.set(voiceOpenKey(conversation.id), "1", VOICE_MS);
      } catch (error) {
        onError(error, "the shared store did not answer");
        return new Response("The voice call could not be started.", {
          status: 502,
        });
      }
    }
    const headers = sessions.remember(session, conversation.id);
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(ticket), { headers });
  };

  const voiceTool: Chat["voiceTool"] = async (request) => {
    const form = await formOf(request, "Not a tool call.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const callId = field(form, "id");
    const name = field(form, "name");
    const raw = field(form, "input");
    const decision = form.get("decision");
    const conversation = await load(session);
    if (
      !conversation ||
      callId === undefined ||
      name === undefined ||
      raw === undefined ||
      raw.length > MAX_TOOL_INPUT ||
      (decision !== null && decision !== "approve" && decision !== "deny")
    ) {
      return badRequest("Not a tool call.");
    }
    if (!(await voiceOpen(conversation.id))) return noVoice();
    if (!roomIn(conversation, [])) {
      // Nothing more of this call could be stored: the model is told now.
      return Response.json(
        {
          state: "failed",
          output: `Error: ${new ConversationFullError().message}`,
          view: false,
        },
        { headers: NO_STORE },
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      // Passed on as it is: the call is refused, and the model is told.
      input = raw;
    }
    const tools = toolsFor(session, conversation.id);
    const catalogNow = await catalog();
    // Keep what a call shows, and no more than MAX_VOICE_VIEWS of them for
    // the conversation. Called under the turn's lock.
    // The id the call is recorded under, and its view kept under.
    const call = voiceCallId(callId);
    const keepView = async (turn: VoiceTurn, html: string): Promise<void> => {
      if (!html) return;
      await shared.set(viewKey(conversation.id, call), html, VOICE_MS);
      for (const old of noteVoiceView(turn, call)) {
        await shared.delete(viewKey(conversation.id, old));
      }
    };
    // Record the call, or claim the call a decision answers, on the latest
    // turn under its lock: of requests that overlap, one claims a call and
    // the others are refused, so a call runs at most once.
    const started = await updateVoice(conversation.id, async (latest) => {
      const start = startVoiceTool(
        latest,
        { id: call, name, input, ...(decision ? { decision } : {}) },
        tools,
        catalogNow,
        renderOptions,
      );
      if (start.run) start.run = structuredClone(start.run);
      else await keepView(latest, start.result!.html);
      return start;
    });
    let result = started.result!;
    let shown = !started.run && result.html !== "";
    if (started.run) {
      // Run with no lock held, then record what came of it.
      result = await finishVoiceTool(
        started.run,
        tools,
        catalogNow,
        renderOptions,
      );
      shown = await updateVoice(conversation.id, async (latest) => {
        // Only into the turn that claimed it: a turn stored meanwhile
        // recorded the call as ended, and the next one is not its own, even
        // when it holds a call with the same id.
        if ((latest.round ?? 0) !== started.round) return false;
        settleVoiceTool(latest, started.run!, started.round);
        await keepView(latest, result.html);
        return result.html !== "";
      });
    }
    return Response.json(
      { state: result.state, output: result.output, view: shown },
      { headers: NO_STORE },
    );
  };

  const voiceTurn: Chat["voiceTurn"] = async (request) => {
    const form = await formOf(request, "Not a voice turn.");
    if (form instanceof Response) return form;
    const session = sessions.identify(request);
    const reader = field(form, "reader");
    const model = field(form, "model");
    return changingOpen(session, async (conversation) => {
      if (!conversation || reader === undefined || model === undefined) {
        return badRequest("Not a voice turn.");
      }
      if (!(await voiceOpen(conversation.id))) return noVoice();
      // The turn is taken either way: one with no room is dropped, not kept
      // to be refused again.
      const messages = await updateVoice(conversation.id, (turn) =>
        voiceMessages(turn, {
          reader: reader.slice(0, MAX_SPEECH),
          model: model.slice(0, MAX_SPEECH),
        }),
      );
      if (!messages.length) return new Response(null, { status: 204 });
      if (!roomIn(conversation, messages)) return conversationFull();
      abandonToolCalls(conversation.messages);
      if (conversation.messages.length === 0) {
        conversation.title = titleOf(
          messages[0]!.content || "Voice conversation",
        );
      }
      conversation.messages.push(...messages);
      await save(session, conversation);
      return new Response(null, { status: 204 });
    });
  };

  return {
    send,
    approve,
    answer,
    stop,
    open,
    forget,
    memoryList,
    voiceSession,
    voiceTool,
    voiceTurn,
    file,
    thread,
    memories,
    search,
    async voiceView(request, call) {
      // With no voice provider there are no voice views: nothing is looked up.
      if (options.voice == null) return "";
      const conversation = await load(sessions.identify(request));
      if (!conversation) return "";
      try {
        if (!(await voiceOpen(conversation.id))) return "";
        // Under the id the call was recorded under, as voiceTool keeps it.
        return (
          (await shared.get(viewKey(conversation.id, voiceCallId(call)))) ?? ""
        );
      } catch (error) {
        onError(error, "the shared store did not answer");
        return "";
      }
    },
    catalog,
    renderOptions,
    systemPrompt: () => promptFor(false),
    sessions,
    store,
    files: fileStore,
    session: (request) => sessions.identify(request),
    load: loadForCaller,
    save: saveForCaller,
    change,
    list: (session) => store.list(session.reader),
    addMessage,
    redirect,
    stopTurn,
  };
}
