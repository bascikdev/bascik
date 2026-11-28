# Client Runtime

Everything on the earlier pages works with scripts off: a form is a page load, and the reply streams into the new page. The client runtime is an optional script that makes the same forms feel like an app, without a second protocol.

## What it adds

`chat-enhance` is one component, about 200 lines, that `bascik add @bascik/ai` copies into `src/components/chat/`. Put it in the page before the thread. In this example `chat-thread` is your own component, the one that renders the conversation:

```html
<main>
  <chat-composer data-bascik-prop-app="books" />
  <chat-enhance />
  <chat-thread />
</main>
```

With it, a `method="post"` form inside `<main>` is sent with `fetch` and the page it answers with is streamed into the open one:

- The message is shown at once, before the server answers. A form that shows a label in place of its message, such as a button that carries the answer, is echoed by that label, and the label is sent as the form's `show` field: see [What the thread shows for a form](/ai/server-kit#what-the-thread-shows-for-a-form).
- The page is not reloaded, so scroll position, focus, and anything typed elsewhere are kept.
- While the request is on its way, the form has a `data-pending` attribute and the reply has a placeholder (`data-testid="turn-pending"`, `aria-busy="true"`) with the typing caret, until the first part of the answer arrives. Style on either: the demo's `style.css` shows a small dot on `.live[aria-busy="true"]`, pulsing unless the reader prefers reduced motion. The components carry no styles for it, so a project draws its own.
- A Stop button ends the reply.
- Scripts in components that arrive in the stream are started.

## How it works

The runtime adds nothing to the server. A form post answers with a redirect to the page, as it does for a browser with scripts off, and the page's HTML streams back. The runtime parses that HTML as it arrives, in a document that is not shown, and copies the new thread into the open page a little more after every chunk.

So there is one response format, HTML, and one code path on the server. A browser with scripts off and a browser with the runtime get the same bytes.

Two attributes are its whole interface:

| Attribute             | Where         | Meaning                                                               |
| :-------------------- | :------------ | :-------------------------------------------------------------------- |
| `data-genui`          | On `<html>`   | `streaming` while a reply is arriving, `idle` otherwise. Style on it. |
| `data-genui="native"` | On a `<form>` | Send this form the ordinary way.                                      |

If a request fails, the runtime sends the form the ordinary way, so the reader still gets an answer.

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

The composer's Stop button posts to `/api/stop`, a route of yours that ends the turn and answers once what it had written is stored. The open response then ends by itself. Stopping this way, and not by closing the connection, means the stored conversation is settled before the reader sends anything else.

## Browser support

The runtime uses `fetch` with a streamed response body and `document.implementation.createHTMLDocument`, which every current browser has. The chat's stylesheet uses `:has()` for the tool-call rule and the typing caret, and `<link rel="expect">` to hold the first paint until the stored conversation is parsed. A browser without `rel="expect"` paints earlier; nothing breaks.
