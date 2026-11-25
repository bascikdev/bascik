# Quick Start

A page that answers a question with prose and a component, streamed as HTML. It uses a scripted stand-in for the model, so it runs with no API key, and then swaps in a real one.

## Install

The package has two parts: functions you import, and components you copy into your project.

```sh
npm install @bascik/genui
npx bascik add @bascik/genui
```

> **Not on npm yet.** Until the package is published, build it from the Bascik repository: `yarn workspace @bascik/genui pack` writes a tarball you can install with `npm install ./package.tgz`.

[`bascik add`](/how-to/sharing-components) copies the package's components into `src/components/`, where they are your files to read and change:

```text
src/components/
  catalog/        components a model may write
    ask-button.html
    bar-chart.html
    card-grid.html
    data-table.html
    note-box.html
    stat-tile.html
    ...
  chat/           the chat's own pieces
    chat-composer.html
    chat-enhance.html
    chat-voice.html
    voice-call.html
    tool-approval.html
    tool-status.html
```

The components read a few custom properties for their colors: `--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--on-accent`, and `--radius`. Define them once in your stylesheet; see [Theming](/how-to/theming).

## Stream a reply

A page with a form and a stream script. The script reads the catalog from the folder `bascik add` made, asks the model, and yields what `renderStream` gives back:

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ask</title>
  </head>
  <body>
    <form>
      <input name="q" aria-label="Question" />
      <button>Ask</button>
    </form>
    <div>
      <script data-bascik-stream type="text/typescript">
        import {
          catalogPrompt,
          readCatalog,
          renderStream,
          scriptedModel,
        } from "@bascik/genui";

        // A stand-in that needs no API key. It writes what a model would:
        // prose, and tags from the catalog.
        const model = scriptedModel(
          ({ messages }) =>
            `You asked: **${messages.at(-1)!.content}**\n\n` +
            `<note-box title="No model yet">This reply is a script.</note-box>`,
        );

        export default async function* (request: Request) {
          const question = new URL(request.url).searchParams.get("q");
          if (!question) return;
          const catalog = await readCatalog("src/components/catalog");
          const reply = model({
            system: catalogPrompt(catalog),
            messages: [{ role: "user", content: question }],
          });
          yield* renderStream(reply, catalog);
        }
      </script>
    </div>
  </body>
</html>
```

Run `bascik`, open the page, and ask something. The reply arrives a few characters at a time, and the note arrives whole, as the `note-box` component with its scoped styles. Ask `What is <b>this</b>` and the tag is shown as text: the reader's words and the model's words are both untrusted, and only catalog tags become elements.

## Use a real model

A model is a function from a request to a stream of text. Replace the stand-in with Claude:

```ts
import { anthropicModel } from "@bascik/genui/anthropic";

// Reads ANTHROPIC_API_KEY from the environment.
const model = anthropicModel();
```

Or with any server that speaks the OpenAI chat completions API, such as Ollama or LM Studio on your own machine:

```ts
import { openAiCompatibleModel } from "@bascik/genui/openai";

const model = openAiCompatibleModel({
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2:3b",
});
```

The Claude adapter needs `@anthropic-ai/sdk` installed. The OpenAI-compatible one uses `fetch` and needs nothing. `catalogPrompt(catalog)` is the system prompt that teaches the model the output format and your components; put your own instructions before it.

## Make it a chat

One question and one answer needs no storage. A chat does: the conversation so far, a route the composer posts to, and a redirect back to the page that streams the reply. That is application code, and the repository's demo is a working version to copy from:

| What                                                      | Where in `genui/demo/src/`    |
| :-------------------------------------------------------- | :---------------------------- |
| The conversation store, one JSON file per conversation    | `lib/chat.ts`                 |
| The thread: stored messages, then the reply being written | `components/chat-thread.html` |
| `POST /api/send`: store the message, redirect to the page | `api/send.ts`                 |
| Four apps on one shell, each with its own tools           | `lib/apps.ts`                 |

The next pages cover what a chat adds: [tools](/genui/tools), the [client runtime](/genui/client-runtime), and [voice](/genui/voice).
