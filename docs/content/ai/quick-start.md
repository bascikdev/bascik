# Quick Start

A working chat from one tag: a sidebar, a message box and a conversation that streams the model's reply as HTML components. It starts with a scripted stand-in for the model, so it runs with no API key, and then swaps in a real one.

## Install

The package has two halves: functions you import, and components you copy into your project. Start in a Bascik project, or in an empty folder after `npm init -y` with `"type": "module"` added to its `package.json`.

```sh
npm install @bascik/bascik @bascik/ai
npm install --save-dev esbuild
npx bascik add @bascik/ai
```

`@bascik/ai` is an experimental 0.x package, so a minor version may change the API; pin the version you tested. The optional peers `@anthropic-ai/sdk` (for the Claude adapter) and `beautiful-mermaid` (for diagrams) are needed only when you use them.

[`bascik add`](/how-to/sharing-components) copies the package's components into `src/components/`, where they are your files to read and change:

```text
src/components/
  catalog/        components a model may write
    ask-button.html
    card-grid.html
    data-table.html
    note-box.html
    stat-tile.html
    ...
  chat/           the chat's own parts
    chat-app.html           the whole chat in one tag
    chat-thread.html        the conversation
    chat-composer.html      the message box
    chat-sidebar.html       the sidebar
    chat-enhance.html       the optional client runtime
    chat-turns.html         a data part: reads your chat
    chat-root/              a module the parts' scripts share
    ...
```

esbuild is needed because some chat parts (`chat-enhance`, `chat-attach`, `chat-voice` and `voice-call`, and so `chat-app`, which holds the first two) import TypeScript modules from the folders beside them, and Bascik bundles those into each script with esbuild. See [Importing TypeScript Modules](/scoped-javascript#importing-typescript-modules).

> **Add the whole package.** `bascik add @bascik/ai/<part>` copies one part, and today it may leave out `chat/chat-root/`, the module the parts' scripts share, so the part fails to build. `bascik add @bascik/ai` copies everything, and you delete what you do not use.

## A chat in one tag

Four things make the chat: one module that holds it, a route file for each form, a page, and a stylesheet with the theme.

### The project module

`src/lib/chat.ts` is the one module the chat parts read. Its default export is the project: an object with the `chat` that `createChat` made, and the few choices the parts cannot make for you. This one keeps conversations and attached files in a `.data` folder, lets the model write the copied catalog, and answers with a script:

```ts
// src/lib/chat.ts
import { readCatalog, scriptedModel } from "@bascik/ai";
import { createChat, fileStore, type ChatProject } from "@bascik/ai/app";
import { diskFiles } from "@bascik/ai/files";

// A stand-in that needs no API key. It writes what a model would: prose, and
// tags from the catalog.
const model = scriptedModel((request) =>
  [
    `You said: "${request.messages.at(-1)?.content ?? ""}". This reply is a script.`,
    "",
    "<card-grid>",
    '<stat-tile label="Refactoring the Monolith" value="4.7">Grace Lin</stat-tile>',
    '<stat-tile label="Practical Type Systems" value="4.5">Ada Okafor</stat-tile>',
    "</card-grid>",
    "",
    '<ask-button say="Which of these is the shortest?">Which is the shortest?</ask-button>',
  ].join("\n"),
);

export const chat = createChat({
  store: fileStore(".data/conversations"),
  files: diskFiles(".data/files"),
  catalog: () => readCatalog("src/components/catalog"),
  model: () => model,
  system: "You are a bookshop assistant. Keep answers short.",
});

export default {
  chat,
  welcome: {
    heading: "What are you reading next?",
    tagline: "Ask for a book, or start with one of these.",
    suggestions: [
      { label: "Recommend a book", say: "Recommend a book" },
      { label: "Something short", say: "Recommend a short book" },
    ],
  },
} satisfies ChatProject;
```

The default export is what the chat parts read, and only `chat` is required in it. The named `chat` export is for your own route files and scripts: the examples on the other pages import it as `import { chat } from "../lib/chat.ts"`. `ChatProject` also takes `models`, `routes`, `words`, `app`, `page` and `host`: see [Chat Parts](/ai/chat-parts#change-what-the-chat-says). Add `.data/` to your `.gitignore`.

### The routes

The parts are forms, and each posts to a route. A route file is one of the chat's handlers under a method name:

```ts
// src/api/send.ts: the message box, and every form a model writes
import project from "../lib/chat.ts";

export const POST = project.chat.send;
```

```ts
// src/api/stop.ts: the Stop button
import project from "../lib/chat.ts";

export const POST = project.chat.stop;
```

```ts
// src/api/open.ts: New chat, and each conversation in the sidebar
import project from "../lib/chat.ts";

export const POST = project.chat.open;
```

```ts
// src/api/file.ts: serves an attached file back to the reader who sent it
import project from "../lib/chat.ts";

export const GET = project.chat.file;
```

These four are what the default parts need. Other parts name their own when you add them: `/api/approve` for [tool approval](/ai/tools), `/api/forget` for [memory](/ai/memory), the three [voice](/ai/voice) routes, and `/api/model`, a route of your own, once you [offer a choice of model](/ai/chat-parts#offer-a-choice-of-model).

### The page

The body is one tag. The head carries the stylesheet and one link that a component cannot add for you:

```html
<!-- src/pages/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bookshop chat</title>
    <link rel="stylesheet" href="/style.css" />
    <link rel="expect" href="#thread-ready" blocking="render" />
  </head>
  <body>
    <chat-app />
  </body>
</html>
```

The `rel="expect"` link holds the first paint until the stored conversation is parsed, so a page never shows half a conversation. The reply being written streams in after it. A browser without `rel="expect"` paints earlier and nothing breaks.

### The theme

The parts take their colors from custom properties on the page. `chat-app` fills the window, so the body only sets the page's colors and font, with no margin:

```css
/* src/pages/style.css */
:root {
  color-scheme: light dark;
  --bg: light-dark(#fbfaf8, #1a1a19);
  --surface: light-dark(#f3f1ec, #232322);
  --border: light-dark(#dedad2, #3a3a37);
  --text: light-dark(#1f1e1c, #ecebe7);
  --muted: light-dark(#6b6862, #a3a099);
  --accent: light-dark(#b4512c, #e08a5f);
  --on-accent: light-dark(#ffffff, #1a1a19);
  --radius: 10px;
  /* The text color of a drawn diagram. */
  --fg: var(--text);
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font:
    16px/1.55 system-ui,
    sans-serif;
}
```

Define all nine; see [Theming](/how-to/theming) for how to organize them. Four more are optional, and a part that reads one falls back to the value shown:

| Property         | Fallback    | What it sets                                                        |
| :--------------- | :---------- | :------------------------------------------------------------------ |
| `--gap`          | `0.75rem`   | The space between two parts of one reply.                           |
| `--gap-tight`    | `0.25rem`   | The space between parts that belong together, such as status lines. |
| `--text-small`   | `0.875rem`  | Secondary text: a note, a step's detail, an approval card.          |
| `--text-smaller` | `0.8125rem` | The smallest text: a tool's status line.                            |

Catalog components carry no outer margin. `chat-thread`, the part that holds the conversation, puts the parts of a reply one `--gap` apart, so a page that uses it writes no spacing rules of its own.

### Let a reply take its time

A reply streams for as long as the model writes, so give request-time scripts a longer time limit than a page usually needs. The starter uses two minutes:

```ts
// bascik.config.ts
import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  scripts: { timeout: 120_000 },
});
```

Run `npx bascik` and open the page. The welcome shows two suggestions; press one, or type a message. The reply arrives a few characters at a time, and each component arrives whole, with its scoped styles. Type `What is <b>this</b>` and the tag is shown as text: the reader's words and the model's words are both untrusted, and only catalog tags become elements. Everything on the page works with JavaScript off, as page loads.

### The same project, ready to copy

The repository's [`ai/examples/starter`](https://github.com/bascikdev/bascik/tree/main/ai/examples/starter) is this project: the page, the stylesheet, the module, the four routes and the config. Copy its `src/` folder and its `bascik.config.ts` into a project that ran the install commands above, then change the two lines its README names: remove the `directory` line in `bascik.config.ts`, and set `CATALOG_DIR` in `src/lib/chat.ts` to your `src/components/catalog`. Both lines exist only because the example reads the parts from the package's folder beside it. If you keep a config of your own, add `scripts: { timeout: 120_000 }` to it in place of copying the file.

## Use a real model

A model is a function from a request to a stream of text. In `src/lib/chat.ts`, replace the stand-in with Claude:

```ts
import { anthropicModel } from "@bascik/ai/anthropic";

// Reads ANTHROPIC_API_KEY from the environment.
const model = anthropicModel();
```

Or with any server that speaks the OpenAI chat completions API, such as Ollama or LM Studio on your own machine:

```ts
import { openAiCompatibleModel } from "@bascik/ai/openai";

const model = openAiCompatibleModel({
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2:3b",
});
```

Or with OpenAI's Responses API, which OpenAI and Azure OpenAI speak, and which some newer models need before they will call a tool:

```ts
import { openAiResponsesModel } from "@bascik/ai/openai-responses";

const model = openAiResponsesModel({
  baseUrl: "https://my-resource.openai.azure.com/openai/v1",
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  model: "my-deployment",
});
```

The Claude adapter needs `@anthropic-ai/sdk` installed. The two OpenAI ones use `fetch` and need nothing. `catalogPrompt(catalog)` is the system prompt that teaches the model the output format and your components; put your own instructions before it.

## Change it

`<chat-app />` is a starting point that stays out of your way. Each step further is on [Chat Parts](/ai/chat-parts):

| To                                                        | Do this                                                                                            |
| :-------------------------------------------------------- | :------------------------------------------------------------------------------------------------- |
| Change the welcome, the words, the routes, or list models | Add a value to the default export of `src/lib/chat.ts`.                                            |
| Add voice, change a label, drop attachments               | Fill `chat-app`'s `composer` or `sidebar` slot with that part, written your way.                   |
| Change the layout                                         | Copy the template of `src/components/chat/chat-app.html` into your page. It is only the parts.     |
| Use one part somewhere else                               | Write its tag. Every part works alone: see [Components](/ai/components#chat-and-voice-components). |

The next pages cover what a chat adds: [tools](/ai/tools), the [client runtime](/ai/client-runtime), [memory](/ai/memory), and [voice](/ai/voice).

## Stream a reply without the chat

The renderer under the chat also works alone, for a page that answers one question and keeps nothing. That page is a form and a stream script. The script reads the catalog from the folder `bascik add` made, asks the model, and yields what `renderStream` gives back:

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
        } from "@bascik/ai";

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

Ask something, and the reply arrives a few characters at a time, with the note arriving whole as the `note-box` component. Nothing is stored, and no route is needed. Catalog components carry no outer margin, so a reply shown outside `chat-thread` needs spacing from your own stylesheet, or its parts touch each other.
