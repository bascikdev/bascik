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
Props: `app` (the app name).
Needs: /api/voice-session, /api/voice-tool, /api/voice-turn, /voice-view.
Modules: `voice-call/` (one per protocol, `gemini-live.ts` and `azure-voice-live.ts`, plus audio, captions, forms, tools, requests, status and types).

## Adding your own

A catalog component is any Bascik component file in the catalog folder with an `@bascik` description comment. The description is what the model is told. See [Catalog](/ai/catalog).
