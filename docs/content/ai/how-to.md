# How-To Guides

This page lists the shortest correct path to common goals using the `@bascik/ai` package.

## Add a chat to a Bascik site

1. Install the package, esbuild, and copy the components into your project.

```sh
npm install @bascik/bascik @bascik/ai
npm install --save-dev esbuild
npx bascik add @bascik/ai
```

2. Create the project module. The chat parts read its default export, and the route files use its `chat`. A memory store is enough for a first try.

```ts
// src/lib/chat.ts
import { readCatalog, scriptedModel } from "@bascik/ai";
import { createChat, memoryStore, type ChatProject } from "@bascik/ai/app";

// A stand-in that needs no API key: see Quick Start for a real model.
const model = scriptedModel(() => "Hello.");

export const chat = createChat({
  store: memoryStore(),
  catalog: () => readCatalog("src/components/catalog"),
  model: () => model,
  system: "You are a helpful assistant.",
});

export default { chat } satisfies ChatProject;
```

3. Create a route file for each handler the parts post to: `send`, `stop`, `open`, and `file` when the chat takes attachments.

```ts
// src/api/send.ts
import { chat } from "../lib/chat.ts";
export const POST = chat.send;
```

4. Put the chat in a page, with the theme stylesheet and the `rel="expect"` link in its head.

```html
<head>
  <link rel="stylesheet" href="/style.css" />
  <link rel="expect" href="#thread-ready" blocking="render" />
</head>
<body>
  <chat-app />
</body>
```

More: [Quick Start](/ai/quick-start)

## Change one part of the chat

1. To change what a part says, add a value to the project module's default export: `welcome`, `words`, `models` or `routes`.

```ts
export default {
  chat,
  welcome: { heading: "What are you reading next?" },
} satisfies ChatProject;
```

2. To change a part's props or what it holds, fill `chat-app`'s `sidebar` or `composer` slot with that part. The slot replaces the whole part, and it is filled with a wrapper element.

```html
<chat-app>
  <template data-bascik-slot="composer">
    <chat-composer data-bascik-prop-placeholder="Ask about a book…" />
  </template>
</chat-app>
```

3. To change the layout, copy the template of `src/components/chat/chat-app.html` into your page and edit it.

More: [Chat Parts](/ai/chat-parts)

## Let the model show your own component

1. Create an HTML file in the `src/components/catalog/` folder.

```html
<!-- src/components/catalog/my-card.html -->
<!-- @bascik
A card for a specific item.
-->
<div class="card">
  <span data-bascik-prop-title></span>
</div>
```

2. The file name becomes the tag name, and the `@bascik` comment becomes the description the model reads.

3. Pass the folder to `readCatalog` and use the result in the system prompt.

```ts
import { catalogPrompt, readCatalog } from "@bascik/ai";

const catalog = await readCatalog("src/components/catalog");
const system = `Instructions.\n\n${catalogPrompt(catalog)}`;
```

More: [Catalog](/ai/catalog)

## Ask before a tool changes something

1. Define a tool with `approval: true` in its configuration.

```ts
{
  name: "place_hold",
  description: "Hold a book.",
  inputSchema: { type: "object", properties: { title: { type: "string" } } },
  approval: true,
  run: (input) => placeHold(String(input.title)),
}
```

2. The turn stops when the model calls it, and the part state becomes `approval-requested`.

3. Render the approval state using the `tool-approval` component or a custom form.

```ts
view: (part) =>
  part.state === "approval-requested"
    ? html`<tool-approval
        data-bascik-prop-call="${part.id}"
        data-bascik-prop-action="${part.name}"
      ></tool-approval>`
    : null,
```

4. Create a route that records the decision and redirects back to the page.

```ts
// src/api/approve.ts
import { decideToolCall } from "@bascik/ai";
// ... load conversation, call decideToolCall, save, redirect
```

More: [Tools & Approval](/ai/tools)

## Remember things about a reader

1. Pass a memory store to the `memory` option in `createChat`.

```ts
import { fileMemories } from "@bascik/ai/app";

export const chat = createChat({
  // ...
  memory: fileMemories(".data/memory"),
});
```

2. The model automatically gets `remember`, `recall`, and `forget` tools.

3. Add a route to handle the `forget` handler so readers can remove memories.

```ts
// src/api/forget.ts
import { chat } from "../lib/chat.ts";
export const POST = chat.forget;
```

4. List the reader's memories on a page with the `chat-memories` part, inside a column that sets its width.

```html
<main class="page">
  <chat-memories />
</main>
```

More: [Memory](/ai/memory)

## Let readers search their conversations

1. Use `chat-find`, which is in `chat-app`'s default sidebar. It prints the search box and, on a page whose address has `?q=`, what was found.

```html
<chat-sidebar data-show-found="true">
  <chat-find />
  <chat-conversations />
</chat-sidebar>
```

2. For results drawn your own way, call `chat.search(request)` in a page script.

```ts
const { matches } = await chat.search(request);
```

3. To let the model search past conversations, set `history: true` in `createChat`.

```ts
export const chat = createChat({
  // ...
  history: true,
});
```

More: [Conversation Search](/ai/conversation-search)

## Accept images and files

1. Pass a file store to the `files` option in `createChat`.

```ts
import { diskFiles } from "@bascik/ai/files";

export const chat = createChat({
  // ...
  files: diskFiles(".data/files"),
});
```

2. Add a route to serve attached files back to the reader.

```ts
// src/api/file.ts
import { chat } from "../lib/chat.ts";
export const GET = chat.file;
```

3. Put `chat-attach` in the composer's `start` slot, inside a wrapper element, and write `enctype` on the composer's tag. `chat-app`'s default message box already has both.

```html
<chat-composer enctype="multipart/form-data">
  <span data-bascik-slot="start"><chat-attach /></span>
</chat-composer>
```

More: [Attachments](/ai/attachments)

## Add a voice call with Gemini Live

1. Create a voice provider using `geminiLiveVoice`.

```ts
import { geminiLiveVoice } from "@bascik/ai/gemini-live";
const voice = geminiLiveVoice();
```

2. Create a route that generates a session ticket.

```ts
// src/api/voice-session.ts
import { voicePrompt, voiceTools } from "@bascik/ai/voice";

export const POST = async () => {
  const ticket = await voice.createSession({
    system: `Instructions.\n\n${voicePrompt(catalog)}`,
    tools: voiceTools(tools),
  });
  return Response.json(ticket);
};
```

3. Add the `voice-call` component to your composer. With `chat-app`, that means filling its `composer` slot.

```html
<chat-app>
  <template data-bascik-slot="composer">
    <chat-composer data-bascik-prop-autofocus="autofocus">
      <voice-call />
    </chat-composer>
  </template>
</chat-app>
```

More: [Voice & Captions](/ai/voice)

## Add a voice call with Azure Voice Live

1. Create a voice provider using `azureVoiceLiveVoice`. A relay is needed because Azure has no one-use browser token.

```ts
import { azureVoiceLiveVoice } from "@bascik/ai/azure-voice-live";
const voice = azureVoiceLiveVoice({
  model: "gpt-realtime-2",
});
```

2. Start the relay when the server starts.

```ts
await voice.listen();
```

3. Use the same route structure as Gemini Live to provide the ticket.

```ts
// src/api/voice-session.ts
export const POST = async () => {
  const ticket = await voice.createSession({
    system: `Instructions.\n\n${voicePrompt(catalog)}`,
    tools: voiceTools(tools),
  });
  return Response.json(ticket);
};
```

More: [Voice & Captions](/ai/voice)

## Use a model on your own machine

1. Import the OpenAI-compatible adapter.

```ts
import { openAiCompatibleModel } from "@bascik/ai/openai";
```

2. Configure it with the base URL of your local server, such as Ollama.

```ts
const model = openAiCompatibleModel({
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.2:3b",
});
```

3. Pass this model function to `createChat`.

More: [Providers](/ai/providers)

## Keep conversations in your own database

1. Implement the `ConversationStore` interface with `load`, `save`, and `list` methods.

```ts
import type { ConversationStore } from "@bascik/ai/app";

export const dbStore: ConversationStore = {
  async load(reader, id) {
    /* SELECT */
  },
  async save(reader, conversation) {
    /* INSERT */
  },
  async list(reader) {
    /* SELECT */
  },
};
```

2. Pass your store to the `store` option in `createChat`.

```ts
export const chat = createChat({
  store: dbStore,
  // ...
});
```

More: [Server Kit](/ai/server-kit)

## Run on more than one server

1. Implement the `Shared` interface to handle leases, channels, and key-value storage across servers.

```ts
import type { Shared } from "@bascik/ai/shared";
// Implement claim, publish, subscribe, get, set, delete, take
```

2. Pass your shared implementation to the `shared` option in `createChat`.

```ts
export const chat = createChat({
  // ...
  shared: redisShared(redis),
});
```

3. Ensure your conversation store is also accessible by all servers.

More: [Running on Several Servers](/ai/scaling)
