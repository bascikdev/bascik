# Overview

Generative UI lets a model answer with your components, not only with text. With `@bascik/ai`, the model writes prose and component tags, a stream script yields them, and Bascik renders each tag as scoped HTML while the reply is still arriving. The browser needs no JavaScript for any of it.

> **Experimental.** `@bascik/ai` is a prototype in the Bascik repository. It is not on npm yet and its API can change. These pages describe what the prototype does today.

## The idea

Other generative UI stacks send the model's output to the browser and render it there: the model writes JSON, a client library parses the partial stream, and a framework runtime turns it into components.

Bascik already has the pieces that make this a server concern:

- A [stream script](/scripts/stream) is an async generator, and each `yield` reaches the browser as it happens.
- A script can [return component tags](/scripts#returning-component-tags), and Bascik renders each one per request with the component's markup, props, slots, and scoped CSS.
- A component file already says what a model needs to know: its tag name, its `@bascik` description, its props, and whether it takes content.

So the model writes the language it knows best, tags shaped like HTML, and the response is one HTML document that grows.

## What a model writes, and what the reader gets

A reply is prose with tags from your catalog in it:

```text
Three picks from the catalog:

<card-grid>
<book-card title="Refactoring the Monolith" author="Grace Lin" rating="4.7">A field guide to splitting a large system without stopping it.</book-card>
</card-grid>

<ask-button say="Help me choose a book">Help me choose</ask-button>
```

The reader gets the prose as it is written, then each component as finished markup with its styles, the moment its closing tag arrives. The button is a `<form>`, so pressing it sends the next message with or without scripts.

## What is in the package

| Piece          | What it does                                                                                                                     | Page                                                      |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- |
| Catalog        | Reads a component folder into the list of tags a model may write, and into the prompt that teaches them                          | [Catalog](/ai/catalog)                                    |
| Renderer       | Turns a model's text stream into complete, safe HTML chunks                                                                      | [Catalog](/ai/catalog#the-renderer-is-the-trust-boundary) |
| Turn loop      | Runs the tools a model calls, with states, approval, and tools the reader's browser answers                                      | [Tools & Approval](/ai/tools)                             |
| Client runtime | An optional script that sends forms with `fetch` and streams the answer into the open page                                       | [Client Runtime](/ai/client-runtime)                      |
| Voice          | Optional scripts that read replies aloud with word-by-word captions, or hold a spoken conversation with a speech-to-speech model | [Voice & Captions](/ai/voice)                             |
| Search         | Finds words in a reader's past conversations with a plain form, and lets the model look there too                                | [Conversation Search](/ai/conversation-search)            |
| Components     | A starter catalog and the chat's own pieces, copied into your project with `bascik add`                                          | [Quick Start](/ai/quick-start)                            |

[Design Principles](/ai/design-principles) explains the choices behind these, and where they fit Bascik's own.

## What it needs

Generative UI renders on every request, so it needs a host that runs stream scripts: the [dev server](/development-server), the [production server](/production-server), or an [adapter](/deployment). A static build cannot serve it.
