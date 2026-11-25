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
import { randomUUID } from "node:crypto";
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
  newVoiceTurn,
  runVoiceTool,
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

const COOKIE_ID = /^[0-9a-f-]{36}$/;

function cookieValue(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) {
      const value = pair.slice(at + 1).trim();
      return COOKIE_ID.test(value) ? value : undefined;
    }
  }
  return undefined;
}

/**
 * The default sessions: an anonymous reader and an open conversation, each in
 * an HttpOnly cookie (`visitor`, and `chat_<id>` so apps on one site keep
 * their own). Readers never see each other's conversations, and a reader who
 * clears cookies starts over. `secure` adds the Secure attribute: set it when
 * the site is served over HTTPS.
 */
export function cookieSessions(
  id = "chat",
  options: { secure?: boolean } = {},
): ChatSessions {
  const attributes = `Path=/; HttpOnly; SameSite=Lax${options.secure ? "; Secure" : ""}`;
  return {
    identify: (request) => ({
      reader: cookieValue(request, "visitor") ?? randomUUID(),
      conversationId: cookieValue(request, `chat_${id}`),
    }),
    remember(session, conversationId) {
      const headers = new Headers();
      headers.append(
        "set-cookie",
        `chat_${id}=${conversationId}; ${attributes}`,
      );
      headers.append(
        "set-cookie",
        `visitor=${session.reader}; Max-Age=31536000; ${attributes}`,
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
 * This is one process's memory. With several servers, a reader who lands on
 * another one mid-reply starts a second reply; put the broadcast in a shared
 * store to fix that.
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
   * `@bascik/genui/memory`.
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
   * the voice session handler answers 404.
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
  /** What is let in: sizes, count, types. Defaults in `@bascik/genui/files`. */
  fileLimits?: FileLimits;
  /** Who the reader is and which conversation is open. Default `cookieSessions(id)`. */
  sessions?: ChatSessions;
  /** The page the form handlers send the reader back to. Default `/`. */
  page?: string;
  /** The longest one reply may take, tools included. Default two minutes. */
  turnLimitMs?: number;
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
  /** Store a conversation, stamping `updatedAt`. */
  save(session: Session, conversation: Conversation): Promise<void>;
  /** The session's reader's conversations, newest first. */
  list(session: Session): Promise<Conversation[]>;
  /**
   * Add the reader's message to their open conversation (a new one when none
   * is open) and store it. The conversation's first message titles it, unless
   * `title` does. Tool calls still waiting for the reader are refused.
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
/** A path on this site: one slash first, never `//host` or `/\host`, no line breaks. */
const LOCAL_PATH = /^\/(?![/\\])[^\r\n]*$/;
/** What a multipart body may carry besides its files: the text and the field framing. */
const MULTIPART_ROOM = 256 * 1024;

/** A conversation's title: the first words of what began it. */
const titleOf = (text: string): string =>
  text.length > 40 ? `${text.slice(0, 40)}…` : text;

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

/** The request's form, or null when it is not one. */
async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}

interface VoiceState {
  turn: VoiceTurn;
  views: Map<string, string>;
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
  const sessions = options.sessions ?? cookieSessions(id);
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
  const save: Chat["save"] = async (session, conversation) => {
    conversation.updatedAt = Date.now();
    await store.save(session.reader, conversation);
  };
  const redirect: Chat["redirect"] = (session, conversationId) => {
    const headers = sessions.remember(session, conversationId);
    headers.set("location", page);
    return new Response(null, { status: 303, headers });
  };
  const addMessage: Chat["addMessage"] = async (session, text, titled) => {
    const conversation = (await load(session)) ?? newConversation();
    const attached = titled?.files ?? [];
    if (conversation.messages.length === 0) {
      conversation.title =
        titled?.title ?? titleOf(text || attached[0]?.name || "Files");
    }
    abandonToolCalls(conversation.messages);
    conversation.messages.push(
      attached.length
        ? {
            role: "user",
            content: text,
            parts: [
              ...(text ? [{ type: "text" as const, text }] : []),
              ...attached,
            ],
          }
        : { role: "user", content: text },
    );
    await save(session, conversation);
    return conversation;
  };

  /* Attached files: how a model reads one, and what a send accepts */

  const fileStore = options.files;
  const fileLimits = resolveLimits(options.fileLimits);
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

  const live = new Map<string, LiveTurn>();

  function startTurn(
    session: Session,
    conversation: Conversation,
    request: Request,
  ): LiveTurn {
    const html = createBroadcast<string>();
    const stop = new AbortController();
    const messages = conversation.messages;
    const carriedOn = messages.at(-1)!.role === "assistant";
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
          html.push(chunk);
        }
      } catch (error) {
        onError(error, "the model failed");
        const sorry = "Something went wrong while writing this reply.";
        message.parts!.push({ type: "text", text: `\n\n${sorry}` });
        message.content = `${message.content}\n\n${sorry}`.trim();
        html.push(`<p class="failed" data-testid="turn-failed">${sorry}</p>`);
      } finally {
        if (message.parts!.length === 0) {
          delete message.parts;
          message.content = "(no reply)";
        }
        // Read the conversation again: the reader may have sent something
        // else while this was being written, and that must not be lost.
        const latest = (await load(session, conversation.id)) ?? conversation;
        const at = messages.length - (carriedOn ? 1 : 0);
        latest.messages.splice(at, carriedOn ? 1 : 0, message);
        await save(session, latest);
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
        .finally(() => {
          if (live.get(conversation.id) === entry) live.delete(conversation.id);
          html.end();
        }),
    };
    live.set(conversation.id, entry);
    return entry;
  }

  const states = new WeakMap<Request, Promise<ThreadState>>();

  function thread(request: Request): Promise<ThreadState> {
    let state = states.get(request);
    if (!state) {
      state = (async () => {
        const session = sessions.identify(request);
        let conversation = await load(session);
        let turn = conversation && live.get(conversation.id);
        if (conversation && !turn && turnPending(conversation.messages)) {
          // No reply is being written right now, so the store is settled:
          // read it once more, and start the turn with nothing awaited in
          // between.
          conversation = (await load(session)) ?? conversation;
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

  async function stopTurn(conversationId: string): Promise<boolean> {
    const entry = live.get(conversationId);
    if (!entry) return false;
    entry.stop.abort();
    await entry.over;
    return true;
  }

  /* Voice: the turn being recorded for each conversation */

  const voiceStates = new Map<string, VoiceState>();
  const voiceState = (conversationId: string): VoiceState => {
    let state = voiceStates.get(conversationId);
    if (!state) {
      state = { turn: newVoiceTurn(), views: new Map() };
      voiceStates.set(conversationId, state);
    }
    return state;
  };

  /* Handlers */

  const send: Chat["send"] = async (request) => {
    // A body far past the limits is turned away before it is read.
    const declared = Number(request.headers.get("content-length"));
    if (fileStore && declared > fileLimits.maxTotalBytes + MULTIPART_ROOM) {
      return refusedPage(
        refusals.total(declared, fileLimits.maxTotalBytes),
        "",
        page,
      );
    }
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
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
    return redirect(
      session,
      (await addMessage(session, text, { files: attached })).id,
    );
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
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
    const session = sessions.identify(request);
    const call = field(form, "call");
    const verdict = form.get("verdict");
    const conversation = await load(session);
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
  };

  const answer: Chat["answer"] = async (request) => {
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
    const session = sessions.identify(request);
    const call = field(form, "call");
    const output = field(form, "output")?.trim();
    const conversation = await load(session);
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
  };

  const stop: Chat["stop"] = async (request) => {
    const { conversationId } = sessions.identify(request);
    const stopped =
      conversationId !== undefined && (await stopTurn(conversationId));
    return new Response(null, { status: stopped ? 204 : 404 });
  };

  const open: Chat["open"] = async (request) => {
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
    const session = sessions.identify(request);
    const conversation =
      (await load(session, field(form, "id") ?? "")) ?? newConversation();
    return redirect(session, conversation.id);
  };

  const forget: Chat["forget"] = async (request) => {
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
    const session = sessions.identify(request);
    const memoryId = field(form, "id");
    if (!memory || memoryId === undefined) {
      return badRequest("No memory to forget.");
    }
    await forgetMemory(memory, session.reader, memoryId);
    // Back to where the form was: a path on this site, never another one.
    const back = field(form, "back");
    const headers = session.conversationId
      ? sessions.remember(session, session.conversationId)
      : new Headers();
    headers.set(
      "location",
      back !== undefined && LOCAL_PATH.test(back) ? back : page,
    );
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
    // What is said is stored, so there has to be a conversation to store it in.
    let conversation = await load(session);
    if (!conversation) {
      conversation = newConversation();
      await save(session, conversation);
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
    const headers = sessions.remember(session, conversation.id);
    headers.set("content-type", "application/json");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(ticket), { headers });
  };

  const voiceTool: Chat["voiceTool"] = async (request) => {
    const form = await readForm(request);
    if (!form) return badRequest("Not a tool call.");
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
    let input: unknown;
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      // Passed on as it is: the call is refused, and the model is told.
      input = raw;
    }
    const state = voiceState(conversation.id);
    const result = await runVoiceTool(
      state.turn,
      { id: callId, name, input, ...(decision ? { decision } : {}) },
      toolsFor(session, conversation.id),
      await catalog(),
      renderOptions,
    );
    if (result.html) state.views.set(callId, result.html);
    return Response.json(
      { state: result.state, output: result.output, view: result.html !== "" },
      { headers: NO_STORE },
    );
  };

  const voiceTurn: Chat["voiceTurn"] = async (request) => {
    const form = await readForm(request);
    if (!form) return badRequest("Not a voice turn.");
    const session = sessions.identify(request);
    const reader = field(form, "reader");
    const model = field(form, "model");
    const conversation = await load(session);
    if (!conversation || reader === undefined || model === undefined) {
      return badRequest("Not a voice turn.");
    }
    const messages = voiceMessages(voiceState(conversation.id).turn, {
      reader: reader.slice(0, MAX_SPEECH),
      model: model.slice(0, MAX_SPEECH),
    });
    if (messages.length) {
      abandonToolCalls(conversation.messages);
      if (conversation.messages.length === 0) {
        conversation.title = titleOf(
          messages[0]!.content || "Voice conversation",
        );
      }
      conversation.messages.push(...messages);
      await save(session, conversation);
    }
    return new Response(null, { status: 204 });
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
      const conversation = await load(sessions.identify(request));
      return (
        (conversation && voiceStates.get(conversation.id)?.views.get(call)) ||
        ""
      );
    },
    catalog,
    renderOptions,
    systemPrompt: () => promptFor(false),
    sessions,
    store,
    files: fileStore,
    session: (request) => sessions.identify(request),
    load,
    save,
    list: (session) => store.list(session.reader),
    addMessage,
    redirect,
    stopTurn,
  };
}
