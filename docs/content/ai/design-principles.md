# Design Principles

Bascik's own rules are short: be fast, be transparent, use what exists. Generative UI follows from them. This page lists the choices `@bascik/ai` makes, the Bascik rule behind each, and where the fit is not perfect.

## The stream is the page

A reply is HTML that grows. There is no message protocol between server and browser, no client state to keep in step with the server, and no code generated for the browser to run. A reader with scripts off and a reader with every feature on receive the same response.

This is "use what exists" applied to the wire format. Other stacks define a stream protocol and a client library to read it, because their components run in the browser. Here the components run on the server, so the protocol they need is the one a browser already speaks.

## The component file is the schema

A model's vocabulary is a folder of components. A component's tag, description, props, and slot are read from its file, so there is nothing to keep in step with it: no JSON Schema beside the component, no registry, no code generation.

It is the same convention as the rest of Bascik, where a component's name is its file name and its interface is its markup.

## The server is the trust boundary

Model output is untrusted text. The renderer lets a tag through only when it is in the catalog and a prop only when the component declares it, and escapes everything else. Bascik's request-time renderer then treats every prop as text. Nothing a model writes is ever run, on the server or in the browser.

A tool call's input is checked against the tool's schema before the tool runs, and a tool that changes something can require the reader's approval. The model can ask; the reader's click is what acts.

A voice call keeps the same boundary with a different wire. Audio goes from the browser straight to the speech model, on a one-use ticket with the session's setup locked in. Everything that runs or renders still goes through the server: a tool call is posted to it, and what the model wants shown is markup the server renders through the catalog.

## State lives in the message

An approval that is waiting, a tool that failed, a result the reader's browser sent: each is a state of a part of a stored message. Nothing about a conversation exists only in a page. A reload shows the same thing, a second device shows the same thing, and a reply goes on being written when its page is closed.

Bascik has no client state system, and this is why it does not need one here.

## Interaction is forms

A component that talks back is a `<form>`. A button's `name` and `value` are the whole API between a generated interface and the server, visible in the component file and in the browser's network panel. Forms work with scripts off, with a keyboard, with a screen reader, and for an agent driving a browser.

This is "use what exists" applied to your markup: HTML already has an element for sending something to a server.

## JavaScript adds, it does not carry

Scripts are welcome where they do something HTML cannot: streaming into the open page, sorting a table, speaking a reply. The rule is that nothing depends on them. Every feature has a version that works with scripts off, and a script reveals what only it can do.

Two things keep this from eroding. The scripts are components in your project, copied in by `bascik add`, a few hundred lines you can read and change, and not a runtime you install and trust. And the test suite runs every scenario twice, with scripts off and on, so the two paths cannot drift apart.

## Draw on the server when you can

A diagram is drawn in Node and sent as SVG. A table is sent as a table. The browser's job is to display. When a visual can be finished on the server, it is: the reader sees it sooner, on any device, with nothing to download.

## Where the fit is not perfect

These are the places the prototype bends a Bascik rule, or leans on something new.

- **It needs a server.** Bascik's first promise is a folder of static files. Generative UI renders per request, so it needs the dev server, the production server, or an adapter. It is an opt-in package for that reason, and nothing in it is part of Bascik itself.
- **It is a package with an API.** Bascik's guidance is that a task which seems to need a helper usually needs five lines in `src/lib/`. The renderer and the turn loop are more than that, and getting them wrong is a security problem, which is the same reason [`@bascik/bascik/html`](/html-helpers) exists. The package is kept to what is hard to get right; storage, routes, and layout stay in your project.
- **Live replies are one process's memory.** A reply that outlives its page is held in memory while it is written. With several servers, pass `createChat` a `shared` store: see [Running on Several Servers](/ai/scaling).
- **A reply nobody reads still costs tokens.** Finishing a reply after the reader leaves is a choice, and a model's time is not free.
- **Some CSS is recent.** The tool-call rule and the typing caret use `:has()`, and the first paint is held with `<link rel="expect">`. Older browsers show a little more than they should, and nothing breaks.

## Compared with a client-side UI library

Libraries such as the AI SDK's UI package standardize the same ideas for React: messages made of typed parts, tool calls with states, and a stream the client can resume. `@bascik/ai` keeps the ideas and drops what only a client runtime needs.

| Idea                          | Client-side library                    | `@bascik/ai`                                            |
| :---------------------------- | :------------------------------------- | :------------------------------------------------------ |
| Message parts and tool states | Typed objects in client state          | The same parts, stored on the server and rendered there |
| Stream format                 | A protocol the client library parses   | The page's HTML                                         |
| Generated components          | Rendered in the browser by a framework | Rendered on the server as scoped HTML                   |
| Tool approval                 | Client state and a callback            | A stored state and a form post                          |
| Client-side tools             | A callback in the client               | A form a script may fill in and send                    |
| Resuming a stream             | A store and a resume endpoint          | The page subscribes to the reply again                  |
| Works with scripts off        | No                                     | Yes                                                     |
