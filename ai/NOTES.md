# @bascik/ai (experiment)

Generative UI for Bascik: a model streams prose and component tags, and Bascik renders the tags as scoped HTML while the reply is still arriving. The browser needs no JavaScript for any of it.

This is a prototype to test an idea, not a published package. It is private, has no stable API, and is not in the changelog. Its documentation is the [Generative UI](https://bascik.dev/ai) section of the docs (`docs/content/ai/`); this README is the lab notebook: what was tried and what it showed.

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
    import { renderStream } from "@bascik/ai";
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
yarn workspace @bascik/ai demo
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
yarn workspace @bascik/ai unit              # renderer, catalog, tools, fuzz properties
yarn workspace @bascik/ai e2e               # the four apps in Chromium, with JavaScript off and on
yarn workspace @bascik/ai typecheck
yarn workspace @bascik/ai stress:load       # load, long history, budgets (start the server first)
yarn workspace @bascik/ai stress:adherence  # a real model against the format; spends API credits
```

## What is in here

| Path                 | What it is                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/catalog.ts`     | Reads a component folder into a catalog and writes the system prompt that teaches it                            |
| `src/render.ts`      | Turns a model's text stream into complete, safe HTML chunks a stream script can yield                           |
| `src/model.ts`       | Message parts, the `Model` and `Tool` types, tool input validation, and a scripted model                        |
| `src/turn.ts`        | The turn loop: asks the model, runs its tool calls, and pauses for the reader's approval                        |
| `src/render-turn.ts` | Message parts as HTML, for a live turn and for a stored message                                                 |
| `src/broadcast.ts`   | One stream with many readers, each from the start: what lets a reply outlive its page                           |
| `src/anthropic.ts`   | A `Model` backed by the Claude API: one round, read from and written to message parts                           |
| `src/openai.ts`      | A `Model` backed by any OpenAI-compatible server (Ollama, LM Studio, a gateway): one round, like the Claude one |
| `src/mermaid.ts`     | Draws a mermaid code fence as an inline SVG on the server, and checks the SVG is safe                           |
| `src/analyze.ts`     | Measures how well a reply followed the format: unknown tags, undeclared props, unclosed tags                    |
| `components/`        | What `bascik add @bascik/ai` copies into a project: a starter catalog and the chat's pieces                     |
| `demo/`              | The four apps: one shell, a registry of apps, per-visitor conversations                                         |
| `demo/src/genui/`    | The demo's own catalog components, beside the package's `components/catalog/`                                   |
| `e2e/`               | Playwright tests of the demo, each run with JavaScript off and with it on                                       |
| `stress/`            | The load test and the real-model format test                                                                    |

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

### A diagram is a fence the server draws

A model already writes Mermaid, and a branching diagram is something a catalog component cannot lay out. So a ` ```mermaid ` fence is drawn instead of shown:

```ts
import { catalogPrompt, renderStream } from "@bascik/ai";
import { MERMAID_PROMPT, mermaidFence } from "@bascik/ai/mermaid";

const fences = { mermaid: mermaidFence() };
yield * renderStream(reply, catalog, { fences });
// And tell the model: catalogPrompt(catalog, { fences: { mermaid: MERMAID_PROMPT } })
```

The renderer holds the fence back until it closes, then yields one `<figure class="diagram">` with an inline SVG, drawn in Node by [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid). No script runs in the browser and nothing is fetched. It draws flowcharts, sequence, state, class, and entity diagrams, and XY charts; anything else (a Gantt chart, a typo) is shown as the code it is.

The diagram text is untrusted like the rest of a reply. The library escapes labels, and `safeSvg()` then checks its output against a short list of drawing elements with no event handlers, links, or outside references. The SVG carries no colors of its own: it reads `--bg` and `--fg` (and `--surface`, `--border`, `--muted`, `--accent` when set) from the page, so one render serves light and dark themes.

`fences` takes any language: a function from the fence's text to HTML, or null to show the code.

### Interaction is forms

A generated component that needs to talk back is a `<form method="post" action="/api/send">`. The API route stores the message and answers `303`, and the chat page streams the next reply. `ask-button` is a one-click suggestion, `choice-form` is a single-choice question, and `input-form` collects several values. None of them needs a client script, and each is an ordinary HTML form any browser, screen reader, or browsing agent already understands.

## How it would ship

2026-11-25: the package is now set up to be published as 0.1.0 through the repository's release flow (`ai-v` tags, `.github/workflows/release.yml`); `RELEASING.md` has the one-time steps for the owner.

The package is shaped the way Bascik shares anything, and has two halves:

- **Functions you import**, from `dist/`. In this repository the exports point at `src/*.ts`, which Node runs as it is. Node does not strip types under `node_modules`, so `publishConfig.exports` points the published package at JavaScript built by `yarn build`. Claude's SDK and `beautiful-mermaid` are optional peers: the core has no dependencies.
- **Components you copy**, from `components/`. The `bascik.components` field offers them to [`bascik add`](https://bascik.dev/how-to/sharing-components), which copies `components/catalog/` (what a model may write) and `components/chat/` (the composer, the client runtime, voice, the approval form) into the reader's `src/components/`. They are the reader's files after that. That matters here: a catalog component's `@bascik` comment is part of the prompt, so it has to be editable.

`yarn workspace @bascik/ai pack` builds the tarball. It was installed into an empty project, `bascik add @bascik/ai` copied its components, and the docs' Quick Start page ran from it. `src/package.test.ts` checks the manifest and that every shipped component stands alone (a description, a test id, no `@/` import). It stays `private` until someone decides to publish it; releasing is not part of the experiment.

## Voice

`components/chat/chat-voice.html` is a third optional script, beside the client runtime. It reads the reply's prose from the page as it streams and does three things with it:

- **Captions.** A line above the composer shows the reply a few words at a time, with the current word in bold. With the sound off it keeps a reading pace, so it is a reading aid on its own.
- **Read aloud.** The browser's `speechSynthesis` speaks each sentence as soon as it is complete, and its word boundary events move the caption. A voice that sends none falls back to the reading pace.
- **Dictate.** `SpeechRecognition` hears the next message, the composer's own form sends it, the reply is spoken, and it listens again.

It needed nothing from the server: the reply is already text in the page. A component is skipped unless an element in it has `data-say`, which `book-card` binds to its title, so three cards are spoken as three titles and not as ratings and button labels.

What it showed, and did not:

- **The page is a good source for speech.** Because the reply is finished HTML, "what to say" is a walk over the reply's child nodes, and it stays in step with what the reader sees.
- **Browser voices are the floor.** They are free and instant, and they sound like a browser. The next section is the other kind.
- **Tested with stand-ins.** A headless browser has no speech engines, so the browser tests replace them with fakes that send word boundaries and one heard sentence. No real voice or microphone was part of a test.

## A voice call with a speech-to-speech model

`components/chat/voice-call.html`, `src/voice.ts`, and `src/gemini-live.ts` are a spoken conversation with Gemini Live (Azure Voice Live came second, below): the reader talks, the model answers aloud, and what it shows arrives in the thread as components.

The shape is different from a text reply, because a call is a long two-way audio connection:

- **Audio goes direct.** The server asks Google for a one-use token with the whole session setup locked in (model, instructions, tools), and the browser connects to Google with it. The key stays on the server and no audio passes through it. This also means Bascik's server needed no WebSocket support.
- **What runs or renders goes through the server.** A tool call arrives in the browser, which posts it to `/api/voice-tool`. `runVoiceTool` checks it, holds it for approval if the tool asks for that, and runs it.
- **Components are a tool.** The model gets a `show` tool whose input is markup in the usual format. The server renders it through the catalog. The browser fetches the result as a page (`/voice-view`), because an API response is not rendered by Bascik and a page is.
- **A turn is stored as parts.** What was spoken is a text part marked `spoken`, shown as plain text.

What it showed:

- **It works against the real model.** `stress/voice-live.ts` runs a session with a real key and no microphone. `gemini-3.8-live` called `list_books`, then `show` with a valid `card-grid` of two `book-card`s and an `ask-button`, and spoke for seven seconds; first audio arrived in two to three seconds. Asked to hold a book, it called `place_hold`, which waited for approval, ran, and was confirmed aloud. In a browser, a typed question in a real call rendered two styled cards in the thread.
- **A model says markup if you let it.** The first prompt let the model put buttons in a second, spoken turn: it read tags aloud. The prompt now says the `show` tool is the only way to the screen, and spoken text is never parsed as markup.
- **No word timestamps.** Gemini Live refuses `wordTimestamp` on a live session, so captions follow the audio clock: the current word is found by how far into the turn's audio playback is.
- **Captions must outlive the turn.** A turn is complete, and stored, well before its audio has finished playing. The browser test caught captions stopping at that moment.

What it did not test:

- **A real microphone.** The browser tests give the component a synthetic tone as its microphone and a stand-in provider (`e2e/fake-live-server.ts`). The headless browser's own fake microphone hung on this machine. Nobody has spoken to it yet.
- **Interruption, echo, and long sessions.** The code stops playback when the provider says the reader cut in. That path has only been read, not exercised. (The voice lab has since measured it with stand-in providers, as the barge-in stop: see `voice-lab/README.md`.)
- **OpenAI's own Realtime API.** It would be a third `VoiceProvider` and a wire protocol close to Azure's.

### Azure Voice Live, and a relay

`src/azure-voice-live.ts` is a second provider, and `voice-call` now speaks two protocols, chosen by the ticket.

- **Azure has no browser token.** A Voice Live WebSocket is opened with the resource's key or a Microsoft Entra token. No endpoint for a one-use client token answered (`/voice-live/realtime/client_secrets` and its neighbors are 404), and either credential in a browser opens the whole resource. So the "audio goes direct" rule does not hold here: the provider runs a relay (`src/ws.ts` is the WebSocket server side, with no dependency). The ticket is a one-use address on the relay. The relay holds the credential, sends the session setup itself, and rebuilds the few client messages a call needs field by field. A browser's `session.update` is dropped.
- **It works against the real service.** `stress/azure-voice-live.ts` ran `gpt-realtime-2` in East US 2 with a Microsoft Entra token and no key: it called `list_books`, then `show` with a valid `card-grid`, and spoke. First audio came 1.1 seconds after asking. The script also sends a `session.update` the way a hostile browser would, and the model kept its instructions. A headless browser on the demo, with a typed question, rendered two styled cards and stored the turn.
- **Real word times.** With an Azure voice the service sends `response.audio_timestamp.delta` for every word. Captions use them when they are there and fall back to the audio clock when they are not. Three details: the times count from the start of one response's audio and a turn can be several responses; the times arrive before the audio they describe; and a full stop arrives as a word of its own. An OpenAI voice on Azure sends no times.
- **Wait for `response.done` before asking for more.** Sending a tool's result and `response.create` at once is refused ("Conversation already has an active response"). The result is sent when it is ready, and the next reply is asked for after the current one is done.
- **Models are per region.** West US 3 refused `gpt-realtime` and offered only text models with Azure speech around them. East US 2 offered `gpt-realtime`, `gpt-realtime-mini`, `gpt-realtime-1.5`, and `gpt-realtime-2`. No model deployment was needed.

The demo needs no key and no token on a developer's machine: with only `AZURE_VOICE_LIVE_ENDPOINT` set, it asks the Azure CLI (`az login`) for a Microsoft Entra token and renews it before it runs out. The first try by hand used a token exported into the shell, which stopped working after an hour with nothing on the page to say why.

Typed chat can use Azure too, which showed one more limit. With `AZURE_OPENAI_MODELS` naming a deployment, the demo offers it in the model selector through the OpenAI-compatible adapter. `gpt-5.4` answered with a tool call and a `card-grid`. `gpt-6.1-sol` refused: on the chat completions API it takes function tools only with reasoning off, and it does not allow reasoning to be off, so it needs the Responses API. `src/openai-responses.ts` is that adapter, and the demo now asks Azure on it by default: `gpt-6.1-sol` and `gpt-5.4` both called `list_books` and answered with a `card-grid`, the first card on screen after about five and three seconds. It sends the whole conversation each round with `store: false`, and a tool round worked without sending the model's reasoning items back. Azure's `/models` lists every model it has and not the ones deployed, so deployments are named, not discovered. The demo also looks for an oMLX server on port 8000, with `OMLX_API_KEY` when it wants a key.

A call can fill in a form. The first real conversation, on the review demo, ended with the model explaining which button to press: it could show a `fact-check` and could not answer it. Two things were missing. A form pressed during a call posted to its route, which started a typed reply beside the spoken one; it is now sent with `voice=1`, the route answers `{ say }`, and that is said to the speech model. And the model had no hands: `fill_form` gives it `press`, `text`, and `field`, done by the browser on the newest unsent form. On a real call, "That one is correct. Add a note that I confirmed it with the store manager." typed the note, pressed Correct, recorded the decision, and the model showed the next item. An approval card is never one of the forms it can reach, and a browser test has a stand-in model try exactly that.

The voice controls also moved into the composer. `chat-voice` and `voice-call` have no box of their own (`display: contents`): each puts a button in the composer's row, and captions, call status, and the reading-aid controls are a line inside the same box.

Not tested with Azure: a real microphone, interruption, the service's echo cancellation and noise suppression (they are turned on, and nothing was said into them), a session that reaches its time limit on the real service, and a key in place of the token.

A reader who pauses was the next thing real calls showed. The provider took a pause for thought as the end of a turn and answered it, the reader went on, and the thread kept only the second half of what they said: Azure's completed transcript for the second utterance replaced the words of the first. Three changes came of it. A turn's words are kept per utterance (`components/chat/voice-call/reader.ts`), so a transcript corrects its own utterance only. A reply the reader spoke over before half a second of it had played, and that showed nothing, is taken back, and their turn goes on. And both providers take `pauseMs` (800 by default) with a pass-through for their own turn detection settings. A live check on 2026-11-27, `gpt-realtime-2` on API version `2026-04-10`: `end_of_utterance_detection: { model: "smart_end_of_turn_detection" }` was accepted, the text-based `semantic_detection_v1` was refused, and `{ type: "semantic_vad", eagerness: "low" }` and `remove_filler_words` were accepted. That is one observation. A refused setting used to leave the reader waiting for the connect timeout; the relay now ends the call at once and says so.

The same calls added a mute button, a question before an idle call ends, and the spoken word marked in the answer. The stand-ins test all of them (`lab:paused`, the mute and idle specs in `e2e/voice-lab.spec.ts`). Not tested on a real service: whether a provider bills anything for a muted, open call, and how each provider's own detector behaves at the edges of `pauseMs`.

## A UI layer without a client framework

AI SDK UI gives React apps a standard shape for chat: messages made of typed parts, tool calls with states, a stream protocol, and hooks that keep client state in step. This is the same idea for a server that sends HTML. The parts and states are kept; the protocol and the client state are not needed, because the stream is the page.

### A message is its parts

```ts
type MessagePart =
  | { type: "text"; text: string } // the model's output: prose, catalog tags, fences
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      state:
        | "approval-requested"
        | "client-requested"
        | "approved"
        | "denied"
        | "running"
        | "done"
        | "failed";
      output?: string;
      error?: string;
    };
```

Parts are what is stored, what the model is shown again, and what the page renders, so a tool call looks the same while it runs, after a reload, and to the model. `runTurn()` produces them. It is the tool loop, and it lives outside the provider adapter: a `Model` is one round that yields text and tool calls and never runs anything.

```ts
const turn = runTurn({ model, system, messages, tools, signal });
try {
  yield * renderTurn(turn.events, catalog, { tools, view });
} finally {
  await save(turn.message); // filled in as it goes, so a half-read reply is kept
}
```

### A tool call is drawn by the app, in every state

A tool part is sent as `<div class="part" data-state="…">`. What is inside comes from the app's `view(part)`, written with Bascik's `html` helper, so it can be any component; with no view it is the tool's `note`. When a call's state changes while the reply streams, the part is sent again, and one CSS rule hides the running version once the finished one follows it. A page that only ever grows still shows progress and then a result.

### Approval is a stored state, not client state

A tool marked `approval: true` does not run when the model calls it. The turn stops, the message is stored as `awaiting: "approval"`, and the part is drawn as a form with two buttons. The answer is a `POST /api/approve` (39 lines): it records `approved` or `denied` on the part and redirects to the page, which carries the same turn on, runs the call if it was allowed, and tells the model what happened either way. Close the tab and come back tomorrow and the question is still there. Send another message instead and the call is refused.

### A client tool is a form a script may answer

Some things only the reader's side knows: their local time, a choice, a file. A tool marked `client: true` has no `run`. The turn stops at the call, and the app draws it as a form that posts the result to `/api/result`. With scripts on, the component's script fills the form in and sends it, and the reader sees the answer arrive. With scripts off, the reader types it and presses Send. Either way the server gets one form post, stores it on the part as the tool's output, and carries the turn on. `local_time` is the example: "Is the shop open now?" in the bookshop.

### A reply belongs to the conversation, not the connection

The turn does not run inside the request that asked for it. It runs once, writes its HTML into a `createBroadcast()`, and stores its message when it ends. A page that shows the reply subscribes and gets it from the first chunk, however late it joined. So a reload in the middle of a reply joins it, a second tab shows the same reply, and a reply is finished and stored when nobody is watching. Only Stop, or a two-minute limit, ends one early. This is the resumable stream other stacks need a separate store and protocol for; here the broadcast is about 50 lines, because what is replayed is the page's own HTML.

### JavaScript adds, it does not carry

Every form works as a page load. `chat-enhance` is the optional client runtime, about 180 lines in one component: it sends a form with `fetch`, parses the page the server answers with as it streams, and copies the new thread into the open page. That gives an instant echo of the message, no reload, and a Stop button, with no change to the server and no second protocol: the response is the same HTML a browser with scripts off gets.

An interactive component is an ordinary Bascik component with a `<script>`. Bascik scopes its ids per instance and sends the script inside the rendered markup, so it starts when its component arrives in the stream; the runtime starts it the same way for markup it copies in. `data-table` is the example: a plain table without scripts, sortable and filterable with them.

### Use cases this is tested against

| Use case                                 | Where                                   | What it shows                                                                               |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| A tool call with progress, then a result | `/data`, "Top sellers"                  | `run_sql` as a part: running, then done, in one growing page                                |
| A tool that needs the reader's OK        | `/`, "Hold a copy of The Quiet Network" | `place_hold` waits, survives a reload, runs once allowed, never runs if refused             |
| An interactive generated component       | `/data`, the result table               | `data-table` sorts and filters in the browser, and is a table without scripts               |
| Streaming into the open page             | every app, with scripts on              | no page load, echo, Stop, and the sidebar refreshed from the same response                  |
| A tool the reader's browser answers      | `/`, "Is the shop open now?"            | `local_time` is answered by a script, or typed by the reader without one                    |
| A reply that outlives its page           | every app                               | reload mid-reply, open a second tab, or leave: one reply, shown from its start, stored once |

Each has unit tests (`src/turn.test.ts`, `src/render-turn.test.ts`, `src/broadcast.test.ts`, `src/anthropic.test.ts`) and browser tests. The whole browser suite runs twice, with JavaScript off and on, so the two paths cannot drift apart.

### What this did not test

- **A real model.** The Claude adapter is checked against a fake client, not the API. The message shapes it sends for tool results are the ones the previous adapter used.
- **More than one server.** A live reply is one process's memory. A reader who lands on another server mid-reply starts a second one, and Stop only reaches the server it lands on. Fixed by the `shared` option (`@bascik/ai/shared`): a lease, a replayable channel, and a small key-value store; see the "Running on Several Servers" docs page.
- **A reply nobody reads still costs tokens.** That is the price of finishing it. The limit is two minutes per reply.
- **File and source parts, and reasoning.** AI SDK UI has them. None is here yet.

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
- **The diagram is CSS.** A `flow-stage` is a list item with a `data-state` attribute; arrows, the highlight, and the dashed "unclear" border are styles. A branching diagram (a real decision tree, not a line of stages) needs a layout this does not have: that is what a `mermaid` fence is for.
- **A form per turn is slow for bulk work.** Checking forty codes in one table is fine. Confirming forty facts is forty page loads; a batch `fact-check` list, or a review page outside the chat, would suit that better.
- **Not tested:** a real model choosing the component. The offline reviewer follows a script. The instructions and a `review_queue` tool for a real model are in `demo/src/lib/apps.ts`, unrun.
- **Missing for real use:** sign-in (a visitor is an anonymous cookie, so the log cannot say who decided), a way to reopen a decision, and somewhere for the log to go other than a file.

## What the experiment showed

**It works, and most of it was already in Bascik.** The package is about 1,000 lines. The demo's only client script is a few optional lines that make Enter send the message.

**Things that fell out for free:**

- The composer is first in the source and placed last with CSS `order`, so it is usable before the reply starts ([Recipe C](https://bascik.dev/scripts/stream#recipe-c-priority-source-order-with-css-positioning-the-early-paint-footer-trick)).
- A `column-reverse` scroller keeps the newest text in view with no script.
- The typing caret is CSS: it shows from the stream's first chunk, an empty `.writing` marker, until its last, an empty `.done` marker.
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
