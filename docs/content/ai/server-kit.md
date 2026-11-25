# Server Kit

The server kit gives you the pieces a chat app needs around the renderer and the turn loop. It holds the conversation store, the reader's session, live replies, and the handlers a page posts to. Every piece also works alone.

## One chat, a few routes

The smallest complete setup creates one chat with a memory store and the required options.

```ts
// src/lib/chat.ts
import { createChat, memoryStore } from "@bascik/ai/app";
import type { Catalog, Model } from "@bascik/ai";

declare const catalog: Catalog;
declare const model: Model;

export const chat = createChat({
  store: memoryStore(),
  catalog,
  model: () => model,
  system: "You are a helpful assistant.",
});
```

> **Note:** The memory store is for tests, demos, and a first try.
> Use `fileStore` for one server, or write a `ConversationStore` for a database.

A route file is one line. This one is `POST /api/send`:

```ts
// src/api/send.ts
export const POST = chat.send;
```

The same one-line form works for the other handlers: `export const POST = chat.approve;`, `export const POST = chat.answer;`, `export const POST = chat.stop;`, `export const POST = chat.open;`, `export const POST = chat.voiceSession;`, `export const POST = chat.voiceTool;`, and `export const POST = chat.voiceTurn;`.

Each handler is a web standard request handler, so you can put it on any route. The chat components post to `/api/send`, `/api/approve`, `/api/result`, `/api/stop`, `/api/voice-session`, `/api/voice-tool`, and `/api/voice-turn`, so those are the paths to use unless you edit the components.

## Options

| Option           | Required | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | No       | Names this chat: its cookie and its log lines. Give each app of one site its own; default `chat`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `store`          | Yes      | Where conversations are kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `catalog`        | Yes      | The components a model may write, or a function that loads them (called once, on first use).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `model`          | Yes      | The model that answers a request (a fixed one is `() => model`). It is called when a reply starts, with the request that started it, and must be picked from what the server offers, never from a URL or a key the request carries.                                                                                                                                                                                                                                                                                                                                                                                       |
| `tools`          | No       | Tools passed to the turn loop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory`         | No       | What the assistant knows about each reader across conversations. When set, every reply (typed or spoken) gets the reader's `remember`, `recall`, and `forget` tools, and the prompt lists what is known; see `@bascik/ai/memory`.                                                                                                                                                                                                                                                                                                                                                                                         |
| `memoryApproval` | No       | True to make `remember` and `forget` wait for the reader's OK. Default false: the reply shows each one, and the reader can undo it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `system`         | Yes      | What the model is told. A string is the app's own instructions, with the catalog prompt or voice prompt following it; a function returns the whole prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `fencePrompts`   | No       | The sentence that tells the model what each code fence it may write is drawn as, by language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `render`         | No       | How replies are drawn, live and from history. `tools` defaults to the chat's own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `voice`          | No       | The voice provider to offer, or a function that picks one by the `?provider=` the request names (null when it names none). Without one, the voice session handler answers 404.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `history`        | No       | Give the model a `search_conversations` tool for the reader's own past conversations, in typed chat and in voice. Default false; what it finds is handed over as quoted data, never as instructions.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `files`          | No       | Where attached files are kept. With it, `send` accepts `multipart/form-data` with a `files` field and `file` serves them back; without it, uploads are ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fileLimits`     | No       | What is let in: sizes, count, types. Defaults in `@bascik/ai/files`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sessions`       | No       | Who the reader is and which conversation is open. Default `cookieSessions(id, { secret: sessionSecret })`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sessionSecret`  | No       | The secret the default sessions sign reader ids with. Recommended; see [Who the reader is](#who-the-reader-is). Ignored when `sessions` is given.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `maxBodyBytes`   | No       | The most bytes a form handler reads of a request body. Past it, the handler answers 413 without reading the rest, with or without a Content-Length header (`send` with `files` answers its refused page instead). Default `fileLimits.maxTotalBytes` plus 256 KB when `files` is set, else 256 KB.                                                                                                                                                                                                                                                                                                                        |
| `page`           | No       | The page the form handlers send the reader back to. Default `/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `turnLimitMs`    | No       | The longest one reply may take, tools included. Default two minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `maxRounds`      | No       | How many times one reply may ask the model, tool rounds included. Past it, the reply ends with a line saying it needed too many tool calls. A whole number, 1 or more. Default 8.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `followLocally`  | No       | Default true: a page request may read a reply another request on this server is writing straight from memory, and two pages asking at once start one reply. False never hands one request another request's stream or promise: each follows a reply through `shared.subscribe` and the turn record, Stop goes through the shared store, and writes to one conversation are not queued in memory, so the store has to arbitrate. Set it to false on a host where one request must not touch another request's I/O, such as Cloudflare Workers; see [Hosts without shared memory](/ai/scaling#hosts-without-shared-memory). |
| `shared`         | No       | State that must be the same on every server: the reply being written, Stop, and a voice call's turn. Default `inProcessShared()`; for several servers, pass an implementation over a store they all reach (see `@bascik/ai/shared`).                                                                                                                                                                                                                                                                                                                                                                                      |
| `onError`        | No       | Told about a failure the reader is not shown. Default: `console.error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Memory, conversation search, attachments, and running on several servers each have their own page: [Memory](/ai/memory), [Conversation Search](/ai/conversation-search), [Attachments](/ai/attachments), [Running on Several Servers](/ai/scaling).

## Handlers

| Handler        | What it does                                                                             | What it answers                                                                           |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `send`         | Add the reader's message and go back to the page, which streams the reply.               | A 303 redirect to the page, JSON `{ say }` for a `voice=1` form, or 400 when not a form.  |
| `approve`      | Record the reader's answer to a tool call that needs their say-so.                       | A 303 redirect to the page, or 400 when no call waits for that answer.                    |
| `answer`       | Record the result of a client tool call.                                                 | A 303 redirect to the page, or 400 when no call waits for that result.                    |
| `stop`         | End the reply being written for the open conversation.                                   | 204, or 404 when none is, or when the open conversation is not the reader's.              |
| `open`         | Open one of the reader's conversations, or start a new one.                              | A 303 redirect to the page, or 400 when not a form.                                       |
| `forget`       | Remove one of the reader's memories. It takes a form post with `id` and optional `back`. | Returns to `back` or the chat's page; a missing memory is not an error.                   |
| `memoryList`   | Return the reader's memories as JSON, newest first.                                      | JSON `{ memories }`, newest first.                                                        |
| `voiceSession` | Start a spoken conversation.                                                             | JSON ticket, 404 when no provider, 502 when provider fails.                               |
| `file`         | Serve one attached file. It takes `GET` with `?id=<file id>`.                            | The file to the reader it belongs to; 404 for anyone else, and for an id that is not one. |
| `voiceTool`    | Run a tool call a voice model made.                                                      | JSON `{ state, output, view }`, or 400 when not a tool call.                              |
| `voiceTurn`    | Store what was just said in a spoken conversation.                                       | 204, or 400 when not a voice turn.                                                        |

A form posted with `voice=1` gets JSON `{ say }`. It contains the message text. The handler adds nothing to the conversation. The call stores its own turns.

### The host's context

Every handler, and `thread`, takes an optional last argument: the host's context, `{ waitUntil?: (promise: Promise<unknown>) => void }`. When a request starts a reply, the kit calls `waitUntil` with the promise that settles once the reply is stored, so a host that ends a request's work when its response is sent (Cloudflare Workers, Netlify Functions) keeps writing the reply after the reader leaves. Cloudflare's `ExecutionContext` is one, and is called as a method, so pass it as it is.

```ts
import { chat } from "./chat.ts";

export default {
  async fetch(request: Request, _env: unknown, context: ExecutionContext) {
    const { turn } = await chat.thread(request, context);
    if (!turn) return new Response("No reply is being written.");
    const html = ReadableStream.from(turn.html.subscribe());
    return new Response(html.pipeThrough(new TextEncoderStream()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};
```

Without it, nothing changes: on Node the reply runs on in the process. Only the first `thread` call of a request starts a reply, so only its context counts.

## Page helpers

| Helper      | What it returns                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread`    | The open conversation and the reply being written, if any. It starts a waiting reply when none is being written, and hands it to the context's `waitUntil` when one is given. |
| `memories`  | The reader's memories, newest first (none when the chat has no `memory`).                                                                                                     |
| `voiceView` | The HTML of what a voice tool call put on screen (empty string when it put nothing).                                                                                          |
| `search`    | The reader's past conversations that match the request's `?q=`. Nothing matches an empty or too short query.                                                                  |

## Pages

A page calls `chat.thread(request)` to get the open conversation and the reply being written, if any. It returns `session`, `messages`, and `turn`.

```ts
const state = await chat.thread(request);
```

`messages` is the stored conversation, or the conversation as it was when the turn started. `turn` is a live reply. Its `html` is a broadcast, so the page that asked, a reload of it, and a second tab all read the same reply from its start.

```ts
if (state.turn) {
  yield * state.turn.html.subscribe();
}
```

The thread's stream scripts both call this and get one answer per request. When the conversation is waiting for a reply and none is being written, `chat.thread(request)` starts it. The reply is finished and stored even when the reader has left. Only Stop, or the time limit, ends it early.

## Where conversations live

The chat asks a store for three things. A store keeps each reader's conversations apart. `load` and `save` hand over copies. The chat changes what it loaded and saves it again.

```ts
import type { Conversation } from "@bascik/ai/app";
export interface ConversationStore {
  load(reader: string, id: string): Promise<Conversation | null>;
  save(reader: string, conversation: Conversation): Promise<void>;
  list(reader: string): Promise<Conversation[]>;
}
```

`memoryStore()` keeps conversations in this process's memory. It clones each value it stores and returns. It is for tests, demos, and a first try.

```ts
import { fileStore, memoryStore } from "@bascik/ai/app";
import { join } from "node:path";
const memory = memoryStore();
const files = fileStore(join(process.cwd(), ".data"));
```

`fileStore(directory)` writes one JSON file per conversation. The path is `<directory>/<reader>/<id>.json`. It creates the reader directory when it saves. It writes a temporary file first, then renames it into place, so a reader never sees half a conversation. Its `list` reads the `.json` files in the reader directory.

The chat keeps each reader to at most `maxConversations` conversations (default 200) of at most `MAX_CONVERSATION_BYTES` (1 MiB of JSON) each, so a reader cannot make every page and search slower by starting more conversations or by making one longer. A conversation that grows past the byte cap is saved without its oldest messages, starting at something the reader said; when its newest message alone is longer, only that message is kept (a voice turn's text is capped in characters, so that one message can reach about 1.5 MiB). When a reader at the count cap starts a new conversation, the chat deletes their oldest by `updatedAt`, so they are never stuck. It deletes through the store's optional `delete(reader, id)`, and it counts through the optional `summaries(reader)` (id, title and `updatedAt` only), falling back to `list`, so whichever your store has must return every conversation, not a page. When neither can count, a new conversation is refused with an error and existing ones still save. With `summaries`, the chat never calls `list`: `chat.list` returns every conversation but reads whole only the newest `MAX_LISTED_BYTES` (4 MiB), one at a time, and gives the older ones with no messages (load one to read it), and the fallback search reads one conversation at a time, at most `MAX_SEARCHED_BYTES` (8 MiB). `memoryStore` and `fileStore` have both. A store of your own without `delete` still works: a reader at the cap is refused a new conversation with an error. Two `fileStore` objects over one folder count together. With several servers, keep the count in the database, since the chat counts within one server.

A store accepts a reader id and a conversation id only when they use letters, digits, `_`, and `-`, up to 128 characters. This keeps either out of a path and out of a file name that means something else. `memoryStore` returns null or an empty list for an unsafe key. `fileStore` returns null from `load` for an unsafe key. Both throw when `save` gets an unsafe key.

```ts
import type { ConversationStore } from "@bascik/ai/app";
export function dbStore(): ConversationStore {
  return {
    async load(_reader, _id) {
      // SELECT the reader's conversation with this id.
      // Return a copy, or null.
      throw new Error("Not implemented");
    },
    async save(_reader, _conversation) {
      // INSERT or REPLACE the conversation for this reader.
      // Check the reader and conversation id before using them as keys.
      throw new Error("Not implemented");
    },
    async list(_reader) {
      // SELECT the reader's conversations.
      // Sort them newest first by updatedAt.
      throw new Error("Not implemented");
    },
  };
}
```

> **Note:** `fileStore` is a good store for one server. With several servers, use a database.

### Changing a conversation in your own handler

The chat's handlers change a conversation one at a time: each reads it afresh and stores it before the next one reads it. A handler of your own joins that line with `chat.change`. It reads the open conversation (a new one when none is open), lets your function change it, and stores it.

```ts
await chat.change(session, (conversation) => {
  if (conversation.messages.length === 0) conversation.title = "Review";
});
```

`chat.load` and `chat.save` still work. When the conversation you save came from `chat.load` and another write stored it in between, such as a spoken turn during a call, `save` keeps both. Messages you added follow the ones stored since, and a field you changed replaces the stored one. When both writes changed or removed messages that were there when you loaded it, even different ones, `save` throws and stores nothing. Load it again, or use `chat.change`. A `save` that fails, because of that or because the store failed, leaves your conversation as you changed it, so saving it again is safe. The conversation `chat.change` returns saves the same way.

> **Caution:** Inside the function you pass to `chat.change`, do not call `chat.save`, `chat.change`, or `chat.addMessage` for the same conversation. Each waits for the change in progress, which never finishes. Writes straight to `chat.store` skip the line, and writes from another server are not in it either: with several servers, the store has to settle them.

## Who the reader is

A request needs a reader and the conversation that is open. `ChatSessions` gives both, and lets a response remember them.

```ts
import type { Session } from "@bascik/ai/app";
export interface ChatSessions {
  identify(request: Request): Session;
  remember(session: Session, conversationId: string): Headers;
}
```

`cookieSessions(id = "chat", options = {})` is the default. It uses an anonymous reader and an open conversation, each in an HttpOnly cookie. Readers never see each other's conversations. A reader who clears cookies starts over.

```ts
import { cookieSessions } from "@bascik/ai/app";
const sessions = cookieSessions("library");
```

It sets two cookies:

- `chat_<id>`: the open conversation.
- `visitor`: the anonymous reader.

Both get `Path=/; HttpOnly; SameSite=Lax; Secure`. The `visitor` cookie also gets `Max-Age=31536000`, one year; pass `maxAgeSeconds` to change it (a whole number, 1 or more: 0 would delete the cookie at once, and every request would be a new reader). The `chat_<id>` cookie has no `Max-Age`, so it lasts the browser session. `Secure` is on for every response, whatever the request's URL says: behind a proxy, requests to a public https site can arrive as plain http to `127.0.0.1`, so the server never guesses. Chrome and Firefox keep Secure cookies on `http://localhost` and `http://127.0.0.1`, so local development works with the default. Pass `secure: false` only to develop on a browser that drops them there, or over plain http from another device on your network.

Pass `secret` (or `sessionSecret` to `createChat`) to sign the reader id with an HMAC. The `visitor` cookie then holds the id and its signature, and a cookie the server did not sign is refused: the request gets a new reader. Turning it on starts every existing reader over, because their unsigned cookies are refused.

Pass `hostPrefix: true` to name the cookies `__Host-visitor` and `__Host-chat_<id>`, and read only those. A browser accepts a `__Host-` cookie only from an https response with `Secure`, `Path=/`, and no `Domain`, so a sibling subdomain or a plain-http response cannot set one. It needs `secure` left on (`cookieSessions` throws otherwise), and turning it on starts every existing reader over.

```ts
import { cookieSessions } from "@bascik/ai/app";
const sessions = cookieSessions("library", {
  secret: process.env.CHAT_SECRET,
  hostPrefix: true,
});
```

Pass it as `sessions` to `createChat`; `sessionSecret` alone does not set `hostPrefix`.

What these do and do not prevent:

- Without a secret, any cookie shaped like an id is taken as the reader. Whoever can set a cookie on your site can choose the reader id a visitor uses, and later read what that visitor stores.
- `secret` stops ids the server never issued. It does not stop an id the server did issue: anyone can visit, get a signed id, and plant that same value in someone else's browser. Both then share one reader.
- `hostPrefix` stops that planting from a sibling subdomain or from a network attacker who answers a plain-http request. It does not stop script running on your own origin, or anyone with access to the browser.
- Neither ties a reader to a person. When conversations hold anything private, put the chat behind your own sign-in and implement `ChatSessions` with the signed-in user as the reader.

`identify` reads `visitor` and `chat_<id>` (with their `__Host-` names when `hostPrefix` is on). It accepts a cookie value only when it is an id shaped as `randomUUID` writes it, and, with a secret, signed by this server. `remember` writes the open conversation and the reader back.

To replace it, implement `ChatSessions`. `identify` answers from the request. `remember` returns the headers that make the next request say the same. Pass the result as `sessions` to `createChat`.

```ts
import type { ChatSessions } from "@bascik/ai/app";
export const loginSessions: ChatSessions = {
  identify(request) {
    const reader = request.headers.get("x-user") ?? "anonymous";
    return { reader, conversationId: undefined };
  },
  remember(_session, conversationId) {
    const headers = new Headers();
    headers.set(
      "set-cookie",
      `chat=${conversationId}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return headers;
  },
};
```

## More than one chat on a site

The demo runs several apps on one site. It keeps one `Chat` for each app id. Each app gets its own `id`, store directory, and page. The store directory is `.data/<app.id>`.

A small helper makes a route for one handler. It reads the `app` field from a copy of the form, picks the app, and calls the handler on that app's chat.

```ts
import type { Chat } from "@bascik/ai/app";
type FormHandler =
  | "send"
  | "approve"
  | "answer"
  | "stop"
  | "open"
  | "voiceSession"
  | "voiceTool"
  | "voiceTurn";
export const route =
  (
    chatFor: (request: Request, named: string | null) => Chat,
    handler: FormHandler,
  ) =>
  async (request: Request): Promise<Response> => {
    let named: unknown = null;
    try {
      named = (await request.clone().formData()).get("app");
    } catch {
      // Not a form: the handler says so.
    }
    return chatFor(request, typeof named === "string" ? named : null)[handler](
      request,
    );
  };
```

The demo's `chatFor` takes the app chosen by `appFor`. A page request names its app by its own path. A form post names it in an `app` field, or by the page it was sent from.

## Limits

Live replies are one process's memory. `createChat` keeps a map from conversation id to the reply being written. The page that asked, a reload of it, and a second tab all read the same reply from its start. The reply is finished and stored even when the reader has left.

> **Caution:** With several servers, a reader who lands on another one mid-reply starts a second reply. Put the broadcast in a shared store to fix that.

Voice state is also kept in a map inside `createChat`. It holds the voice turn being recorded for each conversation, and the views made by voice tool calls. It is not shared across processes.
