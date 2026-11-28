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

Pressing the microphone button connects, turns on the microphone, and the reader talks. The model's voice plays, a caption line follows it, and what each side says appears in the thread. Typing in the composer during a call says the message to the model, so a call also works with no microphone. While a call is on, the button reads End call, and a line above the message box names the provider and its model, says what the call is doing, and carries the captions. The Reading aids step aside: a call has its own voice and captions. Dictate stops listening while a call is on, so nothing is sent to the model twice, and listens again when the call ends. When a call ends because the relay or the provider hung up, the reason is shown on that line.

A second button mutes the microphone without ending the call, and a call nobody speaks on asks whether anyone is there and then ends itself: see [Muting the microphone](#muting-the-microphone) and [A call nobody is speaking on](#a-call-nobody-is-speaking-on).

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

A tool that has not answered after a minute (`VOICE_TOOL_TIMEOUT_MS`) is recorded as failed, with "The tool took too long to answer.", and the `signal` it was given is aborted, so the model is told and the reader is not left waiting. Pass `{ timeoutMs }` as the last argument of `runVoiceTool` or `finishVoiceTool` to change the limit; 0 turns it off.

When the model finishes a turn, `voiceMessages(turn, { reader, model })` gives the messages to store. Pass `show` as well when the thread showed something other than what the model was told, such as the label of a form the reader pressed: it is stored as the reader's message's `show` (see [Forms in a call](#forms-in-a-call)). Words a model spoke are stored as a text part marked `spoken`, and are shown as plain text: a transcript that looks like a tag is still only something that was said.

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

When the relay cannot connect to Azure, the call ends with "The voice provider refused the connection. Its key or token may have expired." When Azure takes the connection and has not set the session up after `connectTimeoutMs` (15 seconds by default), it ends with "The voice provider did not answer in time." When Azure answers the session's setup with an error, the call ends at once with "The voice provider refused the call's settings.", without waiting for `connectTimeoutMs`. That is how a `turnDetection` setting the model does not take shows up: see [Providers](/ai/providers#voice-how-long-a-pause-ends-a-turn). In each case the same line goes to the server's log, followed by Azure's own reason when it gave one. That reason can name the resource, so the browser is never sent it.

Each call holds a connection to Azure, so the relay keeps at most 100 open (`relay.maxCalls`), and at most 3 for one reader (`relay.maxCallsPerOwner`). A call past either is closed as it connects, and the status line says "The voice relay is full. Try again later." or "Too many voice calls are open." The relay also ends the call of a browser that has gone silent or stopped reading, and a call nobody has spoken on for `callIdleSeconds` (five minutes by default), with "The call ended because nobody spoke." Every option is in [Providers](/ai/providers#voice-azure-voice-live).

`token` takes a Microsoft Entra token for `https://ai.azure.com/.default`, or a function that returns a fresh one, so a server can run with a managed identity and no key at all. The model has to be one Voice Live offers in the resource's region. No model deployment is needed.

### Approval in a call

A tool that needs the reader's OK works in a call as it does in text. The model says what it wants to do, the approval card appears in the thread, and the model waits on the line. The reader presses Allow or Don't allow, the server runs the tool or does not, and the model is told and says what happened. What runs is the call the model made, not anything sent with the answer.

During a call, an approval card never loads a page, so a second press on a card that was already answered does nothing and the call goes on.

A call that ends while a tool waits for the reader, because the page was closed or the connection dropped, leaves that turn behind. When the next call starts, the turn is stored as it was left and the waiting tool call is stored as denied, so it cannot be approved from the new call.

### Forms in a call

A reply can show a form: a button that asks a follow-up, a choice, a review with a note. In a call the reader can press it, or say their answer and let the model press it.

- **The reader presses it.** The form is not posted as a page load. It is sent to its own address with one more field, `voice=1`, and your route answers with what the form says, as `{ "say": "..." }`, with `"show"` beside it when the form sent one. `say` is said to the speech model as the reader's message, so the model answers aloud. The route still does whatever the form does, such as recording a decision; it only skips starting a typed reply.
- **The reader says it.** The model is given one more tool, `fill_form`, with `press` (the words on a button or option), `text` (what to type into the form's text box), and `field` (which text box, when there are several). The reader's browser does it, on the newest form that is on screen and not yet sent, where the reader watches it happen. The form is then sent the same way, and its answer is shown and stored as the reader's turn. When nothing matches, the model is told which buttons, options, and text boxes the form has, so it can try again.

The thread shows a sent form by its label, not by its message. A form's message is often a record in a fixed shape, such as a decision with an item id, which the model needs and the reader did not write. So the reader's turn shows the form's own `show` field when it has one (nothing at all when that field is empty), and otherwise the words on the button that was pressed, when that button carries the answer. The model is still told `say`. When the two differ, the component posts both to `/api/voice-turn`, as `reader` and `show`, and the stored message keeps both. The rule is the one typed chat uses: see [What the thread shows for a form](/ai/server-kit#what-the-thread-shows-for-a-form).

A form is sent once: it stays on screen as it was answered, and cannot be pressed again.

`fill_form` cannot answer an approval. A question about allowing an action is never among the forms it can reach, so a model cannot allow its own tool call: the reader presses that themselves.

### What the reader sees while a call works

A call shows what it is doing, so the reader is never left wondering whether it hears them or is stuck.

- **A level meter.** Once the microphone is on, a few small bars in the status line move with the real microphone signal. They turn the accent color while the level counts as speech. The meter is decoration (`aria-hidden`); it carries `data-level` (0 to 1, two decimals) and `data-speaking` for tests and your own styling. It keeps its room from the moment a call starts, so it moves nothing, and with `prefers-reduced-motion: reduce` the bars still follow the level but without easing. If the reader declines the microphone, there is no meter. While the microphone is muted the meter is dimmed (`data-muted`) and its level stays at 0.
- **No microphone.** When the reader declines the microphone, when the browser cannot start capturing (the microphone is let go, so the browser does not show it as recording), or when the microphone goes away during a call (a headset is unplugged, permission is taken back), the status line reads `No microphone: type to talk.` and the meter is hidden. The call goes on by typing.
- **Words as they are said.** The reader's bubble grows while they speak. Gemini streams its transcription; with Azure the bubble grows from the transcription deltas, and the completed text of an utterance replaces that utterance's words and no other's (see [When the reader pauses](#when-the-reader-pauses)).
- **One status at a time.** The status line reads `Waiting for your answer on screen.`, then `Working…`, then `Still there? The call is about to end.`, then `Thinking…`, then `Hearing you…`, then `Listening.`, in that order of precedence. While the microphone is muted, the last of them is `Muted. The model cannot hear you.` Azure says when the reader starts and stops speaking; for Gemini the meter's level decides, and it does not count the model's own voice coming back through the speakers.
- **Loading.** From the press until the call is on, the button shows a spinner and `aria-busy="true"`. While a view loads, a placeholder block (`data-testid="voice-call-loading"`, `aria-busy="true"`) holds its place and is removed if the view does not come. A form being sent is marked `aria-busy="true"` and its controls are disabled until the answer comes back.
- **A call that never comes on.** A call that connects and is not on after 20 seconds ends with "The voice service did not answer." on the status line.
- **A reply that was cut off.** With Azure Voice Live, when the reader speaks over a reply or types a message during one, audio and words of that reply that arrive after the cut are neither played nor shown, and a tool call it makes is not run. Azure names each reply, so the same holds for anything that arrives from a reply after the next one has begun, and the late end of a replaced reply does not end the turn that replaced it.
- **Sound the browser put to sleep.** A browser can suspend a page's sound, for example when a phone call comes in or the tab rests. The call resumes its sound when there is audio to play and when the page becomes visible again.
- **A message that cannot be read.** A message from the provider that is not JSON, or audio that cannot be decoded, is skipped. The next one is handled as usual.

### Muting the microphone

Once the microphone is on, a second button appears beside the call button (`data-testid="voice-call-mute"`, named "Mute microphone", with `aria-pressed`). Pressing it mutes the reader and keeps the call:

- **The microphone is switched off at its source.** Every audio track of the microphone's stream is disabled, so it gives silence for as long as the call is muted.
- **One second of silence is sent, and then nothing.** The silence follows the reader's last sound, so the provider hears them stop and ends their turn. After it, no audio is sent at all until the microphone is on again, and nothing the microphone picks up is kept or measured. Gemini Live is also told that the audio has ended (`audioStreamEnd`); for Azure Voice Live the silence is enough.
- **The status line reads `Muted. The model cannot hear you.`** The button's icon gains a stroke through it, so muted is not said by color alone, and the meter is dimmed (`data-muted`) with its level at 0.
- **The rest of the call goes on.** The model's voice still plays, a typed message is still said to the model, and noise in the room no longer cuts a reply off.

Pressing the button again turns the microphone back on, and the status line reads `Listening.` A new call always starts unmuted. The button is hidden when there is no microphone to mute: before the call is listening, after it ends, and when the microphone goes away.

### When the reader pauses

A reader who stops to think in the middle of a sentence has said one thing, and a provider hears two utterances. Sometimes the model starts to answer the first. A call treats that as one turn:

- **A turn's words are kept by utterance.** Azure names each utterance, and the component numbers them for Gemini. Words that arrive late, or a completed transcript that corrects the words so far, change their own utterance and never another, so the first half of a sentence is not replaced by the second. The reader's bubble shows them in the order they were spoken.
- **A reply nobody heard is taken back.** When the reader speaks over a reply before half a second of it has played, and it has put nothing on the screen but its words, the reply is removed from the thread and is not stored. What the reader says next goes on in the same turn. The model was answering a pause.
- **A reply the reader heard stays.** Once more than half a second has played, or the reply has shown a component, speaking over it stops the voice, ends that turn, and starts the next, as before.

How long a pause the provider waits through before it takes the reader's turn as over is a setting on the server, `pauseMs`: see [Providers](/ai/providers#voice-how-long-a-pause-ends-a-turn).

### A call nobody is speaking on

A call that was forgotten holds a connection, and anything the microphone hears can start another answer. So a call that is not in use asks, and then ends:

1. After two minutes with nothing happening, the status line reads `Still there? The call is about to end.`, a "Stay on the call" button appears beside it (`data-testid="voice-call-stay"`), and two short tones play for a reader who is not looking at the page.
2. Pressing the button, or anything else that uses the call, keeps it on and starts the two minutes again.
3. After 30 more seconds with no answer, the call ends with `The call ended because nobody spoke.` on the status line.

Two props set the times:

| Prop                   | Default | What it sets                                                                                        |
| :--------------------- | :------ | :-------------------------------------------------------------------------------------------------- |
| `idle-seconds`         | `120`   | How long nothing may happen before the reader is asked, in seconds. `0` never asks, and never ends. |
| `idle-warning-seconds` | `30`    | How long the reader then has to answer, in seconds.                                                 |

```html
<voice-call
  data-bascik-prop-app="books"
  data-bascik-prop-idle-seconds="300"
  data-bascik-prop-idle-warning-seconds="60"
/>
```

A value that is not a number, or is below 0, is read as the default.

The call is in use when any of these happens:

- Words of the reader's are written down, or the provider says the reader started to speak.
- The model speaks: its words arrive or its audio is played. A voice still playing, a tool that is running, a reply being waited for, and an approval waiting on the screen all keep the call on for as long as they last.
- The reader types a message, sends a form, or presses the mute button or "Stay on the call".

Sound in the microphone is not enough by itself: a room with a radio on is not somebody speaking. A muted call is asked like any other. A page that slept through its limit, in a tab the browser put to rest, ends its call as soon as it is looked at.

The Azure relay has a limit of its own for a page that does not ask, `callIdleSeconds`: see [Providers](/ai/providers#voice-azure-voice-live).

### Captions in a call

With an Azure voice, Azure Voice Live sends the time of each word, and the caption follows it exactly. An OpenAI voice on Azure sends none.

Gemini Live sends what the model says as text, in phrases, with no time for each word; it refuses a request for word timestamps on a live session. The text and the audio grow together, so the caption finds the current word by how far into the turn's audio the playback is. It is close, and it can be a word early or late.

### The word being said, in the answer

The word in bold in the caption line is also marked in the answer in the thread, so a reader who follows the text there keeps their place. In the live reply, what the voice says is a paragraph, `<p class="spoken" data-testid="voice-call-said">`, the same element a stored spoken turn is drawn as, and the mark moves through its text.

The mark is made with the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API), under the name `voice-call-word`. A highlight paints a range of text and puts no element into it, so the answer's markup does not change and a screen reader is not given the word a second time. The component's own style is a tint of `--accent`, and the system's highlight colors in forced-colors mode. Restyle it by name in your stylesheet; a highlight takes color and text-decoration properties only:

```css
::highlight(voice-call-word) {
  background-color: transparent;
  text-decoration: underline 2px;
}
```

The timing is the caption's. With an Azure voice the mark follows the provider's time for each word exactly. With Gemini Live, or an OpenAI voice on Azure, the place is estimated from how much of the turn's audio has played, so it can be a word early or late, and can step back a word while the voice is still arriving. When the voice stops, is cut off, or the call ends, the mark is cleared.

While a word is marked, the paragraph carries `data-spoken-word` (the word) and `data-spoken-at` (where it starts in the text), for tests and your own styling. A browser without the Custom Highlight API marks nothing in the thread, and the caption line still shows the word.

### What an open call costs

A call is billed in tokens, for the answers made on it, and each answer is billed with the conversation before it. These are the providers' own statements, not measurements of ours, and their pages have the prices:

- **Azure Voice Live** bills per token, at a rate set by the model's tier. For Azure OpenAI models, audio is about 10 tokens a second going in and 20 a second coming out. See [Voice Live pricing](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live#pricing).
- **OpenAI's guide to Realtime costs, which Azure follows,** says that cost accrues when a response is made, that the whole conversation is sent for each response, and that voice detection filters out empty audio. See [Managing costs](https://developers.openai.com/api/docs/guides/realtime-costs).
- **Gemini Live** charges per turn for all the tokens in the session's context, and audio accumulates there at about 25 tokens a second. See [Live API best practices](https://aistudio.google.com/docs/live-api/best-practices).

So what a forgotten call spends is not its minutes on the line. It is the answers the model goes on making to whatever the microphone hears, each one carrying the whole call so far, and a long call costs more per answer than a short one. Muting stops audio from being sent, and a call nobody speaks on ends itself, which is why both exist.

### Limits

- **Two providers.** Gemini Live and Azure Voice Live are implemented. A provider is one function, `createSession`, that returns where the browser connects and what it sends first; the browser side speaks one wire protocol per provider. OpenAI's own Realtime API is not implemented.
- **Sessions are short.** Gemini Live limits an audio session to about 15 minutes, and the Azure relay ends a call after `sessionSeconds` (15 minutes by default). The component does not reconnect.
- **The word mark needs a current browser.** Without the CSS Custom Highlight API the word being said is shown in the caption line only.
- **A slow connection loses microphone audio.** When about five seconds of microphone audio is waiting to be sent, the component sends no more until the connection has caught up. The model hears a gap instead of speech that arrives seconds late.
- **Client tools are left out.** A tool the reader's browser answers (`client: true`) is not offered in a call.
- **A long call costs more per answer.** A call is billed for the answers made on it, each with the conversation before it, not for the time it stays open: see [What an open call costs](#what-an-open-call-costs).
- **Echo.** The microphone hears the speakers. The browser's echo cancellation is on, and headphones are better.

How a call is tested as sound, with nobody at a microphone, and what those tests do not cover, is on [Testing Voice](/ai/testing-voice).

### How much a call stores

A call's tool calls and views are kept in the shared store until the turn ends, and each turn is then stored in the conversation. Both are bounded, so a model, a provider, or a browser that sends too much cannot grow them without end:

| Limit                  | Value                                        | What happens past it                                                                                                                                                                                            |
| :--------------------- | :------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parts in one turn      | 64 (`MAX_VOICE_PARTS`)                       | The next `show` or tool call fails, and the model is told the turn holds too much.                                                                                                                              |
| Characters in one turn | 512,000 (`MAX_VOICE_TURN_CHARS`)             | The same. A tool's output that would take the turn past it is stored as "(too long to keep)"; the model still gets the whole output.                                                                            |
| Views kept             | 64 (`MAX_VOICE_VIEWS`)                       | The oldest view is deleted. The thread on screen keeps it; a reload shows it from the stored message.                                                                                                           |
| Speech in one turn     | 8,000 characters for each side               | The rest is cut.                                                                                                                                                                                                |
| A tool's result        | 100,000 characters (`MAX_VOICE_TOOL_OUTPUT`) | What the model is told is cut to fit and ends with "(The result was too long. This is the start of it.)". A relay drops a longer result whole, and the model would wait for it.                                 |
| Call ids remembered    | 256 (`MAX_VOICE_CALL_IDS`)                   | The oldest ids of turns already stored are forgotten.                                                                                                                                                           |
| Turn ids remembered    | 64                                           | The oldest are forgotten.                                                                                                                                                                                       |
| One conversation       | 2 MB (`maxConversationBytes`)                | A voice turn or a typed message that would take it past this is refused with 413, "This conversation is full", and a tool call in a conversation already full is told so. The reader starts a new conversation. |

Typed messages and voice turns count against the same `maxConversationBytes`. Set it in `createChat` options.

### Call ids

A tool call is recorded under the provider's id. An id of 1 to 64 letters, digits, `_`, or `-` is kept as it is; any other is mapped to one made from its SHA-256 hash (`voiceCallId`), so two calls with one raw id are always the same call. An id is used once in a call, across turns: a second call with an id already used, `show` included, is refused with "already called", and its view never replaces the first one. The ids of turns already stored are remembered for this, the last 256 of them (`MAX_VOICE_CALL_IDS`), so a tool call the provider sends again after its turn was stored does not run a second time. The browser refuses a tool call with no id instead of posting it.

A call still running or approved when its turn is stored is stored as failed, "ended with the call". What it returns later is told to the model but recorded in no turn, even a later turn with a call of the same id.

### Turn ids

The `voice-turn` route takes an optional `turn` form field that names the turn: 1 to 64 letters, digits, `_`, or `-`. A turn whose id was already stored is answered 204 and stored once, so sending a turn again is safe. Any other value is ignored, and the turn is stored as one with no id.

The component names every turn and sends it with `keepalive`, so a turn still reaches the server when the reader leaves the page in the middle of a call. When the request fails or the server answers with a 5xx status, it is sent once more a second later.

### No voice provider

`voiceTool` and `voiceTurn` answer 404 when `createChat` has no `voice` option, as `voiceSession` does, and `voiceView` answers nothing.

The three voice routes, like the kit's other form routes, refuse a POST sent by another site's page with 403: see [Server Kit](/ai/server-kit#handlers).

When `voice` is a function that picks a provider by name, the voice handlers serve only a conversation it opened a voice session for: `voiceSession` marks the conversation in the shared store when the picked provider hands out a ticket, and the mark lasts two hours after the call last used it. A picker that answers null for every request leaves `voiceTool` and `voiceTurn` answering 404 and `voiceView` answering nothing, so no tool runs and no turn is stored. A call's tool calls and turns go to the conversation open when the call started; opening another conversation during a call that a picker started makes them answer 404 until a new call starts there.

`addMessage` rejects with `ConversationFullError` when the message would take the conversation past `maxConversationBytes`. A route of yours that calls it answers that with 413, as `send` does.
