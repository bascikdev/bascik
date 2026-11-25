# @bascik/genui

Generative UI for [Bascik](https://bascik.dev). A model streams prose and component tags, and Bascik renders the tags as scoped HTML while the reply is still arriving. Only components from your catalog become elements, so the browser needs no JavaScript to show a reply and a model cannot write markup you did not offer.

> **Experimental.** This package is 0.x and its API may change between releases. Pin the version you use, and read the [changelog](https://bascik.dev/releases) before upgrading.

## Install

```sh
npm i @bascik/genui
npx bascik add @bascik/genui
```

The package has two parts: functions you import, and components you copy. [`bascik add`](https://bascik.dev/how-to/sharing-components) copies the components into `src/components/`, where they are your files to read and change. `catalog/` holds the components a model may write, and `chat/` holds the chat's own pieces (composer, voice, tool approval).

Requires Node 24.21 or newer and `@bascik/bascik` 1.0.2 or newer.

## Minimal example

A page with a form and a stream script. The model here is a scripted stand-in that needs no API key; swap in `anthropicModel()` or another adapter below for a real one.

```html
<!-- src/pages/index.html -->
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
```

For a real model, replace the stand-in:

```ts
import { anthropicModel } from "@bascik/genui/anthropic";

// Reads ANTHROPIC_API_KEY from the environment.
const model = anthropicModel();
```

## Entry points

| Import                           | What it is                                                                                    |
| :------------------------------- | :-------------------------------------------------------------------------------------------- |
| `@bascik/genui`                  | The catalog, the streaming renderer, the model and tool types, and `scriptedModel`.           |
| `@bascik/genui/anthropic`        | A model backed by Claude, through `@anthropic-ai/sdk` (an optional peer dependency).          |
| `@bascik/genui/openai`           | A model for any server that speaks OpenAI chat completions, such as Ollama or LM Studio.      |
| `@bascik/genui/openai-responses` | A model for the OpenAI Responses API, spoken by OpenAI and Azure OpenAI.                      |
| `@bascik/genui/voice`            | Voice sessions with a speech-to-speech model: tickets, tools, and the record of a call.       |
| `@bascik/genui/gemini-live`      | A voice provider for Google's Gemini Live API.                                                |
| `@bascik/genui/azure-voice-live` | A voice provider for Azure Voice Live, with a server relay that keeps the credential private. |
| `@bascik/genui/mermaid`          | Mermaid diagrams drawn on the server, through `beautiful-mermaid` (an optional peer).         |

## Learn more

- [Quick Start](https://bascik.dev/genui/quick-start): install, stream a reply, and make it a chat.
- [Catalog](https://bascik.dev/genui/catalog): the components a model may write, and how to add your own.
- [Tools](https://bascik.dev/genui/tools): let a model call your functions, with approval where you want it.
- [Client runtime](https://bascik.dev/genui/client-runtime): the optional script that streams answers into the open page.
- [Voice](https://bascik.dev/genui/voice): talk to a speech-to-speech model.
- [Design principles](https://bascik.dev/genui/design-principles): why replies are HTML and interaction is forms.

## License

MIT
