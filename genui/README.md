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

Open the printed URL. The site serves four apps from one chat shell:

| App              | Page      | What it does                                                                                         |
| ---------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| Bookshop         | `/`       | Recommends books with cards, a chart, a single-choice question, and a generated form                 |
| Ask the docs     | `/docs`   | Searches and reads `docs/content/` with two tools, and cites each page it used                       |
| Sales analyst    | `/data`   | Writes SQL against a seeded SQLite database, then shows the result as stat tiles, charts, and tables |
| Knowledge review | `/review` | Asks an expert to validate what the assistant read, one item at a time, and records every answer     |

With no API key each app uses an offline stand-in that needs no model: the bookshop follows a script, the docs app returns keyword search results, the analyst answers four fixed questions with real queries, and the review walks a fixed queue of five items. Set `ANTHROPIC_API_KEY` and the same apps talk to Claude, with the system prompt generated from the catalog and the tools called by the model.

### Choosing a model

The sidebar has a model selector. It lists what the server is configured with, and the choice is the visitor's own (a cookie), on every app:

| In the list       | When                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Offline script    | Always. No model: the fixed stand-ins described above                                                                                     |
| Claude            | `ANTHROPIC_API_KEY` is set. `ANTHROPIC_MODELS` narrows the list                                                                           |
| Ollama            | It answers on this machine (`OLLAMA_HOST`, default `127.0.0.1:11434`). Every pulled model is listed                                       |
| LM Studio         | Its local server answers (`LMSTUDIO_HOST`, default `127.0.0.1:1234`)                                                                      |
| OpenAI-compatible | `OPENAI_BASE_URL` is set, with `OPENAI_API_KEY` if the server needs one. `OPENAI_MODELS` and `OPENAI_LABEL` name the models and the group |

So with Ollama running, start the demo and pick a model; nothing else to configure. Local models go through `src/openai.ts`, which calls `POST /chat/completions` with `fetch` and reads the event stream itself, tool calls included.

Keys and URLs stay on the server. The cookie holds an id from the server's own list, and an id that is not on the list is ignored, so a visitor cannot point the server at another address. On a deployed server set `GENUI_LOCAL_MODELS=0`, so it does not look for Ollama or LM Studio on its own machine. There is no field for a visitor to paste a key into: that would put a secret in a cookie or a file, and it is left out until there is sign-in to tie it to.

A small local model follows the component format less reliably than Claude. Whatever it writes still goes through the renderer, so an unknown tag is shown as text and never becomes an element.

Then turn JavaScript off in the browser and use it again. Everything still works, including streaming.

```sh
yarn workspace @bascik/genui unit              # renderer, catalog, tools, fuzz properties
yarn workspace @bascik/genui e2e               # the four apps in Chromium, JavaScript disabled
yarn workspace @bascik/genui typecheck
yarn workspace @bascik/genui stress:load       # load, long history, budgets (start the server first)
yarn workspace @bascik/genui stress:adherence  # a real model against the format; spends API credits
```

## What is in here

| Path               | What it is                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `src/catalog.ts`   | Reads a component folder into a catalog and writes the system prompt that teaches it              |
| `src/render.ts`    | Turns a model's text stream into complete, safe HTML chunks a stream script can yield             |
| `src/model.ts`     | The `Model` and `Tool` types, tool input validation, and a scripted model for offline use         |
| `src/anthropic.ts` | A `Model` backed by the Claude API, with a tool loop                                              |
| `src/openai.ts`    | A `Model` backed by any OpenAI-compatible server (Ollama, LM Studio, a gateway), with a tool loop |
| `src/analyze.ts`   | Measures how well a reply followed the format: unknown tags, undeclared props, unclosed tags      |
| `demo/`            | The four apps: one shell, a registry of apps, per-visitor conversations                           |
| `demo/src/genui/`  | The catalog. Every component in this folder is one a model may write                              |
| `e2e/`             | Playwright tests of the demo with JavaScript disabled                                             |
| `stress/`          | The load test and the real-model format test                                                      |

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

## A second experiment: validating knowledge

The first three apps answer questions. The fourth turns the direction around: a knowledge assistant has read some documents and needs a subject expert to check what it took from them before it answers anyone. That is a different interface for every kind of doubt, which is the case for generating it.

`/review` shows one item per turn, with the component that fits it:

| The assistant needs to ask                           | Component                      | What the expert does                                     |
| ---------------------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| "I read this fact. Is it right?"                     | `fact-check`                   | Correct, Wrong, or Not sure, with a note                 |
| "The sources leave this case open. Which rule?"      | `decision-fork`, `fork-branch` | Picks an if/then branch, or says none fits               |
| "These codes replace those codes. Did I match them?" | `code-map`, `code-row`         | Every row starts as right; flags the wrong ones          |
| "The documentation stops here. What happens?"        | `gap-question`                 | Writes the answer, or says they do not know              |
| "This is what I plan to do. Approve it?"             | `plan-review` with `step-item` | Approves, or asks for changes with a note                |
| "Here is where this sits in the process."            | `flow-diagram`, `flow-stage`   | Reads a diagram: done, current, unclear, and todo stages |
| "These are the words I relied on."                   | `source-quote`                 | Reads the quoted passage and where it came from          |

The sample knowledge is a bookshop's returns desk (`demo/src/lib/review.ts`, `QUEUE`): a returns window, a damaged book with no receipt, the 2027 shelf codes, a refund limit the policy never states, and a plan for answering staff. Replace the queue with what your own pipeline extracts.

### Nothing between the form and the server

Each review component is an HTML form. What it sends is its named fields, visible in the component file and in the browser's network panel:

```text
POST /api/decide
app=review&kind=fact&item=returns-window&verdict=confirmed&note=The+emailed+receipt+counts.
```

`demo/src/api/decide.ts` is 41 lines. It checks the fields (`decisionFrom`), appends the decision to a log as one line of JSON, adds it to the conversation as the expert's message, and answers `303` back to the page, which streams the assistant's next step. There is no client state, no message protocol, and no generated code to trust: a button's `name` and `value` are the API.

```json
{
  "conversation": "7a5d…",
  "item": "shelf-codes-2027",
  "kind": "codes",
  "verdict": "reviewed",
  "note": "CKB-003 goes to CKB-030.",
  "rows": { "FIC-014": "right", "CKB-003": "wrong" },
  "at": "2026-11-24T22:12:47.058Z"
}
```

The model never records a decision. It can only show a form; the expert's click is what writes the log. The decision reaches the model as a message that starts with `Decision on <item> (<kind>): <verdict>`, so a conversation is also a readable record of the review, and reloading it shows every form as it was asked.

### What this experiment showed

- **Components as a vocabulary of doubt.** Seven shapes covered the cases tried. Adding one is a file in `demo/src/genui/` with a comment that tells the model when to use it.
- **Building blocks compose.** `source-quote` goes inside three different review forms, `step-item` is shared with `step-list`, and `flow-diagram` sits above any of them to say which stage the question is about.
- **The diagram is CSS.** A `flow-stage` is a list item with a `data-state` attribute; arrows, the highlight, and the dashed "unclear" border are styles. A branching diagram (a real decision tree, not a line of stages) would need a layout this does not have.
- **A form per turn is slow for bulk work.** Checking forty codes in one table is fine. Confirming forty facts is forty page loads; a batch `fact-check` list, or a review page outside the chat, would suit that better.
- **Not tested:** a real model choosing the component. The offline reviewer follows a script. The instructions and a `review_queue` tool for a real model are in `demo/src/lib/apps.ts`, unrun.
- **Missing for real use:** sign-in (a visitor is an anonymous cookie, so the log cannot say who decided), a way to reopen a decision, and somewhere for the log to go other than a file.

## What the experiment showed

**It works, and most of it was already in Bascik.** The package is about 1,000 lines. The demo's only client script is a few optional lines that make Enter send the message.

**Things that fell out for free:**

- The composer is first in the source and placed last with CSS `order`, so it is usable before the reply starts ([Recipe C](https://bascik.dev/scripts/stream#recipe-c-priority-source-order-with-css-positioning-the-early-paint-footer-trick)).
- A `column-reverse` scroller keeps the newest text in view with no script.
- The typing caret is CSS: it shows until the stream's last chunk, an empty `.done` marker, arrives.
- History is the model's stored text rendered through the same catalog, so restyling a component restyles every old conversation.
- Component CSS is sent once, right before the first instance, in the middle of the stream.
- Bascik's own rate limiter, body limits, and escaping apply to the chat with no extra code.

**Where it is weaker than a client-rendered chat:**

- Every turn is a page navigation, and the server renders the recent conversation again. Cross-document view transitions hide most of it.
- A component appears when it is complete, not piece by piece. Prose streams by the word and code by the line; a grid of three cards arrives at once.
- The reply cannot be stopped from the page, and reloading while a reply streams asks the model again.
- The catalog and the docs tools read files at request time, so the demo needs a file system. It runs on `bascik --server`, not yet on the Cloudflare or Netlify adapters.
- A form the model generated has no way to know which app it is in, so its post is routed by the `Referer` header.

## What the stress tests found

Measured on one machine against the offline models, so the numbers are Bascik and the renderer, not a model API. `stress/load.ts` reproduces them.

**Fixed in this package:**

| Found                                                                                    | Before                               | After                                   |
| ---------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------- |
| The renderer parsed a pending element again on every slice                               | 300 cards in a grid: 1,112 ms of CPU | 2 ms                                    |
| 4,000 nested opening tags (hostile input)                                                | 2,188 ms                             | 2 ms                                    |
| An unclosed code fence was held until it closed                                          | 200,000 characters: 1,529 ms         | 22 ms, and code now streams by the line |
| A conversation with more than 1,000 component instances rendered no history at all       | blank at 400 turns                   | 248 ms; one yield per message           |
| One reply with more than 1,000 components was dropped by Bascik's per-output budget      | reply lost                           | first 300 shown, the rest counted       |
| The sidebar read every stored conversation on each page load, and showed every visitor's | first byte 2.5 s at 500 clients      | 0.5 s; conversations are per visitor    |

**Replies streaming at once**, one Node process, rate limiter off for the test:

| Clients | First byte, median | Whole reply, median | Whole reply, 95th percentile |
| ------: | -----------------: | ------------------: | ---------------------------: |
|       1 |              21 ms |              728 ms |                       728 ms |
|     100 |              42 ms |              868 ms |                     1,202 ms |
|     250 |             167 ms |            1,530 ms |                     1,870 ms |
|     500 |             527 ms |            2,505 ms |                     3,369 ms |

A reply takes about 700 ms on its own here because the offline model paces its output. One hundred visitors who disconnect mid-reply leave the server healthy, and each partial reply is saved.

**Not fixed, because it is in Bascik:** rendering many components inside one parent grows faster than linearly: 100 cards took 31 ms, 500 took 371 ms, and 990 took 1,171 ms, while 800 instances spread over 200 yields took 127 ms. The renderer's 300-component cap keeps one reply to about 120 ms. It was reproduced without this workspace and is fixed in [bascikdev/bascik#299](https://github.com/bascikdev/bascik/pull/299), where 990 cards in one grid render in about 140 ms and 100 to 990 cards grow linearly; once that is merged, the cap is a budget choice and no longer a workaround.

**Not tested here:** how reliably a real model follows the format. No API key was available where this was built. `stress/adherence.ts` asks Claude thirty questions across the three apps, ten of them hostile or awkward, and reports unknown tags, undeclared props, unclosed elements, tool calls, and timings. Its `--offline` flag is a free dry run of the script itself.

**Known gaps in the demo:** a model-written SQL query runs on the server's main thread with no time limit (it is read-only and capped at 200 rows, but a huge join would block other requests), and conversations are stored as files.

## Changes to Bascik that would help

Ordered by how much each would unlock:

1. **Make request-time rendering linear in the instances one slot holds.** See the stress results above.
2. **Render component tags outside a page.** An export such as `renderFragment(html, request)` from `@bascik/bascik/runtime`, or pages that answer as fragments, would let an API route return rendered components. That allows a small enhancement script to append one turn to the thread, with no navigation and no history re-render, while the no-JavaScript path keeps working.
3. **Let a generator open an element it closes later.** Today each yielded value must hold whole elements, so the demo puts the wrapper in the page and streams into it. A way to mark a yielded wrapper as open would let one script stream several messages.
4. **Give a component rendered at request time something from the request.** A generated form cannot carry the app or conversation it belongs to, because a returned component's markup gets only its props. A request-scoped value a component can bind to an attribute would remove the `Referer` routing.
5. **Put descriptions and props in `components.json`.** The build already records every component for request-time rendering. Adding the `@bascik` description, prop names, and slots would give the catalog a build artifact to read, which also makes it work on the serverless adapters.
6. **A convention for documenting props.** A line per prop in the `@bascik` comment (`@prop rating A number from 0 to 5`) would feed editor hovers, `bascik --check`, and the model prompt from one place, and would let the renderer validate values.
7. **Server and stream scripts on `POST`.** Pages answer `GET` and `HEAD` only, so every form goes through an API route and a redirect. That is the right default, but a page that could answer its own form post would remove a round trip per turn.

## Where this could go

- **`npm create bascik -- --template chat`.** This demo as a template: the Claude-style shell, the catalog folder, a conversation store with a database adapter, and the public skills updated so a coding agent knows how to add a catalog component.
- **Design-time generation.** The same catalog prompt works for a coding agent writing pages, not only for a runtime model. `bascik --check` already tells an agent when it wrote a prop that does not exist.
- **An agent bridge.** Bascik's house rules put a `data-testid` on every component root and interactive part, and the generated UI is forms. A page could publish its components and actions as a small JSON document, or register them with WebMCP, so a browsing agent reads and drives the app without screenshots.
- **Static generation.** A `data-bascik-build` script can run the same renderer at build time, so a model can write parts of a static site from the same catalog with nothing running in production.
- **A measured comparison.** Tags with attributes look compact next to JSON, but that needs a real token count across a set of interfaces before it is a claim.
