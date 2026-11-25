# Voice & Captions

Two optional components give a chat a voice. `chat-voice` uses the browser's own speech: it reads each reply aloud as it streams, shows it a few words at a time with the word being spoken in bold, and can listen for the next message. `voice-call` is a spoken conversation with a speech-to-speech model. Both are scripts, like the client runtime: with scripts off they show nothing, and the chat is unchanged.

## Add it

`bascik add @bascik/ai` copies the component to `src/components/chat/`. Put it inside the composer:

```html
<chat-composer data-bascik-prop-app="books">
  <chat-voice />
</chat-composer>
```

Inside the composer, it adds a CC button to the composer's row. The button opens a line of controls above the message box, and shows a light while any of them is on. Captions appear as a line in the same box:

| Control    | What it does                                                                                  |
| :--------- | :-------------------------------------------------------------------------------------------- |
| Captions   | Shows the reply a few words at a time, the current word in bold, at a reading pace. No sound. |
| Read aloud | Speaks the reply with the browser's own voice. The captions follow the voice.                 |
| Dictate    | A conversation: listens, sends what it heard, speaks the reply, and listens again.            |

A Speed menu sets the pace of both the voice and the captions. The reader's choices are kept in the browser for their next visit, except Dictate: the microphone is only ever turned on by a press in the current visit.

## Captions are a reading aid

Captions do not need sound. With Captions on and Read aloud off, the reply is paced through the caption line at a reading speed, with a longer word held a little longer. A reader who finds a block of text hard to track gets a few words at a time and a clear place to look.

The caption line holds the same words as the reply above it, so it is hidden from screen readers, which already read the reply.

## What is spoken

Prose is read as written, one sentence at a time, as soon as a sentence is complete. A sentence is never spoken twice, and a stored reply is not read out when the page loads.

A component is a picture, so it is skipped: reading a chart's markup aloud helps nobody. To have a component say something, put `data-say` on an element in it. Bind it to a prop to say what the model wrote:

```html
<article data-testid="book-card" data-bascik-attr-data-say="title">
  <h3 data-bascik-prop-title></h3>
  ...
</article>
```

A reply with three book cards is then spoken as its prose and the three titles, and not the ratings, blurbs, and button labels.

## How the captions stay in step

The browser's speech engine reports where it is as it speaks, with a `boundary` event per word. The caption moves on each one. Some voices send no boundary events; for those the caption keeps a reading pace from the moment the voice starts, so it is close, and never stuck.

## Browser support and privacy

Voice uses the Web Speech API, so it has no dependency and costs nothing to run:

| Feature    | API                 | Where it works           |
| :--------- | :------------------ | :----------------------- |
| Captions   | None                | Every browser            |
| Read aloud | `speechSynthesis`   | Every current browser    |
| Dictate    | `SpeechRecognition` | Chrome, Edge, and Safari |

A control whose API is missing is not shown.

> **Speech recognition can leave the device.** In some browsers, what the microphone hears is sent to the browser vendor's servers to be turned into text. Say so where your readers can see it before they press Talk.

## A call with a speech model

The browser's voices are free and instant, and they sound like a browser. `voice-call` is the other kind of voice: a spoken conversation with a speech-to-speech model, which hears the reader and answers aloud with no text step in between. It works with Google's Gemini Live API and with Azure Voice Live.

```html
<chat-composer data-bascik-prop-app="books">
  <chat-voice />
  <voice-call data-bascik-prop-app="books" />
</chat-composer>
```

Pressing the microphone button connects, turns on the microphone, and the reader talks. The model's voice plays, a caption line follows it, and what each side says appears in the thread. Typing in the composer during a call says the message to the model, so a call also works with no microphone. While a call is on, the button reads End call, and a line above the message box names the provider and its model, says what the call is doing, and carries the captions. The Reading aids step aside: a call has its own voice and captions. When a call ends because the relay or the provider hung up, the reason is shown on that line.

Both components have no box of their own. Their parts are laid out by the composer, so the chat has one box at the bottom of the page and not three. Either one also works outside the composer, as plain elements in the page.

### What goes direct and what goes through your server

A text reply is a request and a growing page. A call is a long two-way audio connection, so it is wired differently:

- **The browser connects with a one-use ticket.** Your server makes a ticket with the session's whole setup locked into it: the model, your instructions, and the tools. The browser connects with the ticket. It never sees your API key and cannot change what the session may do. With Gemini Live the ticket is Google's own, so the audio goes straight to Google. Azure has no such ticket, so the audio goes through a relay on your server (see [Azure Voice Live](#azure-voice-live)).
- **What runs or renders goes through your server.** When the model calls a tool, the call arrives in the browser, which posts it to your server. The server checks the input, runs the tool, and answers. The trust boundary is where it is for text.
- **Components are shown with a tool.** The model is given one extra tool, `show`, whose input is markup in the usual reply format. The server renders it through the catalog, as it renders any reply, and the browser puts the result in the thread. So a spoken answer can come with cards, a chart, or a diagram, and none of it is rendered by the model or the browser.
- **What was said is stored as a message.** The transcripts, the tool calls, and what was shown become one assistant message made of parts. A reload shows the conversation, components included.

### The server side

A voice provider turns a session's config into a ticket. `voicePrompt` teaches a speaking model the catalog, and `voiceTools` adds `show` to your tools:

```ts
// src/api/voice-session.ts
import { geminiLiveVoice } from "@bascik/ai/gemini-live";
import { voicePrompt, voiceTools } from "@bascik/ai/voice";

// Reads GEMINI_API_KEY from the environment.
const voice = geminiLiveVoice();

export const POST = async (): Promise<Response> => {
  const ticket = await voice.createSession({
    system: `You are a reading assistant.\n\n${voicePrompt(catalog)}`,
    tools: voiceTools(tools),
  });
  return Response.json(ticket);
};
```

`runVoiceTool` is the server's side of a tool call. It checks the input against the tool's schema, holds a tool marked `approval: true` until the reader answers, renders `show` through the catalog, and records the call in the turn:

```ts
// src/api/voice-tool.ts
import { runVoiceTool } from "@bascik/ai/voice";

const result = await runVoiceTool(
  turn, // the voice turn being recorded for this conversation
  { id, name, input }, // as the model sent them
  tools,
  catalog,
);
// result.output is what to tell the model; result.html is what to show.
```

When the model finishes a turn, `voiceMessages(turn, { reader, model })` gives the messages to store. Words a model spoke are stored as a text part marked `spoken`, and are shown as plain text: a transcript that looks like a tag is still only something that was said.

The repository's demo has the three routes (`api/voice-session.ts`, `api/voice-tool.ts`, `api/voice-turn.ts`) and the `voice-view` page the component reads a call's view from. The view is a page, and not an API response, so that Bascik renders the components in it.

### Azure Voice Live

`azureVoiceLiveVoice` is the same kind of provider, for a Microsoft Foundry resource. The `voice-call` component and the three routes do not change: the ticket names its protocol, and the component speaks it.

```ts
// src/api/voice-session.ts
import { azureVoiceLiveVoice } from "@bascik/ai/azure-voice-live";

// Reads AZURE_VOICE_LIVE_ENDPOINT, and AZURE_VOICE_LIVE_API_KEY or AZURE_VOICE_LIVE_TOKEN.
// Make it once, outside the handler: it runs a relay that outlives a request.
const voice = azureVoiceLiveVoice({
  model: "gpt-realtime-2",
  voice: "en-US-AvaMultilingualNeural",
});
```

Azure opens a Voice Live connection with the resource's key or a Microsoft Entra token, and has no one-use token to hand to a browser. Either credential in a browser would open the whole resource to it. So the provider runs a small WebSocket relay in your server's process:

- The ticket is an address on the relay with a random id, good for one call, for a minute.
- The relay connects to Azure with the credential and sends the session's setup itself.
- It passes on only what a call needs: microphone audio, a typed message, a tool's result, and asking for or stopping a reply. A new session setup from the browser is dropped, and a typed message is always the reader's.

The cost is that the audio passes through your server, and that the relay needs Node: it listens on a port (`relay.port`, any free one by default), so it does not run on an edge runtime. Behind a proxy, set `relay.publicUrl` to the `wss://` address the browser reaches it at.

With several servers, the audio stays on the server the browser reached, and the ticket works on any of them once the provider is given a shared store: see [Running on Several Servers](/ai/scaling#the-azure-relay).

When the relay cannot connect to Azure, the call ends with "The voice provider refused the connection. Its key or token may have expired.", and the same line goes to the server's log.

`token` takes a Microsoft Entra token for `https://ai.azure.com/.default`, or a function that returns a fresh one, so a server can run with a managed identity and no key at all. The model has to be one Voice Live offers in the resource's region. No model deployment is needed.

### Approval in a call

A tool that needs the reader's OK works in a call as it does in text. The model says what it wants to do, the approval card appears in the thread, and the model waits on the line. The reader presses Allow or Don't allow, the server runs the tool or does not, and the model is told and says what happened. What runs is the call the model made, not anything sent with the answer.

### Forms in a call

A reply can show a form: a button that asks a follow-up, a choice, a review with a note. In a call the reader can press it, or say their answer and let the model press it.

- **The reader presses it.** The form is not posted as a page load. It is sent to its own address with one more field, `voice=1`, and your route answers with what the form says, as `{ "say": "..." }`. That text is said to the speech model as the reader's message, so the model answers aloud. The route still does whatever the form does, such as recording a decision; it only skips starting a typed reply.
- **The reader says it.** The model is given one more tool, `fill_form`, with `press` (the words on a button or option), `text` (what to type into the form's text box), and `field` (which text box, when there are several). The reader's browser does it, on the newest form that is on screen and not yet sent, where the reader watches it happen. The form is then sent the same way, and what it said is shown and stored as the reader's message. When nothing matches, the model is told which buttons, options, and text boxes the form has, so it can try again.

A form is sent once: it stays on screen as it was answered, and cannot be pressed again.

`fill_form` cannot answer an approval. A question about allowing an action is never among the forms it can reach, so a model cannot allow its own tool call: the reader presses that themselves.

### What the reader sees while a call works

A call shows what it is doing, so the reader is never left wondering whether it hears them or is stuck.

- **A level meter.** Once the microphone is on, a few small bars in the status line move with the real microphone signal. They turn the accent color while the level counts as speech. The meter is decoration (`aria-hidden`); it carries `data-level` (0 to 1, two decimals) and `data-speaking` for tests and your own styling. It keeps its room from the moment a call starts, so it moves nothing, and with `prefers-reduced-motion: reduce` the bars still follow the level but without easing. If the reader declines the microphone, there is no meter.
- **Words as they are said.** The reader's bubble grows while they speak. Gemini streams its transcription; with Azure the bubble grows from the transcription deltas, and the completed text replaces them.
- **One status at a time.** The status line reads `Waiting for your answer on screen.`, then `Working…`, then `Thinking…`, then `Hearing you…`, then `Listening.`, in that order of precedence. Azure says when the reader starts and stops speaking; for Gemini the meter's level decides, and it does not count the model's own voice coming back through the speakers.
- **Loading.** From the press until the call is on, the button shows a spinner and `aria-busy="true"`. While a view loads, a placeholder block (`data-testid="voice-call-loading"`, `aria-busy="true"`) holds its place and is removed if the view does not come. A form being sent is marked `aria-busy="true"` and its controls are disabled until the answer comes back.

### Captions in a call

With an Azure voice, Azure Voice Live sends the time of each word, and the caption follows it exactly. An OpenAI voice on Azure sends none.

Gemini Live sends what the model says as text, in phrases, with no time for each word; it refuses a request for word timestamps on a live session. The text and the audio grow together, so the caption finds the current word by how far into the turn's audio the playback is. It is close, and it can be a word early or late.

### Limits

- **Two providers.** Gemini Live and Azure Voice Live are implemented. A provider is one function, `createSession`, that returns where the browser connects and what it sends first; the browser side speaks one wire protocol per provider. OpenAI's own Realtime API is not implemented.
- **Sessions are short.** Gemini Live limits an audio session to about 15 minutes, and the Azure relay ends a call after `sessionSeconds` (15 minutes by default). The component does not reconnect.
- **Client tools are left out.** A tool the reader's browser answers (`client: true`) is not offered in a call.
- **A call costs money while it is open.** Audio in and out is billed by the provider for as long as the call lasts.
- **Echo.** The microphone hears the speakers. The browser's echo cancellation is on, and headphones are better.

### How much a call stores

A call's tool calls and views are kept in the shared store until the turn ends, and each turn is then stored in the conversation. Both are bounded, so a model, a provider, or a browser that sends too much cannot grow them without end:

| Limit                  | Value                            | What happens past it                                                                                                                                                                                            |
| :--------------------- | :------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parts in one turn      | 64 (`MAX_VOICE_PARTS`)           | The next `show` or tool call fails, and the model is told the turn holds too much.                                                                                                                              |
| Characters in one turn | 512,000 (`MAX_VOICE_TURN_CHARS`) | The same. A tool's output that would take the turn past it is stored as "(too long to keep)"; the model still gets the whole output.                                                                            |
| Views kept             | 64 (`MAX_VOICE_VIEWS`)           | The oldest view is deleted. The thread on screen keeps it; a reload shows it from the stored message.                                                                                                           |
| Speech in one turn     | 8,000 characters for each side   | The rest is cut.                                                                                                                                                                                                |
| One conversation       | 2 MB (`maxConversationBytes`)    | A voice turn or a typed message that would take it past this is refused with 413, "This conversation is full", and a tool call in a conversation already full is told so. The reader starts a new conversation. |

Typed messages and voice turns count against the same `maxConversationBytes`. Set it in `createChat` options.

### Call ids

A tool call is recorded under the provider's id. An id of 1 to 64 letters, digits, `_`, or `-` is kept as it is; any other is mapped to one made from its SHA-256 hash (`voiceCallId`), so two calls with one raw id are always the same call. A second call with an id already used in the turn, `show` included, is refused with "already called", and its view never replaces the first one. The browser refuses a tool call with no id instead of posting it.

A call still running or approved when its turn is stored is stored as failed, "ended with the call". What it returns later is told to the model but recorded in no turn, even a later turn with a call of the same id.

### No voice provider

`voiceTool` and `voiceTurn` answer 404 when `createChat` has no `voice` option, as `voiceSession` does, and `voiceView` answers nothing.
