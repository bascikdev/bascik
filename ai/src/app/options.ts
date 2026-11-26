/**
 * `ChatOptions`: everything `createChat` is given. Where conversations live,
 * who the reader is, which model answers and which voice provider is offered
 * all come from here, never from the request.
 */
import type { Catalog } from "../catalog.ts";
import type { FileLimits, FileStore } from "../files.ts";
import type { MemoryStore } from "../memory.ts";
import type { Model, Tool } from "../model.ts";
import type { TurnRenderOptions } from "../render-turn.ts";
import type { Shared } from "../shared.ts";
import type { ConversationStore } from "../store.ts";
import type { VoiceProvider } from "../voice.ts";
import type { ChatSessions } from "./sessions.ts";

export interface ChatOptions {
  /** Names this chat: its cookie and its log lines. Give each app of one site its own. Default `chat`. */
  id?: string;
  /** Where conversations are kept. */
  store: ConversationStore;
  /**
   * The most conversations one reader keeps. Starting one more deletes their
   * oldest, through the store's `delete`; a store without it refuses the new
   * conversation. Default 200.
   */
  maxConversations?: number;
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
  /** How many times one reply may ask the model, tool rounds included. Default 8. */
  maxRounds?: number;
  /**
   * Default true: a request may read a reply another request on this server
   * is writing straight from memory, and two pages asking at once start one
   * reply. False never hands one request another request's stream or
   * promise: each follows a reply through `shared.subscribe` and the turn
   * record, Stop goes through the shared store, and writes to one
   * conversation are not queued in memory (the store has to arbitrate).
   * Set it to false on a host where one request must not touch another
   * request's I/O, such as Cloudflare Workers.
   */
  followLocally?: boolean;
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
