# Components

The `@bascik/ai` package ships two sets of components: generative UI components that a model may write, and chat and voice components that you place in your pages. You copy them into your project with `npx bascik add @bascik/ai`. They are yours to edit after that.

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

You place these in your pages.

> **Install esbuild for the voice components.** `chat-voice` and `voice-call` keep their logic in TypeScript modules beside them (`chat/chat-voice/` and `chat/voice-call/`), which Bascik bundles into each component's script at build time with esbuild. Install it in the project that builds them: `npm install --save-dev esbuild`. Without it, a build that uses either component fails naming the component's script. See [Importing TypeScript Modules](/scoped-javascript#importing-typescript-modules).

### chat-attachment

One file a reader attached, as a link to the file.
Props: `href` (where the file is served), `name` (the file name), `size` (text such as "12 KB"), `thumb` (the image's address, only for an image).

### chat-composer

The message box. A plain form that posts to /api/send.
Props: `enctype` (set to "multipart/form-data" to take attachments), `max-bytes` (max file size), `max-files` (max number of files), `max-total` (max total size), `types` (comma-separated media types), `app` (the app name).

### chat-enhance

The optional client runtime. Put it in the page before the thread.
Props: None.

### chat-voice

Voice for a chat. Put it inside the composer.
Props: None.
Modules: `chat-voice/` (settings, sentences, captions).

### memory-item

One memory in a memory-list. Written by the app.
Props: `saved` (the day it was saved), `app` (the app name), `memory` (the memory id), `back` (the return URL).

### memory-list

What the assistant remembers about the reader.
Props: None.

### memory-note

A line in a reply that says the assistant just saved something. Written by the app.
Props: `app` (the app name), `memory` (the memory id).

### search-result

One match in a list of search results. Written by the app.
Props: `app` (the app name), `conversation` (the conversation id), `title` (the conversation title).

### tool-approval

Asks the reader to allow or refuse a tool call. Written by the app.
Props: `app` (the app name), `call` (the call id), `action` (the action description).

### tool-status

One line that says how a tool call ended. Written by the app.
Props: None.

### voice-call

A spoken conversation with a speech-to-speech model. Put it inside the composer.
Props: `app` (the app name), `idle-seconds` (how long nobody may speak before the call asks "Still there?", default 120, 0 for never), `idle-warning-seconds` (how long the reader then has to answer before the call ends, default 30).
Needs: /api/voice-session, /api/voice-tool, /api/voice-turn, /voice-view.
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

In the thread, a live spoken reply is a `<div class="turn-assistant" data-testid="turn-voice">` whose first child is the voice's words, `<p class="spoken" data-testid="voice-call-said">`, followed by what the reply shows. The word being said is marked in that paragraph with the highlight `voice-call-word`. See [Voice & Captions](/ai/voice#a-call-with-a-speech-model).

## Adding your own

A catalog component is any Bascik component file in the catalog folder with an `@bascik` description comment. The description is what the model is told. See [Catalog](/ai/catalog).
