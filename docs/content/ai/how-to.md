# How-To Guides

This page lists the shortest correct path to common goals using the `@bascik/ai` package.

## Add a chat to a Bascik site

1. Install the package and copy its components into your project.

```sh
npm install @bascik/ai
npx bascik add @bascik/ai
```

2. Create a chat object in a library file using a memory store for a first try.

```ts
// src/lib/chat.ts
import { createChat, memoryStore } from "@bascik/ai/app";

export const chat = createChat({
  store: memoryStore(),
  catalog,
  model: () => model,
  system: "You are a helpful assistant.",
});
```

3. Create route files that export the chat handlers.

```ts
// src/api/send.ts
import { chat } from "../lib/chat.ts";
export const POST = chat.send;
```

4. Build a page that gets the thread state and yields the live reply.

```ts
// In a stream script
const state = await chat.thread(request);
if (state.turn) {
  yield * state.turn.html.subscribe();
}
```

More: [Quick Start](/ai/quick-start)

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

4. Use `chat.memories(request)` to list memories on a page.

```ts
const memories = await chat.memories(request);
```

More: [Memory](/ai/memory)

## Let readers search their conversations

1. Add a search form to your page that sends a GET request with a `q` parameter.

```html
<form method="get" action="/">
  <input name="q" type="search" />
  <button>Search</button>
</form>
```

2. In your page script, call `chat.search(request)` to get matches.

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

3. Enable the attach button in the composer by setting the `enctype` prop.

```html
<chat-composer data-bascik-prop-enctype="multipart/form-data" />
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

3. Add the `voice-call` component to your composer.

```html
<chat-composer>
  <voice-call data-bascik-prop-app="books" />
</chat-composer>
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
