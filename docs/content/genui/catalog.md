# Catalog

The catalog is the set of components a model may write. It is a folder of ordinary Bascik components, and there is no second schema: the component file is the definition.

## A component is its own description

A catalog component is a component like any other. Three things in the file are what a model is told:

```html
<!-- @bascik
A boxed note for a warning, a limit, or a caveat the reader must not miss: a short title, and the note as content. Use it sparingly.
-->
<aside class="note" data-testid="note-box">
  <strong class="title" data-bascik-prop-title></strong>
  <span data-bascik-slot></span>
</aside>
```

- The **file name** is the tag: `note-box.html` is `<note-box>`.
- The **`@bascik` comment** says what the component is for and when to use it. It is the same comment the editor shows on hover, so write it for both readers.
- The **props and the slot** come from the markup: every `data-bascik-prop-*` and `data-bascik-attr-*` is a prop, and a `data-bascik-slot` means the tag may hold content.

`readCatalog()` reads a folder of these, and `catalogPrompt()` turns the result into the part of the system prompt that teaches them:

```text
<note-box title="…">content</note-box>
  A boxed note for a warning, a limit, or a caveat the reader must not miss: a short title, and the note as content. Use it sparingly.
```

Adding a component to the folder adds it to the model's vocabulary. Keep the folder to components a model may write: a component your own code writes, such as an approval form, belongs in another folder.

```ts
import { catalogPrompt, readCatalog } from "@bascik/genui";

const catalog = await readCatalog("src/components/catalog");
const system = `You are a reading assistant.\n\n${catalogPrompt(catalog)}`;
```

`readCatalog` also takes several folders, for a catalog a package brought and your own beside it. A later folder's component replaces an earlier one of the same name.

## The renderer is the trust boundary

What a model writes is untrusted text. `renderStream()` and `renderText()` pass a tag on only when its name is in the catalog, keep only the props that component declares, and escape everything else, including every other `<`.

| The model writes                            | The reader gets                                              |
| :------------------------------------------ | :----------------------------------------------------------- |
| `<note-box title="Careful">Text</note-box>` | The `note-box` component                                     |
| `<note-box onclick="x" title="Careful">`    | The component; `onclick` is dropped because it is not a prop |
| `<script>alert(1)</script>`                 | The text `<script>alert(1)</script>`                         |
| `<admin-panel>`                             | The text `<admin-panel>`                                     |

Bascik's request-time renderer then applies its own rules to the tags that survive: a prop is text, a prop bound to a URL is checked, and event handler attributes are never bound. See [Returning component tags](/scripts#security).

The renderer also solves a streaming mismatch. A model's slices end anywhere, in the middle of a word or a tag, and a stream script must yield whole elements. The renderer streams prose as it arrives, holds a component back until its closing tag arrives, and gives the same HTML however the stream is sliced.

## Prose

Outside tags, a model writes plain text with a small set of marks: `**bold**`, `` `code` ``, lines that start with `# ` for headings, `- ` for bullets, and fenced code blocks. Line breaks are kept. Anything else is shown as written.

To let a model write a table or a list as HTML, name the elements. They are passed through with every attribute dropped:

```ts
const options = { elements: ["table", "thead", "tbody", "tr", "th", "td"] };
yield * renderStream(reply, catalog, options);
// And tell the model: catalogPrompt(catalog, options)
```

## Diagrams

A branching diagram is something a component cannot lay out, and a model already writes Mermaid. With the `mermaid` fence renderer, a fenced block marked `mermaid` is drawn on the server as an inline SVG:

```ts
import { catalogPrompt, renderStream } from "@bascik/genui";
import { MERMAID_PROMPT, mermaidFence } from "@bascik/genui/mermaid";

const fences = { mermaid: mermaidFence() };
yield * renderStream(reply, catalog, { fences });
// And tell the model: catalogPrompt(catalog, { fences: { mermaid: MERMAID_PROMPT } })
```

It needs the `beautiful-mermaid` package installed. It draws flowcharts, sequence, state, class, and entity diagrams, and XY charts; anything else is shown as the code it is. No script runs in the browser and nothing is fetched. The SVG has no colors of its own: it reads `--bg` and `--fg` from the page, so one render serves light and dark themes.

`fences` takes any language. A fence renderer is a function from the fence's text to HTML, or `null` to show the code.

## Interaction is forms

A component that talks back is a `<form method="post">`. `ask-button` is a one-click suggestion, `choice-form` is a single-choice question, and `input-form` collects several values. Each posts to a route of yours that stores the message and redirects to the page, which streams the next reply. None needs a client script, and each is a form any browser, screen reader, or browsing agent already understands.

## Share a catalog

A catalog is a folder of components, so it is shared the way components are. To publish one, make it a [component package](/how-to/publishing-components): a `bascik.components` field that points at the folder. A reader copies it in with [`bascik add`](/how-to/sharing-components) and passes the folder it landed in to `readCatalog`:

```sh
npx bascik add @acme/support-catalog
```

```ts
const catalog = await readCatalog([
  "src/components/catalog", // from @bascik/genui
  "src/components/support", // from @acme/support-catalog
]);
```

The copy-in model matters more here than for other components. A catalog component's `@bascik` comment is part of your prompt, so being able to edit it, in your own project, is how you tune what a model does with it.
