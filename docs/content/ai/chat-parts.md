# Chat Parts

The chat is made of parts that you assemble: a thread, a message box, a sidebar, and smaller parts inside each. `<chat-app />` is all of them put together, so a project starts with one tag and takes over only what it needs to change. This page goes in that order: change one thing and keep the tag, then assemble the parts yourself, then the contract the parts share.

The [Quick Start](/ai/quick-start) builds the one-tag chat this page starts from. [Components](/ai/components#chat-and-voice-components) lists every part with its props and slots.

## Change what the chat says

The parts that read data take no props. They read one module of yours, `src/lib/chat.ts`, whose default export is a `ChatProject`. Only `chat` is required, and every other value changes something a part prints:

```ts
// src/lib/chat.ts
import { createChat, type ChatProject } from "@bascik/ai/app";

export const chat = createChat({
  // ...store, catalog, model, system
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
  words: {
    searchPlaceholder: "Search your chats",
    searchFound: (count) => `${count} chats`,
  },
} satisfies ChatProject;
```

| Value     | What it sets                                                                                                                                                                                                                                                                 | Without it                                             |
| :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------- |
| `chat`    | The chat `createChat` made. Required.                                                                                                                                                                                                                                        |                                                        |
| `welcome` | What an empty conversation shows: `heading`, `tagline`, `note` (text, or markup written with `html`) and `suggestions`, a list of `{ label, say }`. `false` prints no welcome.                                                                                               | The heading "How can I help?" and nothing under it.    |
| `models`  | The models a reader may pick from: `{ options, chosen, label, useLabel, notes }`, where `options` is a list of `{ id, name, group }`. It can be a function `(request, context)` that returns the menu, which is where a reader's own choice (a cookie, for example) is read. | `chat-models` prints nothing.                          |
| `routes`  | Where the parts that the data parts print post to: `open`, `model`, `forget` and `file`.                                                                                                                                                                                     | `/api/open`, `/api/model`, `/api/forget`, `/api/file`. |
| `words`   | The words the data parts print, for another language or your own voice. The table below lists them.                                                                                                                                                                          | English.                                               |
| `app`     | Posted as `app` by every form a data part prints. A site with one chat needs none.                                                                                                                                                                                           | No app is posted.                                      |
| `page`    | Where a search loads and where its Clear link leads, for a sidebar that is also on pages that are not the chat.                                                                                                                                                              | Both stay on the page the part is on.                  |
| `host`    | The host's context for the request (`waitUntil` on Cloudflare Workers), handed to `chat.thread`.                                                                                                                                                                             | None is passed.                                        |

The default export can also be a function `(request, context) => ChatProject`, or one that returns a promise of it, for a site with several chats or a platform that hands the chat its bindings on each request.

A request-time script receives no props, which is why these are module values and not attributes on a tag. The values reach only what the data parts print. A part you write in a page takes its own props: see [Replace the sidebar or the message box](#replace-the-sidebar-or-the-message-box).

The words, each with its default:

| Word                 | Default                                  | Where it shows                                       |
| :------------------- | :--------------------------------------- | :--------------------------------------------------- |
| `conversations`      | "Conversations"                          | The conversation list's name for a screen reader.    |
| `search`             | "Search conversations"                   | The search box's name for a screen reader.           |
| `searchPlaceholder`  | "Search conversations"                   | The search box's placeholder.                        |
| `searchGo`           | "Search"                                 | The search button.                                   |
| `searchClear`        | "Clear"                                  | The link that ends a search.                         |
| `searchTooShort`     | "Type at least 2 characters."            | Said of a search too short to run.                   |
| `searchEmpty(query)` | "No conversation mentions" and the words | Said when nothing matched.                           |
| `searchFound(count)` | "3 found"                                | Said above the results.                              |
| `earlier(count)`     | "Show 12 earlier messages"               | The link to messages older than the 40 a page shows. |

The model picker's two labels are `label` and `useLabel` in `models`. The memory list's words cannot be set from the module: print `memory-list` from a script of your own, as [Memory](/ai/memory#what-the-reader-sees-and-controls) shows.

### Offer a choice of model

`chat-models` is in the default sidebar's foot and prints nothing until the module lists `models`. Once it does, the picker posts the chosen id as `model` to `/api/model`, a route of your own that stores the choice and sends the reader back. The server kit has no handler for it, because where a choice is kept is yours to decide:

```ts
// In src/lib/chat.ts, inside the default export
models: (request: Request) => ({
  options: [
    { id: "claude-sonnet-5-5", name: "Sonnet", group: "Claude" },
    { id: "claude-haiku-5-5", name: "Haiku", group: "Claude" },
  ],
  chosen: chosenModel(request), // your own function: reads the reader's cookie
  notes: ["Your choice applies to new replies."],
}),
```

## Replace the sidebar or the message box

`chat-app` has no props. Each part inside it keeps its own defaults, and to set a part's props you put that part in its slot. It has two named slots, and each replaces a whole part:

| Slot       | Without it                                                                                               | Fill it for                                                                              |
| :--------- | :------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| `sidebar`  | `chat-sidebar` holding `chat-new`, `chat-find` and `chat-conversations`, with `chat-models` in its foot. | Your own links, a foot of your own, other labels, or no sidebar at all.                  |
| `composer` | `chat-composer` with `chat-attach`, taking the keyboard when the page opens.                             | Voice parts, other props, other attachment limits, or a message box that takes no files. |

A named slot is always filled with a wrapper element, `<template data-bascik-slot="...">` or a `<span>`. This page adds the voice parts to the message box and keeps everything else:

```html
<chat-app>
  <template data-bascik-slot="composer">
    <chat-composer
      data-bascik-prop-autofocus="autofocus"
      enctype="multipart/form-data"
    >
      <span data-bascik-slot="start"><chat-attach /></span>
      <chat-voice />
      <voice-call />
    </chat-composer>
  </template>
</chat-app>
```

The replacement is the whole part, so it repeats what the default had and you still want: here the `autofocus` prop, the `enctype` attribute and `chat-attach`. `chat-voice` needs nothing else. `voice-call` needs a voice provider in `createChat` and its three routes first, or its button answers "The voice service did not answer.": see [Voice](/ai/voice#a-call-with-a-speech-model). A message box for a chat that takes no files is shorter, `<chat-composer />` alone in the wrapper.

A sidebar of your own is a `chat-sidebar` with the parts you want, in the order they should show:

```html
<chat-app>
  <template data-bascik-slot="sidebar">
    <chat-sidebar data-show-found="true" data-bascik-prop-menu-label="Chats">
      <chat-new data-bascik-prop-label="New conversation" />
      <chat-find />
      <chat-conversations />
      <template data-bascik-slot="foot">
        <chat-models />
        <a href="/memory">Memory</a>
      </template>
    </chat-sidebar>
  </template>
</chat-app>
```

Keep `data-show-found="true"` on a `chat-sidebar` that holds `chat-find`: see [Narrow screens](#narrow-screens). The frame gives the sidebar its column when the slot holds an element marked `data-chat-part="sidebar"`, which `chat-sidebar` is, so a component of your own whose root is a `chat-sidebar` works too. An empty wrapper, `<template data-bascik-slot="sidebar"></template>`, leaves the chat with no sidebar at the full width.

> **A site with several chats.** The `chat-new` and `chat-composer` that `chat-app` writes post no `app`, whatever the project module's `app` says, because only the data parts read the module. Fill both slots with parts that carry `data-bascik-prop-app`.

## Put something above the conversation

The default slot of `chat-app` goes at the top of the conversation, before the turns. It takes a notice, or a welcome written as markup:

```html
<chat-app>
  <chat-welcome
    data-bascik-prop-heading="What are you reading next?"
    data-bascik-prop-tagline="Ask for a book, or start with one of these."
  >
    <ask-button data-bascik-prop-say="Recommend a book"
      >Recommend a book</ask-button
    >
  </chat-welcome>
</chat-app>
```

In a page, `ask-button`'s message is the prop `data-bascik-prop-say`; the plain `say` attribute is only for text a model writes. Set `welcome: false` in the project module when you write your own, or the page shows two. `chat-welcome` hides itself once the thread holds a reader's turn.

## What the one tag cannot do

`chat-app` can replace a whole part and cannot add to one. There is no "add a link to the sidebar's foot" slot and no "add a button to the message box" slot, because Bascik does not pass a named slot through a template into a part inside it. To add to a part, replace it, as the two examples above do.

Three more limits follow from how the parts are built:

- **A component's own tag cannot carry the slot name.** `<chat-attach data-bascik-slot="start" />` does not land in the `start` slot, and nothing is reported. Wrap it: `<span data-bascik-slot="start"><chat-attach /></span>`.
- **A form cannot go inside the message box.** `chat-composer` is a form and HTML does not nest forms, so `model-picker` and `chat-models` never go in one of its slots. They go in the sidebar, usually its foot.
- **A page that is not a chat cannot use it.** `chat-app` has no slot for its main column. A memory page with the same sidebar uses the parts directly: see [A page that is not a chat](#a-page-that-is-not-a-chat).

## Assemble the parts yourself

When the layout itself has to change, copy the template of `src/components/chat/chat-app.html` into your page and change it. The file is nothing but the other parts, with a comment at each region saying what to change there. This is its markup:

```html
<div class="app" data-chat>
  <chat-sidebar data-show-found="true">
    <chat-new />
    <chat-find />
    <chat-conversations />
    <template data-bascik-slot="foot"><chat-models /></template>
  </chat-sidebar>
  <main class="main">
    <div class="dock">
      <chat-composer
        data-bascik-prop-autofocus="autofocus"
        enctype="multipart/form-data"
      >
        <span data-bascik-slot="start"><chat-attach /></span>
      </chat-composer>
    </div>
    <chat-enhance />
    <div class="scroller">
      <chat-thread>
        <chat-turns />
      </chat-thread>
    </div>
  </main>
</div>
```

Three things in it matter and are easy to lose:

- **The `data-chat` element holds every part.** It is how the parts find each other: see [The contract between parts](#the-contract-between-parts).
- **The message box comes before the thread in the source.** It is sent before the reply starts streaming, so the reader can use it at once, and CSS `order` shows it below the thread. Keep that order.
- **`chat-enhance` comes before the thread.** Remove it and every form is a page load, and everything still works.

The frame's styles are in the same file: a grid with a 16rem column for the sidebar, one column and two rows at 720px and under, a flex column for `main`, and a `column-reverse` scroller that stays pinned to the newest text with no script. Copy the `<style>` block with the markup, as a component of your own or into your page's stylesheet, and keep its class names on the elements above.

The parts fall into groups, and a page uses as many as it needs:

| Group       | Parts                                                                                                                  | What they are                                                                                |
| :---------- | :--------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| Frame       | `chat-app`, `chat-thread`, `chat-sidebar`, `chat-enhance`                                                              | Layout and the client runtime. No data.                                                      |
| Data        | `chat-turns`, `chat-conversations`, `chat-find`, `chat-models`, `chat-memories`                                        | Each reads the project module on every request and prints a layout part. No props, no slots. |
| Message box | `chat-composer`, `chat-attach`, `chat-voice`, `voice-call`                                                             | The form, and what goes in its slots.                                                        |
| Sidebar     | `chat-new`, `chat-search`, `search-results`, `search-result`, `conversation-list`, `conversation-item`, `model-picker` | Forms and lists, each a page load that works with no JavaScript.                             |
| Memory      | `memory-list`, `memory-item`, `memory-note`                                                                            | What the assistant remembers, and the line a reply shows when it saves something.            |
| Turns       | `chat-welcome`, `chat-attachment`, `tool-approval`, `tool-status`                                                      | What a script prints inside the thread.                                                      |

A data part works alone and prints its own layout part, so `<chat-conversations />` in any column is the whole list, and a part with nothing to show leaves nothing behind. When you want other markup than a data part prints, write the layout part yourself from a server script, in a component of your own that takes the data part's place. This one is `chat-conversations` written out: `chat.session(request)` is the reader's session, `chat.list(session)` is their conversations, and a conversation with no message yet is left out.

```html
<!-- src/components/my-conversations.html -->
<script data-bascik-server type="text/typescript">
  import { html } from "@bascik/bascik/html";
  import { chat } from "@/lib/chat.ts";

  export default async (request: Request) => {
    const session = chat.session(request);
    const conversations = await chat.list(session);
    return html`<conversation-list>
      ${conversations
        .filter((conversation) => conversation.messages.length > 0)
        .map(
          (conversation) =>
            html`<conversation-item
              data-bascik-prop-conversation="${conversation.id}"
              data-bascik-prop-title="${conversation.title}"
              data-bascik-prop-current="${conversation.id ===
              session.conversationId
                ? "true"
                : "false"}"
            ></conversation-item>`,
        )}
    </conversation-list>`;
  };
</script>
```

The package's own version is the `conversationList` function: see [Functions for page scripts](/ai/server-kit#functions-for-page-scripts).

### A page that is not a chat

A memory page has the sidebar and no conversation. It uses the parts directly, in a frame of its own:

```html
<body>
  <chat-sidebar data-show-found="true">
    <chat-new />
    <chat-find />
    <chat-conversations />
  </chat-sidebar>
  <main class="page">
    <chat-memories />
  </main>
</body>
```

```css
body:has(> aside) {
  display: grid;
  grid-template-columns: 16rem minmax(0, 1fr);
  min-block-size: 100dvh;
}

@media (max-width: 720px) {
  body:has(> aside) {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
}

.page {
  max-inline-size: 46rem;
  margin-inline: auto;
  padding: 1rem;
}
```

`chat-sidebar`'s root is an `aside`. The grid needs the height: without `min-block-size` the sidebar is only as tall as the page's content. On a page like this one, set `page` in the project module to the chat's path, so that a search from the sidebar loads the chat and not the memory page.

When the sidebar needs something only a request knows, such as which link is the current page, make it a component of your own whose server script prints `<chat-sidebar>` around the data parts. The repository's demo does this in `ai/demo/src/components/site-menu.html`, and uses it in `chat-app`'s `sidebar` slot and on its memory page.

## The contract between parts

The parts know nothing about each other's markup. They share a few attributes and events, which is all a part of your own has to follow to work with the rest.

### The root

One element marked `data-chat` holds the thread and the message box, and usually the sidebar. Every script finds the other parts from its nearest `data-chat` element, so two chats on one page stay apart. `chat-app`'s root is that element. A page with no `data-chat` element still works: the parts then find each other by their test ids, across the whole page, and the client runtime takes the forms inside `<main>`.

### Named parts

A script looks a part up by its `data-chat-part` value, and `chat-thread` styles its content by the same marks. The package's parts carry them already; your own markup carries them when it stands in for one.

| `data-chat-part` | On                                                                    | Who reads it                                                                                |
| :--------------- | :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| `thread`         | The element that holds the turns.                                     | The client runtime replaces it with the answer's; `voice-call` adds turns to it.            |
| `turn`           | Each turn, with `data-role="user"` or `data-role="assistant"`.        | `chat-thread`'s styles, and `chat-voice`.                                                   |
| `writing`        | The empty marker a live reply starts with.                            | `chat-thread` shows the reply and its caret from it.                                        |
| `done`           | The empty marker that ends a reply.                                   | `chat-thread` removes the caret; `chat-voice` stops reading there.                          |
| `ready`          | The empty element that ends the stored conversation.                  | The client runtime: the answer's thread is shown once it holds this marker.                 |
| `welcome`        | `chat-welcome`'s root.                                                | `chat-welcome`'s own style hides it once the element marked `thread` holds a reader's turn. |
| `files`          | The list of a message's attachments.                                  | `chat-thread`'s styles.                                                                     |
| `earlier`        | The link to older messages.                                           | `chat-thread`'s styles.                                                                     |
| `failed`         | The line that says a reply failed.                                    | `chat-thread`'s styles.                                                                     |
| `composer`       | The message form.                                                     | The client runtime empties it after a send; `voice-call` takes it during a call.            |
| `input`          | The message box inside it.                                            | `chat-attach` (paste), `chat-voice` (dictation), `voice-call`.                              |
| `send`           | The Send button.                                                      | Nothing in the package reads it; it is there for your own scripts and styles.               |
| `stop`           | The Stop button.                                                      | The client runtime takes its click and posts to its `formaction`.                           |
| `notice`         | The line that says why a file was refused. `chat-attach` provides it. | The client runtime writes the server's reason there.                                        |
| `sidebar`        | `chat-sidebar`'s root.                                                | `chat-app` gives it a column; the client runtime replaces it after each answer.             |
| `found`          | `search-results`' root.                                               | `conversation-list` hides beside it; `chat-sidebar` shows itself for it.                    |
| `view`           | What the voice view page shows.                                       | `voice-call` reads it.                                                                      |

The reply being written also carries `data-live`. The ready marker carries `id="thread-ready"` with `data-bascik-preserve="id"`, which is what the page's `rel="expect"` link names.

### Lines in the message box

`chat-composer` is one row: what is in `start`, the message box, what is in the default slot, then Send. A part placed in one slot often needs a second element on a line of its own: `chat-attach` sits before the message box and shows its chips above it. The part marks that element `data-chat-line`, and the composer lays it out as a full line:

| `data-chat-line` | Where the line goes                           | Used by                                                        |
| :--------------- | :-------------------------------------------- | :------------------------------------------------------------- |
| `top`            | The first line of all.                        | `chat-voice`'s caption.                                        |
| `above`          | Above the message box.                        | `chat-attach`'s chips and refusal, `voice-call`'s status line. |
| `near`           | The last line above, next to the message box. | `chat-voice`'s controls.                                       |
| `below`          | Under the message box.                        | The composer's own `below` slot.                               |

Lines of the same kind stack in source order. The marked element must be a child of the part's root, and that root must have no box (`display: contents`), so the line becomes the composer's own child for layout. A line that comes and goes carries the `hidden` attribute while it has nothing to say, and then takes no room.

### State

| Attribute                            | Where it is written                                            | Meaning                                                                    |
| :----------------------------------- | :------------------------------------------------------------- | :------------------------------------------------------------------------- |
| `data-genui="idle"` or `"streaming"` | By `chat-enhance`, on the `data-chat` element and on `<html>`. | Whether this chat's reply is arriving. `chat-composer` shows Stop from it. |
| `data-pending`                       | By `chat-enhance`, on a form.                                  | Its request is on its way.                                                 |
| `data-genui-call="on"`               | By `voice-call`, on the `data-chat` element and on `<html>`.   | A voice call is on. `chat-voice` steps aside.                              |
| `data-live`                          | On the turn being written.                                     | `chat-thread` draws its caret until the `done` marker.                     |
| `aria-busy="true"`                   | By `chat-enhance`, on the placeholder turn.                    | The message was sent and no part of the answer has arrived.                |
| `data-dragging`                      | By `chat-attach`, on the form.                                 | Files are being dragged over it.                                           |

Style on the `data-chat` element's copy, so two chats on a page do not share a state. The copy on `<html>` is for a page with no `data-chat` element.

### Events

Six events bubble from the `data-chat` element, or from `document` on a page with none. With `chat-app` they bubble from its root.

| Event              | When                                | `detail`                                   |
| :----------------- | :---------------------------------- | :----------------------------------------- |
| `chat:send`        | The client runtime takes a form.    | `{ form }`                                 |
| `chat:reply-start` | The answer's thread is in the page. | none                                       |
| `chat:stop`        | The reader presses Stop.            | none                                       |
| `chat:reply-end`   | The answer is over.                 | `{ stopped }`: true when Stop was pressed. |
| `chat:call-start`  | A voice call is on.                 | none                                       |
| `chat:call-end`    | A voice call ended.                 | none                                       |

`chat:reply-end` fires exactly once for every `chat:send`, also when the send failed, so a script that starts something on `chat:send` can always end it. A refused upload gives `chat:send` and then `chat:reply-end` with no `chat:reply-start` between them. A message typed during a voice call is said to the model and fires no `chat:send`.

```ts
const chat = document.querySelector<HTMLElement>("[data-chat]")!;

chat.addEventListener("chat:reply-end", (event) => {
  const { stopped } = (event as CustomEvent<{ stopped: boolean }>).detail;
  if (!stopped) document.title = "New reply";
});
```

The first four need `chat-enhance` on the page: without it a send is a page load and no event fires.

### A form that must load a page

Inside a `data-chat` element, `chat-enhance` takes every `method="post"` form: it sends the form with `fetch` and streams the answer into the thread. A form whose answer is another page (opening a conversation, choosing a model, forgetting a memory) must be left to the browser. Mark it:

```html
<form method="post" action="/api/shelf" data-genui="native">
  <button>Add to my shelf</button>
</form>
```

`chat-new`, `conversation-item`, `search-result`, `model-picker` and `memory-item` carry the attribute already. A `GET` form, such as the search box, is never taken.

### Routes are props

Every path a part posts to is a default. Each part that posts takes a `route` prop, and the parts with more than one name each: `stop-route` on `chat-composer`, and `session-route`, `tool-route`, `turn-route` and `view-route` on `voice-call`.

```html
<chat-composer
  data-bascik-prop-route="/shop/api/send"
  data-bascik-prop-stop-route="/shop/api/stop"
/>
```

The routes of what the data parts print are set in the project module, as `routes`. A route is a real URL attribute in the built page (`action`, `formaction` or `href`), so the site's [`base`](/configuration#base) applies to it.

Setting a route prop prints one line per use in the build output, "Attribute binding conflict … prop wins". That is the prop replacing the part's default, as meant, and it is not an error. The same line is printed for a few other props that replace a default attribute: `placeholder` and `label` on `chat-composer`, `types` on `chat-attach`, `label` on `conversation-list`, `placeholder` on `chat-search` and `clear` on `search-results`.

A value in the project module that replaces a default attribute does the same at request time: `words.searchPlaceholder`, `words.conversations`, `words.searchClear` or a `routes` entry. The build prints nothing for these. The dev server's log has the line each time the page is requested, marked "in server-script output", and it is equally harmless.

The catalog's forms that a model writes (`ask-button`, `choice-form`, `choice-pair`, `input-form` and `swipe-deck`) have no route prop and post to `/api/send`. A project with another send route edits the `action` in its copies of those files, or keeps `/api/send` as a second route file for the same handler.

### Custom properties

The parts read their colors from the page. Define these once, on `:root`:

| Property      | What it is                                                       |
| :------------ | :--------------------------------------------------------------- |
| `--bg`        | The page's background.                                           |
| `--surface`   | A raised surface: the sidebar, the message box, a reader's turn. |
| `--border`    | Borders and rules.                                               |
| `--text`      | Text.                                                            |
| `--muted`     | Secondary text.                                                  |
| `--accent`    | Buttons, focus outlines, links.                                  |
| `--on-accent` | Text on the accent color.                                        |
| `--radius`    | The corner radius.                                               |
| `--fg`        | The text color of a drawn diagram. Set it to `var(--text)`.      |

`--fg` has to come from the page. Bascik renames a custom property that a component declares, and a diagram's SVG is drawn by the server, outside any component, so `chat-thread` cannot declare it for you.

Four more are optional, and each part that reads one falls back to the value shown: `--gap` (`0.75rem`, the space between two parts of one reply), `--gap-tight` (`0.25rem`, between parts that belong together), `--text-small` (`0.875rem`) and `--text-smaller` (`0.8125rem`).

The parts need no CSS reset from the page. `chat-composer` sets `box-sizing: border-box` on its own form and message box, and `chat-app` with its default parts was tested with the page's reset removed. `chat-app` does expect a `<body>` with no margin and nothing else beside it, because it is as tall as the window.

## Style a part of your own

One rule of Bascik's explains how every part here is styled, and it is the rule to follow when you write your own: **Bascik renames the classes a component's stylesheet declares, in that component's own markup only.** Content that arrives another way never gets the renamed class:

- what a page puts in the component's slot,
- what a stream or server script prints,
- what another part's script builds in the browser.

So a rule such as `.thread .reply` in a thread component matches nothing when the reply is printed by a stream script: the stylesheet's `.reply` was renamed and the printed element's class was not. This is why the thread's styles used to live in the page's stylesheet.

The way through is to anchor every rule on the part's own class, which is renamed on both sides, and then select the content by attribute, or by element inside `:is()`:

```html
<!-- src/components/reading-list.html -->
<style>
  .list {
    display: grid;
    gap: var(--gap, 0.75rem);
  }
  /* Slotted and streamed content: found by attribute, under the part's class. */
  .list [data-book] {
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius);
    background: var(--surface);
  }
  .list [data-book] :is(cite) {
    font-weight: 600;
  }
</style>
<section class="list" data-testid="reading-list">
  <span data-bascik-slot></span>
</section>
```

```html
<reading-list>
  <p data-book><cite>Refactoring the Monolith</cite> by Grace Lin</p>
  <p data-book><cite>Practical Type Systems</cite> by Ada Okafor</p>
</reading-list>
```

`chat-thread` is written this way throughout: each rule starts at `.thread` and names a turn as `[data-chat-part="turn"]`. It wraps that attribute in `:where()`, which adds no specificity, so a catalog component's own rule for its own table or list still wins.

> **Two lint rules can misfire here.** On this branch, `css-attribute-selector` and `css-is-element-names` flag some selectors that are anchored on a class, when Prettier wraps the selector over several lines or when `:is(element)` follows `:where()`. The rule is still correct. `chat-thread` turns the two checks off for its style block with a `/* bascik-disable css-attribute-selector, css-is-element-names */` comment, and your part can do the same.

## Narrow screens

At 720px and under, `chat-sidebar` is a bar above the chat with one labeled control, "Menu" unless you set `menu-label`. Its content opens under the bar, up to three quarters of the window's height, and closes again. It is a `details` element, so it works with no JavaScript, and the message box stays on screen while it is open.

- A page load closes it. The client runtime keeps it open or closed as the reader had it when it replaces the sidebar after an answer.
- A page of search results should load with the results in view. A sidebar written in a page or a template carries the plain attribute `data-show-found="true"`: on a narrow screen it then shows whole, without its control, for as long as it holds a `search-results` part. `chat-app`'s default sidebar has it. A sidebar printed by a script can set the `open` prop per request in its place (`data-bascik-prop-open="open"`). Use one or the other.
- To leave `open` off, leave the prop off the tag. An empty value still opens it.

On a wide screen the sidebar is a column that always shows its content, which CSS does by forcing the `details` open with the `::details-content` pseudo-element. A browser without `::details-content` (before 2025) cannot show a closed `details`, so there the wide screen keeps the control too: the sidebar starts closed and opens with a press.

The New chat button, the search box and its button, each conversation, each search result, the Clear link and the model picker get a 44px target on a touch screen (`pointer: coarse`), and the sidebar's own control always has one.

## If you copied the parts earlier

`@bascik/ai` is unreleased, so there is no migration guide. A page written against the parts before they were split needs these changes:

- **File props moved to `chat-attach`.** `chat-composer` no longer takes `enctype`, `max-bytes`, `max-files`, `max-total` or `types` as props and has no Attach control of its own. Write `enctype="multipart/form-data"` as a plain attribute on the tag, and put `chat-attach` in its `start` slot with the limits as its props: see [Attachments](/ai/attachments#the-smallest-setup).
- **The message box does not take the keyboard by itself.** Add `data-bascik-prop-autofocus="autofocus"` to the one composer of a page that should.
- **The thread, the sidebar and the welcome are package parts.** The demo's own `chat-thread`, `chat-sidebar`, `chat-turns` and `chat-menu` components are gone. A project that copied one has a name clash with the package's part: delete the copy and provide `src/lib/chat.ts` with a default export, or rename your own.
- **`@/lib/chat.ts` has a meaning.** The data parts read the project from it. Its default export, `{ chat }`, is the convention, and it is what carries `welcome`, `words`, `models` and `routes`. A module with only a named `chat` export still loads, with every default. A default export that is something else fails with the message in [Troubleshooting](/ai/troubleshooting#chat-parts).
- **Styles moved out of the page stylesheet into the parts.** A stylesheet copied from the demo can drop its thread, turn, welcome, Stop button, dock, scroller and body grid rules. Keep the tokens, add `--fg: var(--text)`, and do not make `<body>` a two-column grid on a page that uses `chat-app`.
- **The root moved.** With `chat-app` the `data-chat` element is its own `div`, and the sidebar is inside it. A selector such as `main[data-chat]` no longer matches.
- **Routes are props.** A part whose `action` you edited takes a `route` prop now.
- **`memory-list` has no width of its own.** Wrap it in a column: see [Memory](/ai/memory#what-the-reader-sees-and-controls).
- **Forget is a page load.** `memory-item`'s form carries `data-genui="native"`, as `search-result`'s does, so the client runtime never streams it.
