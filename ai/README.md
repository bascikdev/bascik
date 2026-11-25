# @bascik/ai

Bascik AI is the AI interface for Bascik. It consists of three parts: Chat, Generative UI, and Voice.

> **Experimental.** This package is 0.x and its API may change between releases. Pin the version you use, and read the [changelog](https://bascik.dev/releases) before upgrading.

## Install

```sh
npm i @bascik/ai
npx bascik add @bascik/ai
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
    } from "@bascik/ai";

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
import { anthropicModel } from "@bascik/ai/anthropic";

// Reads ANTHROPIC_API_KEY from the environment.
const model = anthropicModel();
```

## Entry points

| Import                        | What it is                                                                                    |
| :---------------------------- | :-------------------------------------------------------------------------------------------- |
| `@bascik/ai`                  | The catalog, the streaming renderer, the model and tool types, and `scriptedModel`.           |
| `@bascik/ai/app`              | The chat server kit (handlers, sessions, conversation store).                                 |
| `@bascik/ai/memory`           | Long-term memory stores and tools.                                                            |
| `@bascik/ai/files`            | Attachment storage and checks.                                                                |
| `@bascik/ai/shared`           | State shared across several servers.                                                          |
| `@bascik/ai/anthropic`        | A model backed by Claude, through `@anthropic-ai/sdk` (an optional peer dependency).          |
| `@bascik/ai/openai`           | A model for any server that speaks OpenAI chat completions, such as Ollama or LM Studio.      |
| `@bascik/ai/openai-responses` | A model for the OpenAI Responses API, spoken by OpenAI and Azure OpenAI.                      |
| `@bascik/ai/voice`            | Voice sessions with a speech-to-speech model: tickets, tools, and the record of a call.       |
| `@bascik/ai/gemini-live`      | A voice provider for Google's Gemini Live API.                                                |
| `@bascik/ai/azure-voice-live` | A voice provider for Azure Voice Live, with a server relay that keeps the credential private. |
| `@bascik/ai/mermaid`          | Mermaid diagrams drawn on the server, through `beautiful-mermaid` (an optional peer).         |

## Learn more

- [Quick Start](https://bascik.dev/ai/quick-start): install, stream a reply, and make it a chat.
- [Server Kit](https://bascik.dev/ai/server-kit): the server-side infrastructure for Chat.
- [Catalog](https://bascik.dev/ai/catalog): the components a model may write, and how to add your own.
- [Tools](https://bascik.dev/ai/tools): let a model call your functions, with approval where you want it.
- [Memory](https://bascik.dev/ai/memory): persistent memory for Chat.
- [Providers](https://bascik.dev/ai/providers): configures the AI providers used by the system.
- [Client runtime](https://bascik.dev/ai/client-runtime): the optional script that streams answers into the open page.
- [Voice](https://bascik.dev/ai/voice): talk to a speech-to-speech model.
- [Conversation Search](https://bascik.dev/ai/conversation-search): finds words in a reader's past conversations.
- [Attachments](https://bascik.dev/ai/attachments): handles file attachments for Chat.
- [Scaling](https://bascik.dev/ai/scaling): supports running on several servers for Chat.
- [Design principles](https://bascik.dev/ai/design-principles): why replies are HTML and interaction is forms.

## License

MIT
