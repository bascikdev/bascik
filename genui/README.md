# @bascik/genui (experiment)

Generative UI for Bascik: a model streams prose and component tags, and Bascik renders the tags as scoped HTML while the reply is still arriving. The browser needs no JavaScript for any of it.

This is a prototype to test an idea, not a published package. It is private, has no stable API, and is not in the changelog.

## The idea

Other generative UI stacks send the model's output to the browser and render it there. The model writes JSON or a custom language, a client library parses the partial stream, and a framework runtime turns it into components.

Bascik already has the three pieces that make this a server concern:

- A [stream script](https://bascik.dev/scripts/stream) written as an async generator sends each `yield` to the browser as it happens.
- A script can [return component tags](https://bascik.dev/scripts#returning-component-tags), and Bascik renders each one per request with the component's markup, props, slots, and scoped CSS.
- A component file already says what a model needs to know: its tag name, its `@bascik` description, its props, and whether it takes content.

So the model writes the language it knows best, HTML-shaped tags, and the response is one HTML document that grows. What reaches the browser is finished markup.

```html
<div class="turn-assistant live">
  <script data-bascik-stream type="text/typescript">
    import { renderStream } from "@bascik/genui";
    import { loadCatalog, loadModel, systemPrompt } from "@/lib/chat.ts";

    export default async function* (request, _context, { signal }) {
      const model = await loadModel();
      const reply = model({ system: await systemPrompt(), messages, signal });
      yield* renderStream(reply, await loadCatalog());
    }
  </script>
</div>
```

## Try it

```sh
yarn pkg:build
yarn workspace @bascik/genui demo
```

Open the printed URL. With no API key the demo uses a scripted model that knows four books, so it runs offline. Set `ANTHROPIC_API_KEY` to talk to Claude instead; the system prompt is generated from the catalog.

Then turn JavaScript off in the browser and use it again. Everything still works, including streaming.

```sh
yarn workspace @bascik/genui unit       # renderer and catalog
yarn workspace @bascik/genui e2e        # the demo in Chromium, JavaScript disabled
yarn workspace @bascik/genui typecheck
```

## What is in here

| Path               | What it is                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `src/catalog.ts`   | Reads a component folder into a catalog and writes the system prompt that teaches it        |
| `src/render.ts`    | Turns a model's text stream into complete, safe HTML chunks a stream script can yield       |
| `src/model.ts`     | The `Model` type (a function that returns text slices) and a scripted model for offline use |
| `src/anthropic.ts` | A `Model` backed by the Claude API                                                          |
| `demo/`            | A chat app: sidebar, composer, streamed replies, ten catalog components                     |
| `demo/src/genui/`  | The catalog. Every component in this folder is one the model may write                      |
| `e2e/`             | Playwright tests of the demo with JavaScript disabled                                       |

### The catalog is the component folder

`readCatalog("src/genui")` reads each component file and `catalogPrompt()` turns the result into prompt text like this:

```text
<book-card title="…" author="…" rating="…">content</book-card>
  One book: title, author, a rating out of 5 such as 4.6, and a one-sentence blurb as content. ...
```

There is no second schema. Adding a component to the folder adds it to the model's vocabulary, and the description the model reads is the same `@bascik` comment the editor shows on hover.

### The renderer is the trust boundary

Model output is untrusted text. `createRenderer()` passes a tag on only when its name is in the catalog, keeps only the props that component declares, and escapes everything else, including every other `<`. Bascik's request-time renderer then applies its own rules to what survives: a prop is text, URL bindings are checked, event handler attributes are never bound.

It also solves the streaming mismatch. A model's slices end anywhere, and a stream script must yield whole elements. The renderer streams prose word by word, holds a component back until its closing tag arrives, and gives the same HTML however the stream is sliced (the unit tests check slice sizes from 1 character up).

### Interaction is forms

A generated component that needs to talk back is a `<form method="post" action="/api/send">`. The API route stores the message and answers `303`, and the chat page streams the next reply. `ask-button` is a one-click suggestion, `choice-form` is a single-choice question, and `input-form` collects several values. None of them needs a client script, and each is an ordinary HTML form any browser, screen reader, or browsing agent already understands.

## What the experiment showed

**It works, and most of it was already in Bascik.** The package is about 550 lines. The demo's only client script is a few optional lines that make Enter send the message.

**Things that fell out for free:**

- The composer is first in the source and placed last with CSS `order`, so it is usable before the reply starts ([Recipe C](https://bascik.dev/scripts/stream#recipe-c-priority-source-order-with-css-positioning-the-early-paint-footer-trick)).
- A `column-reverse` scroller keeps the newest text in view with no script.
- The typing caret is CSS: it shows until the stream's last chunk, an empty `.done` marker, arrives.
- History is the model's stored text rendered through the same catalog, so restyling a component restyles every old conversation.
- Component CSS is sent once, right before the first instance, in the middle of the stream.

**Where it is weaker than a client-rendered chat:**

- Every turn is a page navigation, and the server renders the whole conversation again. Cross-document view transitions hide most of it, but a long conversation pays for its history on each turn.
- A component appears when it is complete, not piece by piece. Prose streams by the word; a grid of three cards arrives at once.
- The reply cannot be stopped from the page, and reloading while a reply streams asks the model again.
- The catalog reads component files at request time, so the demo needs a file system. It runs on `bascik --server`, not yet on the Cloudflare or Netlify adapters.

## Changes to Bascik that would help

Ordered by how much each would unlock:

1. **Render component tags outside a page.** An export such as `renderFragment(html, request)` from `@bascik/bascik/runtime`, or pages that answer as fragments, would let an API route return rendered components. That allows a small enhancement script to append one turn to the thread, with no navigation and no history re-render, while the no-JavaScript path keeps working.
2. **Let a generator open an element it closes later.** Today each yielded value must hold whole elements, so the demo puts the wrapper in the page and streams into it. A way to mark a yielded wrapper as open would let one script stream several messages.
3. **Put descriptions and props in `components.json`.** The build already records every component for request-time rendering. Adding the `@bascik` description, prop names, and slots would give the catalog a build artifact to read, which also makes it work on the serverless adapters.
4. **A convention for documenting props.** A line per prop in the `@bascik` comment (`@prop rating A number from 0 to 5`) would feed editor hovers, `bascik --check`, and the model prompt from one place, and would let the renderer validate values.
5. **Server and stream scripts on `POST`.** Pages answer `GET` and `HEAD` only, so every form goes through an API route and a redirect. That is the right default, but a page that could answer its own form post would remove a round trip per turn.

## Where this could go

- **`npm create bascik -- --template chat`.** This demo as a template: the Claude-style shell, the catalog folder, a conversation store with a database adapter, and the public skills updated so a coding agent knows how to add a catalog component.
- **Tools.** The demo's model only writes. A real assistant calls tools to get data, then writes components from the results. The `Model` type would grow a tool loop; nothing about rendering changes.
- **Design-time generation.** The same catalog prompt works for a coding agent writing pages, not only for a runtime model. `bascik --check` already tells an agent when it wrote a prop that does not exist.
- **An agent bridge.** Bascik's house rules put a `data-testid` on every component root and interactive part, and the generated UI is forms. A page could publish its components and actions as a small JSON document, or register them with WebMCP, so a browsing agent reads and drives the app without screenshots.
- **Static generation.** A `data-bascik-build` script can run the same renderer at build time, so a model can write parts of a static site from the same catalog with nothing running in production.
- **A measured comparison.** Tags with attributes look compact next to JSON, but that needs a real token count across a set of interfaces before it is a claim.
