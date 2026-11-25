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
import type { ChatMessage, Model, Tool } from "./model.ts";
import { renderTurn, type TurnRenderOptions } from "./render-turn.ts";
import {
  abandonToolCalls,
  answerToolCall,
  decideToolCall,
  runTurn,
  turnPending,
} from "./turn.ts";
import {
  newConversation,
  type Conversation,
  type ConversationStore,
} from "./store.ts";
import {
  inProcessShared,
  type ChannelEvent,
  type Lease,
  type Shared,
} from "./shared.ts";
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
  fileStore,
  memoryStore,
  newConversation,
  type Conversation,
  type ConversationStore,
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
  /** Who the reader is and which conversation is open. Default `cookieSessions(id)`. */
  sessions?: ChatSessions;
  /** The page the form handlers send the reader back to. Default `/`. */
  page?: string;
  /** The longest one reply may take, tools included. Default two minutes. */
  turnLimitMs?: number;
  /**
   * State that must be the same on every server: the reply being written,
   * Stop, and a voice call's turn. Default `inProcessShared()`, which is
   * right for one server. For several, pass an implementation over a store
   * they all reach (see `@bascik/genui/shared`).
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
  /** Start a spoken conversation: answers with a ticket for the voice provider. */
  voiceSession: (request: Request) => Promise<Response>;
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
  /** The HTML of what a voice tool call put on screen ("" when it put nothing). */
  voiceView(request: Request, call: string): Promise<string>;
  /** The loaded catalog. */
  catalog(): Promise<Catalog>;
  /** The options that render this chat's replies: `renderTurn`, `renderMessage`. */
  renderOptions: TurnRenderOptions;
  /** What a text reply's model is told. */
  systemPrompt(): Promise<string>;

  /* For handlers of your own */

  sessions: ChatSessions;
  store: ConversationStore;
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
    options?: { title?: string },
  ): Promise<Conversation>;
  /** A 303 to the page, remembering the open conversation: a form POST ends in a GET, so reload is safe. */
  redirect(session: Session, conversationId: string): Response;
  /** Stop the conversation's reply, and wait until what it wrote is stored. False when none is being written. */
  stopTurn(conversationId: string): Promise<boolean>;
}

/** A message the reader sends is kept to this many characters. */
const MAX_MESSAGE = 4000;
/** What a voice session stores of one turn's speech. */
const MAX_SPEECH = 8000;
/** A voice tool call's input, as sent. */
const MAX_TOOL_INPUT = 64_000;
const NO_STORE = { "cache-control": "no-store" };

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

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** Apply to `latest` what a tool call changed in a copy of the turn (`before` became `after`). */
function mergeVoiceTurn(
  latest: VoiceTurn,
  before: VoiceTurn,
  after: VoiceTurn,
): void {
  after.parts.forEach((part, at) => {
    if (at >= before.parts.length) {
      latest.parts.push(part);
    } else if (!same(part, before.parts[at]) && part.type === "tool") {
      // A call that was waiting for approval moved on.
      const found = latest.parts.findIndex(
        (other) => other.type === "tool" && other.id === part.id,
      );
      if (found >= 0) latest.parts[found] = part;
    }
  });
  if (!same(after.lastView, before.lastView)) latest.lastView = after.lastView;
}

export function createChat(options: ChatOptions): Chat {
  const {
    id = "chat",
    store,
    tools = [],
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
    tools: options.render?.tools ?? tools,
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
  const promptFor = async (voice: boolean): Promise<string> => {
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
    if (conversation.messages.length === 0) {
      conversation.title = titled?.title ?? titleOf(text);
    }
    abandonToolCalls(conversation.messages);
    conversation.messages.push({ role: "user", content: text });
    await save(session, conversation);
    return conversation;
  };

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
          system: await promptFor(false),
          messages,
          tools,
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
          // Read the conversation again: the reader may have sent something
          // else while this was being written, and that must not be lost.
          const latest = (await load(session, conversation.id)) ?? conversation;
          const at = messages.length - (carriedOn ? 1 : 0);
          latest.messages.splice(at, carriedOn ? 1 : 0, message);
          await save(session, latest);
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

  const voiceKey = (conversationId: string): string =>
    `${ns}voice:${conversationId}`;
  const viewKey = (conversationId: string, call: string): string =>
    `${ns}view:${conversationId}:${call.slice(0, 200)}`;
  const readVoice = async (conversationId: string): Promise<VoiceTurn> => {
    const raw = await shared.get(voiceKey(conversationId));
    return raw === undefined ? newVoiceTurn() : (JSON.parse(raw) as VoiceTurn);
  };
  /**
   * Change a conversation's recorded turn with no one else changing it. Held
   * only for the read and the write, never while a tool runs.
   */
  async function updateVoice<T>(
    conversationId: string,
    change: (turn: VoiceTurn) => T,
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
      const result = change(turn);
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
    const form = await readForm(request);
    if (!form) return badRequest("Not a form.");
    const session = sessions.identify(request);
    const text = messageFrom(form).slice(0, MAX_MESSAGE);
    if (form.get("voice") === "1") {
      // The call stores its own turns: this only says what to say.
      return Response.json({ say: text }, { headers: NO_STORE });
    }
    if (!text) {
      const conversation = (await load(session)) ?? newConversation();
      return redirect(session, conversation.id);
    }
    return redirect(session, (await addMessage(session, text)).id);
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
        system: await promptFor(true),
        tools: voiceTools(tools),
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
    // Run on a copy, so calls that overlap each change only their own part,
    // then merge what changed into the recorded turn.
    const before = await readVoice(conversation.id);
    const turn = structuredClone(before);
    const result = await runVoiceTool(
      turn,
      { id: callId, name, input, ...(decision ? { decision } : {}) },
      tools,
      await catalog(),
      renderOptions,
    );
    await updateVoice(conversation.id, (latest) =>
      mergeVoiceTurn(latest, before, turn),
    );
    if (result.html) {
      await shared.set(viewKey(conversation.id, callId), result.html, VOICE_MS);
    }
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
    const messages = await updateVoice(conversation.id, (turn) =>
      voiceMessages(turn, {
        reader: reader.slice(0, MAX_SPEECH),
        model: model.slice(0, MAX_SPEECH),
      }),
    );
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
    voiceSession,
    voiceTool,
    voiceTurn,
    thread,
    async voiceView(request, call) {
      const conversation = await load(sessions.identify(request));
      if (!conversation) return "";
      try {
        return (await shared.get(viewKey(conversation.id, call))) ?? "";
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
    session: (request) => sessions.identify(request),
    load,
    save,
    list: (session) => store.list(session.reader),
    addMessage,
    redirect,
    stopTurn,
  };
}
