# Overview

Bascik AI is the AI interface for Bascik. It consists of three parts: Chat, Generative UI, and Voice.

## Three parts

**Chat** is the full interface, including the message box, thread, tool approval, memory, conversation search, attachments, and the server kit behind it. It is made of parts you assemble, and `<chat-app />` is all of them in one tag. See [Quick Start](/ai/quick-start), [Chat Parts](/ai/chat-parts), [Server Kit (Chat)](/ai/server-kit), [Tools & Approval (Chat)](/ai/tools), [Memory (Chat)](/ai/memory), [Client Runtime (Chat)](/ai/client-runtime), [Conversation Search (Chat)](/ai/conversation-search), [Attachments (Chat)](/ai/attachments), and [Running on Several Servers (Chat)](/ai/scaling).

**Generative UI** allows the model to show components from your catalog, rendered on the server as real HTML. See [Catalog (Generative UI)](/ai/catalog).

**Voice** enables spoken conversations with captions. See [Voice & Captions (Voice)](/ai/voice).

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
| Components     | A starter catalog and the chat's own parts, copied into your project with `bascik add`                                           | [Components](/ai/components)                              |
| Chat parts     | The whole chat in one tag, the parts it is made of, and the contract they share                                                  | [Chat Parts](/ai/chat-parts)                              |
| Providers      | Configures the AI providers used by the system                                                                                   | [Providers](/ai/providers)                                |
| Server Kit     | Provides the server-side infrastructure for Chat                                                                                 | [Server Kit (Chat)](/ai/server-kit)                       |
| Memory         | Manages persistent memory for Chat                                                                                               | [Memory (Chat)](/ai/memory)                               |
| Attachments    | Handles file attachments for Chat                                                                                                | [Attachments (Chat)](/ai/attachments)                     |
| Scaling        | Supports running on several servers for Chat                                                                                     | [Running on Several Servers (Chat)](/ai/scaling)          |

[Design Principles](/ai/design-principles) explains the choices behind these, and where they fit Bascik's own.

## What it needs

Generative UI renders on every request, so it needs a host that runs stream scripts: the [dev server](/development-server), the [production server](/production-server), or an [adapter](/deployment). A static build cannot serve it.
