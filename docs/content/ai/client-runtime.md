# Client Runtime

Everything on the earlier pages works with scripts off: a form is a page load, and the reply streams into the new page. The client runtime is an optional script that makes the same forms feel like an app, without a second protocol.

## What it adds

`chat-enhance` is one component that `bascik add @bascik/ai` copies into `src/components/chat/`. `chat-app` already holds it. In a chat you assemble yourself, put it inside the `data-chat` element, before the thread:

```html
<main data-chat>
  <chat-composer />
  <chat-enhance />
  <chat-thread>
    <chat-turns />
  </chat-thread>
</main>
```

With it, a `method="post"` form inside the `data-chat` element is sent with `fetch` and the page it answers with is streamed into the open one:

- The message is shown at once, before the server answers. A form that shows a label in place of its message, such as a button that carries the answer, is echoed by that label, and the label is sent as the form's `show` field: see [What the thread shows for a form](/ai/server-kit#what-the-thread-shows-for-a-form).
- The page is not reloaded, so scroll position, focus, and anything typed elsewhere are kept.
- While the request is on its way, the form has a `data-pending` attribute and the reply has a placeholder (`data-testid="turn-pending"`, `aria-busy="true"`) until the first part of the answer arrives. `chat-thread` shows a small dot on it, pulsing unless the reader prefers reduced motion.
- A Stop button ends the reply.
- Scripts in components that arrive in the stream are started.
- After each answer the sidebar is replaced with the answer's, so a new conversation shows in the list. On a narrow screen it stays open or closed as the reader had it.

It has no props, no slots and no element of its own. Its script imports a module beside it (`chat/chat-root/parts.ts`), so the project needs esbuild: see [Components](/ai/components#chat-and-voice-components).

## How it works

The runtime adds nothing to the server. A form post answers with a redirect to the page, as it does for a browser with scripts off, and the page's HTML streams back. The runtime parses that HTML as it arrives, in a document that is not shown, and copies the new thread into the open page a little more after every chunk.

So there is one response format, HTML, and one code path on the server. A browser with scripts off and a browser with the runtime get the same bytes.

If a request fails, the runtime sends the form the ordinary way, so the reader still gets an answer. A reply left unfinished by a failed send or by Stop is ended in the page: it gets its `done` marker and is no longer `aria-busy`.

## Which forms it takes

The runtime takes every `method="post"` form inside an element marked `data-chat`. On a page that marks no such element, it takes the forms inside `<main>`. A `GET` form, such as the search box, is always the browser's.

A form whose answer is another page must be left alone. Mark it `data-genui="native"`:

```html
<form method="post" action="/api/shelf" data-genui="native">
  <button>Add to my shelf</button>
</form>
```

The package's own page-loading forms carry the attribute already: `chat-new`, `conversation-item`, `search-result`, `model-picker` and `memory-item`. Without it, a form in a sidebar inside the chat is fetched and its answer is read as a reply: the address does not change, or, when the answer holds no thread, the form is posted a second time the ordinary way.

## How it finds the other parts

The runtime looks nothing up by class or by tag. From the form that was sent it goes to the nearest `data-chat` element, and finds each part inside it by its `data-chat-part` value:

| Part       | What the runtime does with it                                                                                                      |
| :--------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| `thread`   | Replaces it with the answer's thread, once the answer holds the `ready` marker.                                                    |
| `composer` | Empties it when it is the form that was sent.                                                                                      |
| `input`    | The message box inside the composer.                                                                                               |
| `stop`     | Takes its click, and posts the composer's fields to the button's `formaction` (`/api/stop` for a button with none).                |
| `notice`   | Writes the server's reason there when it refuses a file, and the composer keeps the text and the files. `chat-attach` provides it. |
| `sidebar`  | Replaces it after each answer. It can be inside the `data-chat` element or beside it.                                              |

The package's parts carry these marks, so nothing has to be wired. Markup of your own that stands in for a part carries the same value: a thread of your own is any element with `data-chat-part="thread"`. Two chats on one page each have their own `data-chat` element and never reach into the other. On a page with no `data-chat` element the runtime finds the parts by their test ids, across the page.

In a chat with no `notice`, a send the server refuses is sent again the ordinary way, and the server's page says why.

## State and events

The runtime writes two attributes, which is how the parts and your own styles know what it is doing:

| Attribute                            | Where                                        | Meaning                                                                    |
| :----------------------------------- | :------------------------------------------- | :------------------------------------------------------------------------- |
| `data-genui="streaming"` or `"idle"` | On the `data-chat` element, and on `<html>`. | Whether this chat's reply is arriving. `chat-composer` shows Stop from it. |
| `data-pending`                       | On a form.                                   | Its request is on its way.                                                 |

Style on the `data-chat` element's copy: with two chats on a page, only the one that is streaming is marked there. The copy on `<html>` is for a page with no `data-chat` element.

Four events bubble from the `data-chat` element, or from `document` on a page with none:

| Event              | When                                | `detail`                                   |
| :----------------- | :---------------------------------- | :----------------------------------------- |
| `chat:send`        | A form is taken.                    | `{ form }`                                 |
| `chat:reply-start` | The answer's thread is in the page. | none                                       |
| `chat:stop`        | The reader presses Stop.            | none                                       |
| `chat:reply-end`   | The answer is over.                 | `{ stopped }`: true when Stop was pressed. |

`chat:reply-end` fires once for every `chat:send`, also when the send failed. A send the server refuses for its files fires `chat:send` and then `chat:reply-end`, with no `chat:reply-start`. [Chat Parts](/ai/chat-parts#events) has an example listener and the two events a voice call adds.

## Interactive components

A component that needs behavior is an ordinary Bascik component with a `<script>`. Bascik scopes its ids per instance and sends the script inside the rendered markup, so the script runs when its component arrives in the stream. See [Scoped JavaScript](/scoped-javascript#where-component-scripts-run).

`data-table` in the starter catalog is the pattern. Without scripts it is a table. Its script, when it runs, adds what scripts make possible:

```html
<figure data-testid="data-table">
  <!-- Shown by the script: with no JavaScript this is a plain table. -->
  <input id="filter" type="search" hidden aria-label="Filter rows" />
  <div id="body"><span data-bascik-slot></span></div>
  <script type="text/typescript">
    const filter = document.getElementById("filter") as HTMLInputElement;
    const table = document.getElementById("body")!.querySelector("table");
    // ... make each column heading a sort button, then:
    filter.hidden = false;
  </script>
</figure>
```

Three rules keep an interactive component honest:

1. **It is useful before its script runs.** The markup is the content; the script adds to it.
2. **What only the script can do starts `hidden`,** and the script reveals it. Nothing is shown that does not work.
3. **It talks to the model with a form.** A component that sends something back posts a form, which works with scripts off and is streamed by the runtime with them on.

## Stopping a reply

`chat-composer`'s Stop button takes Send's place while its chat's reply streams. It posts to `/api/stop`, a route of yours that ends the turn (`chat.stop`) and answers once what it had written is stored. The open response then ends by itself. Stopping this way, and not by closing the connection, means the stored conversation is settled before the reader sends anything else.

The route is the composer's `stop-route` prop. The button carries it as its `formaction`, and the runtime reads it from there: the runtime takes the click of any element marked `data-chat-part="stop"`, so the form is never submitted to that route. Only the chat that is writing a reply has one to stop, so another chat's Stop button on the same page does nothing.

If the stop route cannot be reached or answers with an error, the runtime closes the connection itself. When that happens before any of the reply has arrived, the placeholder stays in the thread, empty and ended.

## Browser support

The runtime uses `fetch` with a streamed response body and `document.implementation.createHTMLDocument`, which every current browser has. The chat parts' styles use `:has()` for the tool-call rule, the typing caret and the frame, and the page uses `<link rel="expect">` to hold the first paint until the stored conversation is parsed. A browser without `rel="expect"` paints earlier; nothing breaks. `chat-sidebar` uses `::details-content` on a wide screen: see [Narrow screens](/ai/chat-parts#narrow-screens).
