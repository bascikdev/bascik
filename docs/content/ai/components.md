# Components

The `@bascik/ai` package ships two sets of components: generative UI components that a model may write, and the chat and voice parts that you place in your pages, from single controls up to `chat-app`, the whole chat in one tag. You copy them into your project with `npx bascik add @bascik/ai`. They are yours to edit after that.

## Generative UI components

These are the catalog, the tags a model may write.

### ask-button

A suggested next message.
Props: `say` (the full message the reader sends by pressing it).
Content: the short button label.

```html
<ask-button say="Tell me more about Dune">More about Dune</ask-button>
```

### bar-chart

A horizontal bar chart for comparing a few numbers.
Props: `title` (the chart title).
Content: one bar-row inside per item.

```html
<bar-chart title="Pages by Book">
  <bar-row label="Dune" value="412" max="500" />
  <bar-row label="Neuromancer" value="271" max="500" />
</bar-chart>
```

### bar-row

One bar inside a bar-chart.
Props: `label` (the item name), `value` (the numeric value), `max` (the largest value in the chart).
Content: None.

```html
<bar-row label="Dune" value="412" max="500" />
```

### card-grid

A responsive grid.
Props: None.
Content: two or more book-card or stat-tile components.

```html
<card-grid>
  <stat-tile label="Rating" value="4.8">Dune</stat-tile>
  <stat-tile label="Pages" value="412">Dune</stat-tile>
</card-grid>
```

### choice-form

A single-choice question.
Props: `question` (the question text).
Content: two to five choice-option components.

```html
<choice-form question="Which genre?">
  <choice-option value="Sci-Fi">Sci-Fi</choice-option>
  <choice-option value="Fantasy">Fantasy</choice-option>
</choice-form>
```

### choice-option

One answer inside a choice-form.
Props: `value` (the message sent when picked).
Content: what the reader sees.

```html
<choice-option value="Sci-Fi">Sci-Fi</choice-option>
```

### data-table

A table the reader can sort and filter.
Props: `caption` (a short title).
Content: exactly one table element.

```html
<data-table caption="Books">
  <table>
    <thead>
      <tr>
        <th>Title</th>
        <th>Author</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Dune</td>
        <td>Frank Herbert</td>
      </tr>
    </tbody>
  </table>
</data-table>
```

### input-form

A short form the reader fills in.
Props: `title` (the form title), `submit` (the submit button label).
Content: one text-field inside per value needed.

```html
<input-form title="Book Details" submit="Save">
  <text-field label="Title" name="title" />
  <text-field label="Author" name="author" />
</input-form>
```

### note-box

A boxed note for a warning, a limit, or a caveat.
Props: `title` (the note title).
Content: the note text.

```html
<note-box title="Warning">This book is out of print.</note-box>
```

### stat-tile

One headline number with a short label.
Props: `label` (the label), `value` (the number).
Content: a few words of context under the number.

```html
<stat-tile label="Rating" value="4.8">Dune</stat-tile>
```

### step-item

One step inside a step-list.
Props: `title` (the step title).
Content: a sentence or two of detail.

```html
<step-item title="Find the book">Search the catalog.</step-item>
```

### step-list

A numbered procedure.
Props: None.
Content: one step-item inside per step.

```html
<step-list>
  <step-item title="Find the book">Search the catalog.</step-item>
  <step-item title="Add to list">Click Add.</step-item>
</step-list>
```

### swipe-card

One card inside a swipe-deck.
Props: `title` (the item's name, unique within the deck).
Content: a sentence or two about the item.

```html
<swipe-card title="Dune"
  >A desert planet and the spice everyone wants.</swipe-card
>
```

### swipe-deck

A stack of cards the reader judges one at a time: swipe or drag right for yes and left for no, press one of two buttons, or use the arrow keys from the buttons.
Props: `question` (shown above the stack), `yes` (the right button's label, default "Yes"), `no` (the left button's label, default "No"), `hint` (replaces the line under the question that explains the gesture), `radios` (`show` to also show the two choices as radio buttons on each card).
Content: two to twelve swipe-card components.

```html
<swipe-deck question="Keep or skip?" yes="Keep" no="Skip">
  <swipe-card title="Dune"
    >A desert planet and the spice everyone wants.</swipe-card
  >
  <swipe-card title="Neuromancer"
    >A burned-out hacker takes one last job.</swipe-card
  >
</swipe-deck>
```

With scripts on, a line under the question says how to answer, written from the two labels: "Swipe or drag right for Keep, left for Skip. The arrow keys work from the buttons." A label with the answer rides on the card while it is dragged and is solid once letting go would give that answer, and the first deck on a page moves its top card aside once to show it can be dragged, unless the reader prefers reduced motion.

Each card's two radio buttons are the deck with scripts off, where it is a plain list of yes/no choices. With scripts on they are hidden, because the buttons answer; `radios="show"` shows them, with the deck's labels.

When every card is answered, the deck sends one "Title: yes" or "Title: no" line per card as the reader's message. The thread shows one line in its place, in the deck's labels, such as "Keep: Dune. Skip: Neuromancer." (see [What the thread shows for a form](/ai/server-kit#what-the-thread-shows-for-a-form)). Do not title a card `text`, `app`, `voice`, or `show`: those names are the form's own, and the deck sends such a card as "show (item)".

### text-field

One text input inside an input-form.
Props: `label` (the label the reader sees), `name` (the name its value is sent under).
Content: None.

```html
<text-field label="Title" name="title" />
```

### tool-note

A status line that says what the assistant is looking up.
Props: None.
Content: the status text.

```html
<tool-note>Looking up Dune...</tool-note>
```

## Chat and voice components

You place these in your pages. They are the parts of the chat: `chat-app` is all of them in one tag, and each one also works alone. [Chat Parts](/ai/chat-parts) explains how to change the one tag, how to assemble the parts yourself, and the contract they share. This section is the reference: what each part is, its props with their defaults, its slots, and what it needs around it.

Every part's file starts with an `@bascik` comment that says the same, so the reference is also in your project after `bascik add`.

> **Install esbuild.** `chat-enhance`, `chat-attach`, `chat-voice` and `voice-call` keep their logic in TypeScript modules beside them (`chat/chat-root/`, `chat/chat-attach/`, `chat/chat-voice/` and `chat/voice-call/`), which Bascik bundles into each component's script at build time with esbuild. `chat-app` holds the first two. Install it in the project that builds them: `npm install --save-dev esbuild`. Without it, a build that uses one of these components fails naming the component's script. See [Importing TypeScript Modules](/scoped-javascript#importing-typescript-modules).

Three rules hold for every part:

- **Props are written `data-bascik-prop-<name>="value"`.** Any other attribute on the tag lands on the part's root element.
- **A named slot is filled with a wrapper element**, `<template data-bascik-slot="foot">…</template>` or `<span data-bascik-slot="start">…</span>`. The slot name on a component's own tag, as in `<chat-attach data-bascik-slot="start" />`, does not work and reports nothing.
- **A prop that replaces a default attribute prints one build line**, "Attribute binding conflict … prop wins". That is the prop winning, as meant. Each part below says which of its props do.

## Frame and layout parts

### chat-app

The whole chat in one tag: the sidebar, the message box and the conversation, laid out to fill the window. Its template is the other parts with their defaults, and it has no script and no data of its own.

Props: none. To set a part's props, put that part in its slot.

Slots:

- `sidebar`: the whole sidebar. Without it, `chat-sidebar` holding `chat-new`, `chat-find` and `chat-conversations`, with `chat-models` in its foot. An empty wrapper leaves the chat with no sidebar, at the full width.
- `composer`: the whole message box. Without it, `chat-composer` with `chat-attach`, taking the keyboard when the page opens.
- the default slot: what goes at the top of the conversation, before the turns.

Needs: to be the only thing in a `<body>` with no margin; `<link rel="expect" href="#thread-ready" blocking="render" />` in the page's head; the theme tokens; the project module `src/lib/chat.ts`; and the routes `/api/send`, `/api/stop`, `/api/open` and `/api/file`, with a `files` store in `createChat` for attachments. Its root is the chat's `data-chat` element.

Test ids: `chat-app` (the root) and `chat-app-main` (the column that holds the message box and the thread).

```html
<chat-app />
```

### chat-thread

The conversation: a column of turns, and every style for what is in one. A layout part with no script and no data.

Props: none.

Slot: the default slot is the turns. Put `chat-turns` there, or a component of your own with a stream script, or turns written by hand.

Needs: a `data-chat` element that also holds the message box. It styles its content by attribute, so the turns must carry the marks listed under [Named parts](/ai/chat-parts#named-parts), whoever writes them. It fills the width it is given up to 46rem, and a reply's prose up to 42rem. A drawn diagram reads `--bg` and `--fg` from the page.

```html
<chat-thread>
  <chat-turns />
</chat-thread>
```

### chat-sidebar

The sidebar's layout: a column for whatever a page puts beside the chat, with a foot that stays at the bottom. No data and no script. At 720px and under it is a bar above the chat whose content opens and closes; see [Narrow screens](/ai/chat-parts#narrow-screens).

Props: `menu-label` (the text of the narrow-screen control; "Menu") and `open` (write `data-bascik-prop-open="open"` to load with the content showing on a narrow screen; leave the prop off to leave it closed).

Attribute: `data-show-found="true"`, for a sidebar written in a page or a template that holds `chat-find`. On a narrow screen it shows whole while it holds search results. Use it or `open`, not both.

Slots: the default slot is the sections, top to bottom; `foot` is what stays at the bottom, under a rule, and takes no room when unfilled.

Needs: a page that gives it a column on a wide screen and a row above the chat on a narrow one. `chat-app` does this. For a body that is a grid: `grid-template-columns: 16rem minmax(0, 1fr)`, and at `max-width: 720px` one column with `grid-template-rows: auto minmax(0, 1fr)`. It can sit inside or beside the `data-chat` element.

Test ids: `chat-sidebar` (the root, an `aside`), `chat-sidebar-toggle` (the narrow-screen control) and `chat-sidebar-foot`.

### chat-enhance

The optional client runtime. Without it every form in the chat is a page load, and everything works. Put it in the page before the thread. See [Client Runtime](/ai/client-runtime).

Props: none. Slots: none. It has no element of its own.

## Data parts

A data part reads the project module, `src/lib/chat.ts`, on every request and prints a layout part filled in. Each has no props, no slots, no styles and no element of its own, works alone, and needs no other data part. What it would take as props comes from the module: see [Change what the chat says](/ai/chat-parts#change-what-the-chat-says). A project whose chat lives in another file changes the import line in its copy of the part.

| Part                 | Prints                                                                                                | Reads from the module                                     |
| :------------------- | :---------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| `chat-turns`         | The stored turns, or `chat-welcome` when there are none; the ready marker; the reply being written.   | `chat`, `welcome`, `routes.file`, `words.earlier`, `host` |
| `chat-conversations` | `conversation-list` with one `conversation-item` each, the open one marked.                           | `chat`, `app`, `routes.open`, `words.conversations`       |
| `chat-find`          | `chat-search`, and on a page whose address has `?q=`, `search-results` with one `search-result` each. | `chat`, `page`, `app`, `routes.open`, the search `words`  |
| `chat-models`        | `model-picker` with the model in use selected. Nothing when the project lists no models.              | `models`, `app`, `routes.model`                           |
| `chat-memories`      | `memory-list` with one `memory-item` each, newest first.                                              | `chat` (one made with `memory`), `app`, `routes.forget`   |

`chat-turns` goes in `chat-thread`'s default slot. A page shows the last 40 messages, with a link to the rest. It prints `chat-welcome`, `ask-button` and `chat-attachment` tags, so the project needs those components.

`chat-conversations` prints the same list on every address and leaves out a conversation with no message yet. Beside `chat-find`'s results the list is hidden, so the results stand where it was.

`chat-models` and `model-picker` are forms, so they go anywhere that is not a form: usually `chat-sidebar`'s foot, and never a slot of `chat-composer`.

`chat-memories` needs a page column that sets its width.

Each part's script is one call to a function from `@bascik/ai/app`, which you can call from a script of your own: see [Functions for page scripts](/ai/server-kit#functions-for-page-scripts).

## Message box parts

### chat-composer

The message box: a form with a textarea and a Send button, so sending works with no JavaScript. With scripts on, Enter sends and Shift+Enter adds a line. With the client runtime, a Stop button takes Send's place while this chat's reply streams. It holds no attachments, no voice and no model picker: those are parts a page puts in its slots.

| Prop          | Default           | What it sets                                                                                                              |
| :------------ | :---------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `app`         | none              | Sent with every message as the `app` field.                                                                               |
| `route`       | `/api/send`       | Where the form posts.                                                                                                     |
| `stop-route`  | `/api/stop`       | Where Stop posts.                                                                                                         |
| `placeholder` | "Ask a question…" | The message box's placeholder.                                                                                            |
| `label`       | "Message"         | The message box's name for a screen reader.                                                                               |
| `send-label`  | "Send"            | The Send button's text.                                                                                                   |
| `stop-label`  | "Stop"            | The Stop button's text.                                                                                                   |
| `autofocus`   | off               | Write `data-bascik-prop-autofocus="autofocus"` on the one composer of a page that takes the keyboard when the page opens. |

Setting `route`, `stop-route`, `placeholder` or `label` prints the build line. For a form that sends files, write `enctype="multipart/form-data"` on the tag: it is an attribute, not a prop, and lands on the form.

| Slot    | Where it is                       | What goes there                                                          |
| :------ | :-------------------------------- | :----------------------------------------------------------------------- |
| `above` | A line above the message box.     | A status or a note.                                                      |
| `start` | Before the message box.           | `chat-attach`.                                                           |
| default | Between the message box and Send. | `chat-voice` and `voice-call`.                                           |
| `below` | A row under the message box.      | A note, or a control sent with the message. Never a part that is a form. |

An unfilled slot takes no room, and `above` and `below` take none while every element in them has the `hidden` attribute. A part in any slot can put a line of its own above or below the message box with `data-chat-line`: see [Lines in the message box](/ai/chat-parts#lines-in-the-message-box).

Needs: a `data-chat` element that also holds the thread. Stop shows while that element has `data-genui="streaming"`.

Test ids: `chat-composer` (the form), `chat-composer-input`, `chat-composer-send` and `chat-composer-stop`.

```html
<chat-composer enctype="multipart/form-data">
  <span data-bascik-slot="start"><chat-attach /></span>
  <chat-voice />
</chat-composer>
```

### chat-attach

Attachments for a message box: an Attach control, the chosen files as removable chips, and a line that says why a file was refused. The control is a label for a file input named `files`, so with scripts off the form still sends what the reader picked. With scripts on, files can be pasted or dropped, each is checked against the limits before it is added, and an image shows a preview. See [Attachments](/ai/attachments).

| Prop        | Default                                              | What it sets                                                                    |
| :---------- | :--------------------------------------------------- | :------------------------------------------------------------------------------ |
| `max-bytes` | 5 MB                                                 | The largest one file may be, in bytes.                                          |
| `max-files` | 4                                                    | How many files one message may carry.                                           |
| `max-total` | 10 MB                                                | The files of one message together, in bytes.                                    |
| `types`     | PNG, JPEG, WebP, GIF, PDF, plain text, Markdown, CSV | Comma-separated media types. The file picker offers these with scripts off too. |
| `label`     | "Attach files"                                       | The control's name.                                                             |

Setting `types` prints the build line. The defaults are the server kit's own, and the server checks every file again whatever is set here.

Slots: none.

Needs: a `<form method="post">` around it, sent as `multipart/form-data`. In `chat-composer` it goes in the `start` slot, inside a wrapper element, with `enctype="multipart/form-data"` on the composer's tag. With scripts on it sets the `enctype` when it is missing; with scripts off and no `enctype`, only file names are sent.

Test ids: `chat-attach` (the root), `chat-composer-attach` (the control), `chat-composer-files` (the chips), `chat-composer-file` and `chat-composer-file-remove` (one chip and its button), and `chat-composer-notice` (the refusal line).

### chat-voice

Reading aids for a chat: captions each reply a few words at a time, can read it aloud with the browser's own voice, and can listen for the next message. All script: with scripts off it shows nothing. See [Voice & Captions](/ai/voice).

Props: none. Slots: none.

Needs: the same `data-chat` element as the thread and the message box. In `chat-composer`'s default slot its button joins the row before Send, its caption is the first line above the message box, and its controls are the line next to the message box. Beside the composer it is laid out by whatever holds it.

Modules: `chat-voice/` (settings, sentences, captions).

### voice-call

A spoken conversation with a speech-to-speech model. All script: with scripts off it shows nothing. See [A call with a speech model](/ai/voice#a-call-with-a-speech-model).

| Prop                   | Default              | What it sets                                                                              |
| :--------------------- | :------------------- | :---------------------------------------------------------------------------------------- |
| `app`                  | none                 | Sent to every route as the `app` field.                                                   |
| `idle-seconds`         | `120`                | How long nobody may speak before the call asks "Still there?". `0` never asks.            |
| `idle-warning-seconds` | `30`                 | How long the reader then has to answer before the call ends.                              |
| `session-route`        | `/api/voice-session` | Answers a ticket for a call.                                                              |
| `tool-route`           | `/api/voice-tool`    | Runs a tool call the model makes.                                                         |
| `turn-route`           | `/api/voice-turn`    | Stores what was said.                                                                     |
| `view-route`           | `/voice-view`        | The page that renders what a tool call shows, fetched with `app` and `call` in its query. |

Setting a route prints the build line. The four routes are carried by hidden, empty links marked `rel="nofollow"`, so the site's `base` applies to them. They are not navigation: a link checker run over the built pages should skip them.

Slots: none.

Needs: the same `data-chat` element as the thread and the message box. In `chat-composer`'s default slot its buttons join the row before Send, and its status line is a line above the message box.

Modules: `voice-call/` (one per protocol, `gemini-live.ts` and `azure-voice-live.ts`, plus audio, captions, forms, idle, microphone, reader, tools, requests, status and types).

Its parts, by `data-testid`:

| Part                  | What it is                                                                                                 |
| :-------------------- | :--------------------------------------------------------------------------------------------------------- |
| `voice-call`          | The root. Hidden until scripts run.                                                                        |
| `voice-call-toggle`   | The button that starts and ends a call.                                                                    |
| `voice-call-mute`     | The button that mutes the microphone, shown while a call has one. `aria-pressed` says whether it is muted. |
| `voice-call-provider` | The provider and model on the line.                                                                        |
| `voice-call-status`   | The status line (`role="status"`).                                                                         |
| `voice-call-meter`    | The microphone's level, with `data-level`, `data-speaking`, and `data-muted`.                              |
| `voice-call-caption`  | The caption line, with the word being said in bold.                                                        |
| `voice-call-stay`     | "Stay on the call", shown while the call asks whether anyone is there.                                     |
| `voice-call-loading`  | The placeholder for a view on its way.                                                                     |

In the thread, a live spoken reply is a `<div class="turn-assistant" data-chat-part="turn" data-role="assistant" data-testid="turn-voice">` whose first child is the voice's words, `<p class="spoken" data-testid="voice-call-said">`, followed by what the reply shows. The word being said is marked in that paragraph with the highlight `voice-call-word`.

## Sidebar parts

Each of these is a form or a list that works with no JavaScript, fills the width it is given, and usually goes in `chat-sidebar`. The forms that load a page carry `data-genui="native"`, so the client runtime leaves them to the browser.

### chat-new

The New chat control: a form with one button. It posts the app with no conversation id, which the open route answers by starting a new conversation.

Props: `app` (posted as `app`), `route` (`/api/open`) and `label` (the button's text; "+ New chat"). Setting `route` prints the build line.

Test ids: `chat-new` (the form) and `chat-sidebar-new` (the button).

### chat-search

The conversation search box: a `search` element with a GET form, so searching is a page load with the words in the address as `q`. It holds no results: `chat-find` is the data part that prints this box and what was found.

Props: `route` (the page the search loads; without it, the page the form is on), `query` (the words searched for, shown in the box again), `label` (the box's name for a screen reader; "Search conversations"), `placeholder` ("Search conversations") and `go-label` (the button's text; "Search"). Setting `placeholder` prints the build line.

Test ids: `chat-sidebar-search` (the root), `chat-sidebar-search-input` and `chat-sidebar-search-go`.

### search-results

What a search found: a line that says how many, with a link that clears the search, and the list of matches. It holds no data.

Props: `clear` (where the Clear link leads; without it, the page it is on with no search) and `clear-label` ("Clear"). Setting `clear` prints the build line.

Slots: the default slot is the matches, one `search-result` each; `note` is the line's words, such as "3 found".

Its root is marked `data-chat-part="found"`. Test ids: `search-results` (the root), `chat-sidebar-search-note`, `chat-sidebar-search-clear` and `chat-sidebar-search-results`.

### search-result

One match: the conversation's title, and what was found in it. A form that posts the conversation's id, as a conversation in the list does. Written by the app from stored text, never by a model.

Props: `conversation` (the conversation's id, posted as `id`), `title` ("Conversation" without it), `app` (posted as `app`) and `route` (`/api/open`). Setting `route` prints the build line.

Slot: the default slot is what was found, with the matched words in `mark`, which the browser highlights in its own colors.

Needs: `search-results`, or an `ol` or `ul` of your own. Its root is a list item.

### conversation-list

The reader's conversations: a `nav` that lists them. It holds no data.

Prop: `label` (the list's name for a screen reader; "Conversations"). Setting it prints the build line.

Slot: the default slot is the items, one `conversation-item` each.

Beside a sibling `search-results` the list is not shown.

### conversation-item

One conversation: a form whose button is the conversation's title. It posts the conversation's id, which the open route answers by sending the reader to it. Written by the app from stored data, never by a model.

Props: `conversation` (the id, posted as `id`), `title` (the button's text; "Conversation" without it), `app` (posted as `app`), `current` (`true` on the open conversation, which marks its button `aria-current`) and `route` (`/api/open`). Setting `route` prints the build line.

Test ids: `conversation-item` (the form) and `chat-sidebar-item` (the button).

```html
<conversation-list>
  <conversation-item
    data-bascik-prop-conversation="3f2a0c1e"
    data-bascik-prop-title="Books about lighthouses"
    data-bascik-prop-current="true"
  />
</conversation-list>
```

### model-picker

The model picker: a form with a list of models and a Use button, so choosing one is a page load. It holds no data.

Props: `app` (posted as `app`), `route` (`/api/model`), `label` (the text above the list; "Model") and `use-label` (the button's text; "Use"). Setting `route` prints the build line.

Slots: the default slot is the list's `option` and `optgroup` elements, with `selected` on the model in use; `note` is one or more paragraphs under the list, in small print.

Needs: a route of your own at `/api/model` that stores the choice and sends the reader back. The chosen option's value is posted as `model`. It is a form, so it must never sit inside another one, which rules out every slot of `chat-composer`.

Test ids: `chat-sidebar-model` (the form), `chat-sidebar-model-select` and `chat-sidebar-model-use`.

```html
<model-picker>
  <option value="claude-sonnet-5-5" selected>Sonnet</option>
  <option value="claude-haiku-5-5">Haiku</option>
  <template data-bascik-slot="note">
    <p>Your choice applies to new replies.</p>
  </template>
</model-picker>
```

## Memory parts

See [Memory](/ai/memory) for the server side.

### memory-list

What the assistant remembers about the reader: a heading, one line that says what memory is, and the list. With no item inside, it shows an empty state. It needs no JavaScript.

Props: none.

Slots, each with words of its own when unfilled:

- the default slot: the items, one `memory-item` each.
- `heading`: the heading element itself, an `h1` saying "What I remember about you". Pass an `h2` or lower where the list is a section of a page.
- `about`: the text of the line under the heading.
- `empty`: the text shown when there is no item.

An empty wrapper leaves that piece out with the room it took: `<span data-bascik-slot="about"></span>`.

Needs: a column that sets its width. It fills the width it is given and adds no space around itself.

Test ids: `memory-list` (the root), `memory-list-about`, `memory-list-items` and `memory-list-empty`.

### memory-item

One memory: its text, the day it was saved, and a Forget button. Written by the app from stored data, never by a model. The button is a form marked `data-genui="native"`, so Forget is always a page load.

Props: `memory` (the memory's id, posted as `id`), `saved` (the day it was saved, as an ISO date), `app` (posted as `app`), `back` (posted as `back`: where the answer sends the reader) and `route` (`/api/forget`). Setting `route` prints the build line.

Slot: the default slot is the memory's text.

Test ids: `memory-item`, `memory-item-text`, `memory-item-saved` and `memory-item-forget`.

### memory-note

A line in a reply that says the assistant just saved something, with an Undo button. Written by the app for a finished remember call, never by a model. Inside a `data-chat` element the client runtime sends its form and streams the answer in.

Props: `memory` (the memory's id, posted as `id`), `app` (posted as `app`) and `route` (where Undo posts; `/api/forget`). Setting `route` prints the build line.

Slot: the default slot is the words that were saved.

## Turns and tool lines

These are printed inside the thread, by `chat-turns` or by a script of your own.

### chat-welcome

What an empty conversation shows: a heading, a line under it, and messages to start with. It hides itself as soon as the thread holds a reader's turn.

Props: `heading` ("How can I help?") and `tagline` (the line under it; left out without it).

Slots: the default slot is the suggestions, usually `ask-button` tags; `note` is a line or two between the tagline and the suggestions.

Needs: to be inside `chat-thread`, or your own element marked `data-chat-part="thread"`. That element is what hides it, so a welcome placed beside the thread stays on screen.

### chat-attachment

One file a reader attached, as a link to the file. An image shows as a thumbnail that opens the full image; anything else is a labeled link that downloads.

Props: `href` (where the file is served), `name` (the file name), `size` (text such as "12 KB") and `thumb` (the image's address, only for an image).

### tool-approval

Asks the reader to allow or refuse a tool call before it runs. Written by the app for a tool part that is waiting for approval, never by a model. Each of its two buttons posts the answer as `verdict` (`approve` or `deny`). See [Tools & Approval](/ai/tools).

Props: `action` (what the tool would do, as the card's title; "Run a tool" without it), `call` (the tool call's id, posted as `call`), `app` (posted as `app`) and `route` (`/api/approve`). Setting `route` prints the build line.

Slot: the default slot is the details of the call, as `dt` and `dd` pairs.

During a voice call, `voice-call` answers it on the call, with no request to the route.

### tool-status

One line that says how a tool call ended when there is no result to show: allowed, declined, or failed. Written by the app, never by a model.

Props: none. Slot: the default slot is the line's words.

## Adding your own

A catalog component is any Bascik component file in the catalog folder with an `@bascik` description comment. The description is what the model is told. See [Catalog](/ai/catalog).
