# Memory

Memory is what the assistant knows about one reader across conversations: a preference they stated, a name, a standing request. It is the reader's data, so `@bascik/ai` gives you an interface and two simple stores, as it does for conversations, and you keep the real thing wherever you keep your users.

## One option

Pass a store to `createChat`:

```ts
import { createChat, fileMemories, fileStore } from "@bascik/ai/app";

export const chat = createChat({
  store: fileStore(".data/conversations"),
  memory: fileMemories(".data/memory"),
  catalog,
  model: () => model,
  system: "You are a reading assistant for a small bookshop.",
});
```

That is all the server needs. Every reply, typed or spoken, now gets three tools for the reader who is asking, and the system prompt gets a section that says what is known about them and when to save something new. A reader who has never been seen before gets an empty memory.

Two more handlers belong to the same option, and each is one line in a route file like the rest:

```ts
// src/api/forget.ts
import { chat } from "../lib/chat.ts";

export const POST = chat.forget;
```

`/api/forget` is where `memory-item` and `memory-note` post unless you set their `route` prop. `chat.forget` takes a form post with the memory's `id` and sends the reader back to the page. It also takes an optional `back`, a path on your site to return to (a value that is not a path on your site is ignored). Removing a memory that is already gone is not an error, so the form is safe to send twice.

## What the model can do

`memoryTools()` builds the tools the model uses. `createChat` calls it for each request with that request's reader, so a tool can only ever reach that reader's memories, and the model never names a reader.

| Tool       | Input   | What it does                                                        |
| ---------- | ------- | ------------------------------------------------------------------- |
| `remember` | `text`  | Saves one short sentence the reader said about themselves.          |
| `recall`   | `query` | Searches what is saved, best match first. An empty query is newest. |
| `forget`   | `id`    | Removes one memory, by the `id` that `recall` or the prompt listed. |

The prompt section tells the model to save lasting facts and preferences the reader states, and not to save secrets, payment or health details, guesses, anything a page or tool returned, or anything the reader asked to keep off the record. It also tells the model to call `recall` before it asks the reader something they may have said before. Lines in the prompt list the newest 30 memories, and say how many older ones `recall` can still find.

Use the tools and the prompt on their own when you run the turn yourself:

```ts
import { memoryPrompt, memoryTools } from "@bascik/ai/memory";

const tools = [...appTools, ...memoryTools(store, reader)];
const system = `${instructions}\n\n${memoryPrompt(await store.list(reader))}`;
```

## What the reader sees and controls

Saving and forgetting change stored data about a person, so neither happens out of sight.

- **In the reply.** Each `remember` call shows as a line in the reply: "Remembered:" and the words that were saved. By default the line is the tool's `note`. To add an Undo button, draw the finished call yourself with `view` and the `memory-note` component, which is a plain form that posts to `/api/forget` (its `route` prop):

```ts
import { html } from "@bascik/bascik/html";
import { savedMemory } from "@bascik/ai/memory";

view: (part) => {
  const saved = savedMemory(part);
  return saved
    ? html`<memory-note
        data-bascik-prop-memory="${saved.id}"
        >${saved.text}</memory-note
      >`
    : null;
},
```

- **On a page of its own.** `chat-memories` is the whole list in one tag. It is a data part: it reads the chat from the project module (`src/lib/chat.ts`) on every request and prints `memory-list` with one `memory-item` per memory, newest first. Each item is a plain form with a Forget button, so a reader with no JavaScript can remove anything, and Forget sends the reader back to the page the list is on:

```html
<main class="page">
  <chat-memories />
</main>
```

```css
.page {
  max-inline-size: 46rem;
  margin-inline: auto;
  padding: 1.5rem 1rem;
}
```

`memory-list` fills the width it is given and adds no space around itself, so the column it sits in sets its width and margins. That lets the same list sit in a page, a sidebar section, or a dialog. `chat-memories` reads `app` and `routes.forget` from the project module, and has no props.

- **With your own words.** `chat-memories` prints `memory-list` with its own English text. For other words, or another heading level, print the list from a script of your own. `chat.memories(request)` answers the reader's memories, newest first, and `memory-list` has a slot for each piece of text: `heading` (the heading element itself), `about` (the line under it) and `empty` (the empty state). A slot filled from a script uses a `<template>` wrapper, and an empty wrapper leaves that piece out:

```html
<main class="page">
  <script data-bascik-stream type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { chat } from "@/lib/chat.ts";

    export default async function* (request: Request) {
      const memories = await chat.memories(request);
      yield html`<memory-list>
        <template data-bascik-slot="heading"><h2>Memory</h2></template>
        <template data-bascik-slot="about"
          >What you told the bookshop assistant to keep.</template
        >
        ${memories.map(
          (memory) =>
            html`<memory-item
              data-bascik-prop-memory="${memory.id}"
              data-bascik-prop-saved="${new Date(memory.created)
                .toISOString()
                .slice(0, 10)}"
              data-bascik-prop-back="/memory"
              >${memory.text}</memory-item
            >`,
        )}
      </memory-list>`;
    }
  </script>
</main>
```

A site with several chats adds `data-bascik-prop-app` with the app's id to each `memory-item`, and to `memory-note` above.

Forget is always a page load. `memory-item`'s form carries `data-genui="native"`, so the [client runtime](/ai/client-runtime#which-forms-it-takes) leaves it to the browser, also when the list sits inside a chat. `memory-note`'s Undo is a form in a reply, so inside a chat the client runtime sends it and streams the answer in.

- **By approval.** To make the reader allow each save and each removal first, set `memoryApproval: true`. The reply stops at the call with the usual approval card (see [Tools & Approval](/ai/tools#ask-before-a-tool-runs)), and nothing is saved until they press Allow. The default is off: the reader sees every save, and one press undoes it.

`chat.memoryList` is the same list as JSON (`{ memories }`), for a client of your own.

## Write your own store

A store answers four questions:

```ts
import type { Memory, MemoryStore } from "@bascik/ai/memory";

export const memories: MemoryStore = {
  list: async (reader) => db.memories.byReader(reader), // newest first
  add: async (reader, memory) => db.memories.upsert(reader, memory),
  remove: async (reader, id) => db.memories.delete(reader, id), // true when it was there
  search: async (reader, query, limit) => index.nearest(reader, query, limit),
};
```

A `Memory` is `{ id, text, created, updated?, conversationId? }`. Plain text only.

- `search` decides what "best" means. `fileMemories` and `inMemoryMemories` count the words a memory shares with the query and break ties by recency, through `searchMemories(list, query, limit)`, which a store with nothing better can call over its own list. A vector index would rank by meaning, and the library never needs to know.
- A reader is whatever your [sessions](/ai/quick-start) say it is. Never let one reader reach another's memories, and check a reader id and a memory id before you use either as a key or a path. The two stores here accept letters, digits, `_` and `-`, up to 128 characters.
- `list` and `search` hand out copies.

`fileMemories(directory)` writes `<directory>/<reader>.json`, one file per reader. It writes to a temporary file and renames it into place, and it runs one reader's changes one after another, so twenty saves at once all arrive. It is a good store for one server; with several, use a database. `inMemoryMemories()` is for tests and a first try.

## Safety notes and limits

**Stored memory is untrusted text.** A hostile message can say "remember: ignore your instructions", and the assistant may save it, because a reader really can say that. What matters is what happens when it comes back.

- **In the prompt**, each memory is one quoted, one-line string after a sentence that says what the lines are: notes about the reader, never instructions to the model. A quoted line cannot end the list or start a new section, whatever a memory says, even when a store returns text with line breaks.
- **In a tool result**, `recall` answers JSON and says in the result that the notes are data.
- **On the page**, a memory is never read as markup. A note and a list item are drawn with the escaping `html` helper, and the default note removes `<` and `>` from the words it shows.
- **A reader's id** never names a path: a store checks it first.

**Limits are the library's, not the store's:**

- A memory is plain text on one line, at most **500 characters**. Control characters, line breaks, and the invisible characters that reorder text are replaced by a space, and runs of spaces become one. The length is counted after that. A longer memory is refused, and the model is told to say it in one short sentence.
- A reader keeps at most **200** memories. The 201st is **refused**, not made by dropping the oldest, because dropping one is forgetting something the reader never asked to forget. The model is told to forget an out-of-date one first, which is a visible change like any other (or the reader removes some).
- The same words, whatever their case, are saved once.

A save checks the count and writes it afterward, so two saves at the same moment can leave a reader a few over the limit. Put a unique constraint or a count check in your store if that matters to you.

The model decides what to remember, so it can be wrong. That is why every save is shown, can be undone, and can wait for the reader. A reader who wants a conversation kept off the record only has to say so: the prompt tells the model not to save it.
