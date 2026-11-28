/**
 * What the chat's data parts print. A data part (`chat-turns`,
 * `chat-conversations`, `chat-find`, `chat-models`, `chat-memories` in
 * components/chat) is a component whose request-time script is one call to a
 * function here, handed the project's chat module:
 *
 *   import { storedTurns } from "@bascik/ai/app";
 *   export default (request: Request, context: unknown) =>
 *     storedTurns(import("@/lib/chat.ts"), request, context);
 *
 * The module is the project's own, `src/lib/chat.ts`, and its default export
 * is a `ChatProject`, or a function of the request that returns one. Every
 * function here answers with component tags, which Bascik renders at request
 * time, and every value a reader or a model wrote goes through `html`, so it
 * reaches the page as text.
 */
import { esc, html, raw, type SafeHtml } from "@bascik/bascik/html";
import { formatSize, isImageType } from "../files.ts";
import { filesOf, partsOf, shownOf } from "../model.ts";
import { renderMessage } from "../render-turn.ts";
import type { SearchMatch } from "../store.ts";
import type { Chat, HostContext } from "./types.ts";

/** What an empty conversation shows. */
export interface ChatWelcome {
  /** The title. "How can I help?" without one. */
  heading?: string;
  /** The line under the title. */
  tagline?: string;
  /** A line of the project's own under the tagline: text, or markup written with `html`. */
  note?: string | SafeHtml;
  /** Messages to start with: each is a button that sends `say`. */
  suggestions?: readonly { label: string; say: string }[];
}

/** One model a reader may pick. */
export interface ModelOption {
  /** Posted as `model` when it is chosen. */
  id: string;
  /** The name the list shows. */
  name: string;
  /** The heading it is listed under. Options with none are listed first. */
  group?: string;
}

/** The models a reader may pick from, for `chat-models`. */
export interface ModelMenu {
  options: readonly ModelOption[];
  /** The id of the model in use. */
  chosen?: string;
  /** The text above the list. "Model" without one. */
  label?: string;
  /** The button's text. "Use" without one. */
  useLabel?: string;
  /** Lines under the list: text, or paragraphs written with `html`. */
  notes?: readonly (string | SafeHtml)[];
}

/**
 * Where the parts the data parts print post to, for a project whose routes
 * are not at the parts' own defaults. A part the project writes in a page
 * takes its route as a prop instead.
 */
export interface ChatRoutes {
  /** Opens a conversation: `conversation-item` and `search-result`. Default `/api/open`. */
  open?: string;
  /** Stores the chosen model: `model-picker`. Default `/api/model`. */
  model?: string;
  /** Forgets a memory: `memory-item`. Default `/api/forget`. */
  forget?: string;
  /** Serves an attached file, and gets `?id=`. Default `/api/file`. */
  file?: string;
}

/**
 * The words the data parts print, for a project in another language or with
 * its own voice. Each has the default its comment gives.
 */
export interface ChatWords {
  /** The conversation list's name for a screen reader. "Conversations". */
  conversations?: string;
  /** The search box's name for a screen reader. "Search conversations". */
  search?: string;
  /** The search box's placeholder. "Search conversations". */
  searchPlaceholder?: string;
  /** The search button. "Search". */
  searchGo?: string;
  /** The link that ends a search. "Clear". */
  searchClear?: string;
  /** Said of a search too short to run. "Type at least 2 characters." */
  searchTooShort?: string;
  /** Said when nothing matched the words searched for. */
  searchEmpty?: (query: string) => string;
  /** Said above the results. "3 found". */
  searchFound?: (count: number) => string;
  /** The link to messages older than a page shows. "Show 12 earlier messages". */
  earlier?: (count: number) => string;
}

/**
 * What a project's `src/lib/chat.ts` exports by default: its chat, and the
 * few choices the data parts cannot make for it. Only `chat` is required.
 */
export interface ChatProject {
  /** The chat `createChat` made. */
  chat: Chat;
  /** The host's context for this request (`waitUntil` on Workers), handed to `chat.thread`. */
  host?: HostContext;
  /**
   * Posted as `app` by every form a data part prints: an item of the list, a
   * search result, the model picker, a memory's Forget. A site with one chat
   * needs none. A part written in a page or a template does not read this
   * module, `chat-app`'s own `chat-new` and `chat-composer` included: a site
   * with several chats writes those with `data-bascik-prop-app`.
   */
  app?: string;
  /**
   * Where a search loads and its Clear link leads, for a sidebar that is also
   * on pages that are not the chat. Without it, both stay on the page the
   * part is on.
   */
  page?: string;
  /** The routes of the parts the data parts print, where they are not the defaults. */
  routes?: ChatRoutes;
  /** The words the data parts print, where they are not the defaults. */
  words?: ChatWords;
  /** What an empty conversation shows. `false` prints no welcome. */
  welcome?: ChatWelcome | false;
  /**
   * The models `chat-models` offers, or a function of the request that lists
   * them, which is where a reader's own choice is read. With none, it prints
   * nothing.
   */
  models?:
    | ModelMenu
    | ((
        request: Request,
        // The platform decides the context's shape, so the project types it.
        context?: any,
      ) => ModelMenu | Promise<ModelMenu>);
}

/** The default export of `src/lib/chat.ts`: the project, or a function of the request that returns it. */
export type ChatProjectSource =
  | ChatProject
  | ((
      request: Request,
      // The platform decides the context's shape, so the project types it.
      context?: any,
    ) => ChatProject | Promise<ChatProject>);

/**
 * What a data part hands over: the project's module as `import()` returns
 * it, the module itself, or its default export.
 */
export type ChatProjectModule =
  Promise<{ default?: unknown }> | { default?: unknown } | ChatProjectSource;

const SETUP = [
  "Create src/lib/chat.ts with a default export that holds your chat:",
  "",
  '  import { createChat, memoryStore } from "@bascik/ai/app";',
  "  export default { chat: createChat({ store: memoryStore(), catalog, model }) };",
  "",
  "or, in your copy of the part, change the import to where your chat is.",
].join("\n");

const isChat = (value: unknown): value is Chat =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Chat).thread === "function" &&
  typeof (value as Chat).session === "function";

/**
 * The project of one request, from what a data part imported. A module that
 * is missing, or that exports something else, fails with what to create.
 */
export async function chatProject(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): Promise<ChatProject> {
  let loaded: unknown;
  try {
    loaded = await from;
  } catch (error) {
    // Node adds the importing script, a long data: URL, after the reason.
    const reason = (error instanceof Error ? error.message : String(error))
      .split(" imported from ")[0]!
      .trim();
    throw new Error(
      `@bascik/ai: the chat parts read this project's chat from src/lib/chat.ts, and it could not be loaded: ${reason}\n${SETUP}`,
      { cause: error },
    );
  }
  const source =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? (loaded as { default?: unknown }).default
      : loaded;
  const project: unknown =
    typeof source === "function"
      ? await (source as (request: Request, context?: unknown) => unknown)(
          request,
          context,
        )
      : source;
  if (
    typeof project !== "object" ||
    project === null ||
    !isChat((project as ChatProject).chat)
  ) {
    throw new Error(
      `@bascik/ai: the default export of src/lib/chat.ts is not a chat project: it is an object with a \`chat\` made by createChat, or a function of the request that returns one.\n${SETUP}`,
    );
  }
  return project as ChatProject;
}

/** How many messages a page load renders unless the reader asks for all. */
const RECENT = 40;

const fileHref = (project: ChatProject, id: string): string => {
  const route = project.routes?.file ?? "/api/file";
  return `${route}${route.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`;
};

/**
 * A component's opening tag with the props that have a value. A prop left
 * out keeps the part's own default, and every value is written as text.
 */
const open = (
  name: string,
  props: Record<string, string | undefined>,
): SafeHtml =>
  raw(
    `<${name}${Object.entries(props)
      .map(([prop, value]) =>
        value === undefined ? "" : ` data-bascik-prop-${prop}="${esc(value)}"`,
      )
      .join("")}>`,
  );

/** The `chat-welcome` tag of a project, or nothing when it wants none. */
function welcomeOf(project: ChatProject): SafeHtml | "" {
  if (project.welcome === false) return "";
  const welcome = project.welcome ?? {};
  return html`<chat-welcome
    data-bascik-prop-heading="${welcome.heading ?? "How can I help?"}"
    data-bascik-prop-tagline="${welcome.tagline ?? ""}"
  >
    ${
      welcome.note
        ? html`<template data-bascik-slot="note"
            >${
              typeof welcome.note === "string"
                ? html`<p>${welcome.note}</p>`
                : welcome.note
            }</template
          >`
        : ""
    }
    ${(welcome.suggestions ?? []).map(
      (suggestion) =>
        html`<ask-button data-bascik-prop-say="${suggestion.say}"
          >${suggestion.label}</ask-button
        >`,
    )}
  </chat-welcome>`;
}

/**
 * The conversation so far, one piece per message, for a stream script: the
 * welcome when there is none, else a link to older messages when there are
 * more than a page shows, then each turn. Stored replies are the model's own
 * text, rendered through the chat's catalog as a live reply is. While a
 * reply is being written this is the conversation as it was when that reply
 * started, so the reply is shown once, by `liveTurn`.
 */
export function storedTurns(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): AsyncGenerator<SafeHtml> {
  const loading = chatProject(from, request, context);
  // The stream may be dropped before it is read: the failure is then no one's.
  loading.catch(() => {});
  return (async function* () {
    let project: ChatProject;
    try {
      project = await loading;
    } catch (error) {
      // An empty thread says nothing: the page says where to look.
      yield html`<p data-chat-part="failed" data-testid="chat-setup-failed">
        This chat is not set up yet. The server's log says what is missing.
      </p>`;
      throw error;
    }
    const { chat } = project;
    const { messages: stored } = await chat.thread(request, project.host);
    if (stored.length === 0) {
      const welcome = welcomeOf(project);
      if (welcome) yield welcome;
      return;
    }
    const catalog = await chat.catalog();
    const all = new URL(request.url).searchParams.has("all");
    const messages = all ? stored : stored.slice(-RECENT);
    const earlier = stored.length - messages.length;
    if (earlier > 0) {
      yield html`<a
        class="earlier"
        href="?all"
        data-chat-part="earlier"
        data-testid="chat-earlier"
        >${
          project.words?.earlier?.(earlier) ??
          `Show ${earlier} earlier messages`
        }</a
      >`;
    }
    const carriedOn = stored.at(-1)?.awaiting === "model";
    // One message per piece: each is sent as soon as it is rendered, and
    // each gets its own share of Bascik's per-output component budget.
    for (const message of messages) {
      if (message.role === "user") {
        // Attached files come first, as links to the file route. A name is
        // text: the html tag escapes it.
        const files = filesOf(message);
        if (files.length) {
          yield html`<ul
            class="turn-files"
            data-chat-part="files"
            data-testid="turn-files"
          >
            ${files.map((file) =>
              isImageType(file.mediaType)
                ? html`<li>
                    <chat-attachment
                      data-bascik-prop-href="${fileHref(project, file.id)}"
                      data-bascik-prop-thumb="${fileHref(project, file.id)}"
                      data-bascik-prop-name="${file.name}"
                      data-bascik-prop-size="${formatSize(file.size)}"
                    ></chat-attachment>
                  </li>`
                : html`<li>
                    <chat-attachment
                      data-bascik-prop-href="${fileHref(project, file.id)}"
                      data-bascik-prop-name="${file.name}"
                      data-bascik-prop-size="${formatSize(file.size)}"
                    ></chat-attachment>
                  </li>`,
            )}
          </ul>`;
        }
        // What the reader sees of their turn: a pressed form shows its label.
        const shown = shownOf(message);
        if (shown) {
          // The turn keeps the reader's line breaks (white-space: pre-wrap),
          // so the text is written tight against its tags.
          // prettier-ignore
          yield html`<p class="turn-user" data-chat-part="turn" data-role="user" data-testid="turn-user">${shown}</p>`;
        }
        continue;
      }
      // A call the reader just allowed is about to run in the live reply,
      // so it is drawn there.
      const shown =
        carriedOn && message === messages.at(-1)
          ? {
              ...message,
              parts: partsOf(message).filter(
                (part) => part.type !== "tool" || part.state !== "approved",
              ),
            }
          : message;
      // A reply's own nodes are the turn's only children, as in a live reply.
      // prettier-ignore
      yield html`<div class="turn-assistant" data-chat-part="turn" data-role="assistant" data-testid="turn-assistant">${raw(renderMessage(shown, catalog, chat.renderOptions))}</div>`;
    }
  })();
}

/**
 * The reply being written, for a stream script inside the live turn's
 * element: nothing when there is none, else the writing marker, the reply
 * from its first piece however late this page joined it, and the done
 * marker. The reply runs in the chat, apart from any request: this only
 * reads it, and it goes on being written, and is stored, if the reader
 * leaves.
 */
export function liveTurn(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): AsyncGenerator<string> {
  const loading = chatProject(from, request, context);
  loading.catch(() => {});
  return (async function* () {
    const project = await loading;
    const { turn } = await project.chat.thread(request, project.host);
    if (!turn) return;
    // The caret shows from here until the done marker.
    yield `<span class="writing" data-chat-part="writing" data-testid="turn-writing"></span>`;
    yield* turn.html.subscribe();
    yield `<span class="done" data-chat-part="done" data-testid="turn-done"></span>`;
  })();
}

/** Whether the page is showing a search: its address has `?q=`. */
const searching = (request: Request): boolean =>
  new URL(request.url).searchParams.has("q");

/**
 * The reader's conversations as a `conversation-list`, the open one marked,
 * for a server script. It is the same on every address: beside the results
 * of `conversationSearch` the list hides itself, in its own styles.
 */
export async function conversationList(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): Promise<SafeHtml> {
  const project = await chatProject(from, request, context);
  const { chat } = project;
  const session = chat.session(request);
  const conversations = await chat.list(session);
  return html`${open("conversation-list", {
    label: project.words?.conversations,
  })}
  ${conversations
    .filter((conversation) => conversation.messages.length > 0)
    .map(
      (conversation) =>
        html`${open("conversation-item", {
          app: project.app ?? "",
          conversation: conversation.id,
          title: conversation.title,
          current:
            conversation.id === session.conversationId ? "true" : "false",
          route: project.routes?.open,
        })}</conversation-item>`,
    )}
  </conversation-list>`;
}

/**
 * A snippet with its matched words in mark. The snippet is something a
 * reader or a model said: it is only ever text here, and html escapes it.
 */
function marked(match: SearchMatch): (string | SafeHtml)[] {
  const pieces: (string | SafeHtml)[] = [];
  let at = 0;
  for (const [start, end] of match.marks) {
    pieces.push(match.snippet.slice(at, start));
    pieces.push(html`<mark>${match.snippet.slice(start, end)}</mark>`);
    at = end;
  }
  pieces.push(match.snippet.slice(at));
  return pieces;
}

/**
 * The search box as a `chat-search`, showing the words searched for again,
 * and, when the page's address has `?q=`, what was found as a
 * `search-results` of `search-result`s, for a server script.
 */
export async function conversationSearch(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): Promise<SafeHtml> {
  const project = await chatProject(from, request, context);
  const { page, words = {} } = project;
  const found = await project.chat.search(request);
  // With no page named, the box keeps its own default, the page it is on,
  // and Clear leads to this page with no search.
  const box = html`${open("chat-search", {
    route: page,
    query: found.query,
    label: words.search,
    placeholder: words.searchPlaceholder,
    "go-label": words.searchGo,
  })}</chat-search>`;
  if (!searching(request)) return box;
  return html`${box}
    ${open("search-results", {
      clear: page ?? new URL(request.url).pathname,
      "clear-label": words.searchClear,
    })}
      <template data-bascik-slot="note"
        >${
          found.tooShort
            ? (words.searchTooShort ?? "Type at least 2 characters.")
            : found.matches.length === 0
              ? html`<span data-testid="chat-sidebar-search-empty"
                  >${
                    words.searchEmpty?.(found.query) ??
                    `No conversation mentions “${found.query}”.`
                  }</span
                >`
              : (words.searchFound?.(found.matches.length) ??
                `${found.matches.length} found`)
        }</template
      >
      ${found.matches.map(
        (match) =>
          html`${open("search-result", {
            app: project.app ?? "",
            conversation: match.id,
            title: match.title,
            route: project.routes?.open,
          })}${marked(match)}</search-result>`,
      )}
    </search-results>`;
}

const option = (model: ModelOption, chosen: string | undefined): SafeHtml =>
  model.id === chosen
    ? html`<option value="${model.id}" selected>${model.name}</option>`
    : html`<option value="${model.id}">${model.name}</option>`;

/**
 * The project's models as a `model-picker`, the one in use selected, for a
 * server script. Models that name a group are listed under it. A project
 * that offers no model gets nothing.
 */
export async function modelMenu(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): Promise<SafeHtml | ""> {
  const project = await chatProject(from, request, context);
  const menu =
    typeof project.models === "function"
      ? await project.models(request, context)
      : project.models;
  if (!menu || menu.options.length === 0) return "";
  const groups = [
    ...new Set(
      menu.options.flatMap((model) => (model.group ? [model.group] : [])),
    ),
  ];
  const notes = menu.notes ?? [];
  return html`${open("model-picker", {
    app: project.app ?? "",
    label: menu.label ?? "Model",
    "use-label": menu.useLabel,
    route: project.routes?.model,
  })}
    ${menu.options
      .filter((model) => !model.group)
      .map((model) => option(model, menu.chosen))}
    ${groups.map(
      (group) =>
        html`<optgroup label="${group}">
          ${menu.options
            .filter((model) => model.group === group)
            .map((model) => option(model, menu.chosen))}
        </optgroup>`,
    )}
    ${
      notes.length > 0
        ? html`<template data-bascik-slot="note"
            >${notes.map((note) =>
              typeof note === "string" ? html`<p>${note}</p>` : note,
            )}</template
          >`
        : ""
    }
  </model-picker>`;
}

/**
 * What the chat remembers about the reader as a `memory-list` of
 * `memory-item`s, newest first, for a server or stream script. Forget sends
 * the reader back to the page this was printed on.
 */
export async function memoryList(
  from: ChatProjectModule,
  request: Request,
  context?: unknown,
): Promise<SafeHtml> {
  const project = await chatProject(from, request, context);
  const memories = await project.chat.memories(request);
  const url = new URL(request.url);
  return html`<memory-list
    >${memories.map(
      (memory) =>
        html`${open("memory-item", {
          app: project.app ?? "",
          memory: memory.id,
          saved: new Date(memory.created).toISOString().slice(0, 10),
          back: `${url.pathname}${url.search}`,
          route: project.routes?.forget,
        })}${memory.text}</memory-item>`,
    )}</memory-list
  >`;
}
