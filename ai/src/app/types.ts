/**
 * The shapes the chat kit hands out: a reply being written (`LiveTurn`), what
 * a page request shows (`ThreadState`), the `Chat` object `createChat`
 * returns, and the types its handlers and search answer with.
 */
import type { Broadcast } from "../broadcast.ts";
import type { Catalog } from "../catalog.ts";
import type { FileStore } from "../files.ts";
import type { Memory } from "../memory.ts";
import type { ChatMessage, FilePart } from "../model.ts";
import type { TurnRenderOptions } from "../render-turn.ts";
import type { Conversation, ConversationStore, SearchMatch } from "../store.ts";
import type { ChatSessions, Session } from "./sessions.ts";

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

/**
 * What the host serving a request offers, passed as the last argument of a
 * handler or of `thread`. Cloudflare's `ExecutionContext` is one.
 */
export interface HostContext {
  /**
   * Keep the request's work going until `promise` settles, after the response
   * is sent. Given it, a reply this request starts is handed over, so the
   * reply is finished and stored when the reader leaves.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** A web standard handler, with the host's context as an optional last argument. */
export type ChatHandler = (
  request: Request,
  context?: HostContext,
) => Promise<Response>;

export interface Chat {
  /* Handlers: `export const POST = chat.send;` */

  /** Add the reader's message and go back to the page, which streams the reply. */
  send: ChatHandler;
  /** Record the reader's answer to a tool call that needs their say-so. */
  approve: ChatHandler;
  /** Record the result of a client tool call. */
  answer: ChatHandler;
  /** End the reply being written for the open conversation. 204, or 404 when none is. */
  stop: ChatHandler;
  /** Open one of the reader's conversations, or start a new one. */
  open: ChatHandler;
  /**
   * Remove one of the reader's memories: a form post with `id`, and an
   * optional `back`, a path on this site to return to (default: the chat's
   * page). A memory that is not there is not an error: the form is safe to
   * send twice.
   */
  forget: ChatHandler;
  /** The reader's memories as JSON, newest first: `{ memories }`. */
  memoryList: ChatHandler;
  /** Start a spoken conversation: answers with a ticket for the voice provider. */
  voiceSession: ChatHandler;
  /**
   * Serve one attached file: `GET` with `?id=<file id>`. Only to the reader
   * it belongs to; 404 for anyone else, and for an id that is not one.
   */
  file: ChatHandler;
  /** Run a tool call a voice model made. */
  voiceTool: ChatHandler;
  /** Store what was just said in a spoken conversation. */
  voiceTurn: ChatHandler;

  /* What a page needs */

  /**
   * The open conversation and the reply being written, if any. The thread's
   * stream scripts both call this and get one answer per request. When the
   * conversation is waiting for a reply and none is being written, this
   * starts it, and hands the promise that settles once it is stored to
   * `context.waitUntil` when one is given (the first call of a request
   * decides).
   */
  thread(request: Request, context?: HostContext): Promise<ThreadState>;
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
