# @bascik/ai

Bascik AI is the AI interface for Bascik. It consists of three parts: Chat, Generative UI, and Voice.

> **Experimental.** This package is 0.x and its API may change between releases. Pin the version you use, and read the [changelog](https://bascik.dev/releases) before upgrading.

## Install

```sh
npm i @bascik/ai
npx bascik add @bascik/ai
```

The package has two parts: functions you import, and components you copy. [`bascik add`](https://bascik.dev/how-to/sharing-components) copies the components into `src/components/`, where they are your files to read and change. `catalog/` holds the components a model may write, and `chat/` holds the chat's own parts: the layout parts (thread, composer, sidebar), the data parts that read your chat, and `chat-app`, which is all of them put together.

Requires Node 24.21 or newer and `@bascik/bascik` 1.0.2 or newer. Some chat components (`chat-enhance`, `chat-attach`, `chat-voice`, `voice-call`, and so `chat-app`, which holds the first two) import TypeScript modules from the folders beside them, which Bascik bundles with esbuild: install it in the project that builds them (`npm install --save-dev esbuild`).

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

## The whole chat in one tag

`chat-app` is the sidebar, the message box and the conversation, assembled from the other parts. A page whose body is that one tag is a working chat:

```html
<!-- src/pages/index.html -->
<head>
  <link rel="stylesheet" href="/style.css" />
  <link rel="expect" href="#thread-ready" blocking="render" />
</head>
<body>
  <chat-app />
</body>
```

The stylesheet defines the theme tokens the parts read (`--bg`, `--surface`, `--border`, `--text`, `--muted`, `--accent`, `--on-accent`, `--radius` and `--fg`), and the `rel="expect"` link holds the first paint until the stored conversation is parsed.

The data parts inside `chat-app` read your chat from one module, `src/lib/chat.ts`, whose default export is `{ chat }` with the chat `createChat` made. The same object takes your `welcome`, `models`, `routes` and `words` (the `ChatProject` type from `@bascik/ai/app`):

```ts
// src/lib/chat.ts
import { createChat, memoryStore, type ChatProject } from "@bascik/ai/app";

const chat = createChat({ store: memoryStore(), catalog, model, system });

export default {
  chat,
  welcome: { heading: "What are you reading next?" },
} satisfies ChatProject;
```

Each route the parts post to is one line in its own file: `send`, `stop` and `open`, and `file` for attachments.

```ts
// src/api/send.ts
import project from "../lib/chat.ts";

export const POST = project.chat.send;
```

From there, three steps take you as far as you need:

- **Change what a part says:** add a value to the module's default export.
- **Change a part:** fill `chat-app`'s `sidebar` or `composer` slot with your own, inside a wrapper element. A slot replaces the whole part.

  ```html
  <chat-app>
    <template data-bascik-slot="composer">
      <chat-composer><chat-voice /></chat-composer>
    </template>
  </chat-app>
  ```

- **Change the layout:** copy the template of `chat-app.html` into your page. It is nothing but the parts, and every part works alone.

The parts are grouped as the frame (`chat-app`, `chat-thread`, `chat-sidebar`, `chat-enhance`), the data parts (`chat-turns`, `chat-conversations`, `chat-find`, `chat-models`, `chat-memories`), the message box (`chat-composer`, `chat-attach`, `chat-voice`, `voice-call`), the sidebar's controls, and memory. Each part's file starts with a comment that gives its props, slots and what it needs around it. [`examples/starter`](https://github.com/bascikdev/bascik/tree/main/ai/examples/starter) is the smallest project that does this, with a scripted model, so it runs with no key. [Chat Parts](https://bascik.dev/ai/chat-parts) has the rest.

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
| `@bascik/ai/sandbox`          | Opt-in open-ended pages: a model-written page in a sandboxed frame with no network.           |

## Learn more

- [Quick Start](https://bascik.dev/ai/quick-start): install, and get a working chat from one tag.
- [Chat Parts](https://bascik.dev/ai/chat-parts): change the one tag, assemble the parts yourself, and the contract they share.
- [Components](https://bascik.dev/ai/components): every catalog component and chat part, with its props and slots.
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
