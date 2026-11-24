# Voice & Captions

`chat-voice` reads each reply aloud as it streams, shows it a few words at a time with the word being spoken in bold, and can listen for the next message. It is an optional script, like the client runtime: with scripts off it shows nothing, and the chat is unchanged.

## Add it

`bascik add @bascik/genui` copies the component to `src/components/chat/`. Put it next to the composer:

```html
<chat-voice /> <chat-composer data-bascik-prop-app="books" />
```

It adds a caption line and three toggles:

| Control    | What it does                                                                                  |
| :--------- | :-------------------------------------------------------------------------------------------- |
| Captions   | Shows the reply a few words at a time, the current word in bold, at a reading pace. No sound. |
| Read aloud | Speaks the reply with the browser's own voice. The captions follow the voice.                 |
| Talk       | A conversation: listens, sends what it heard, speaks the reply, and listens again.            |

A Speed menu sets the pace of both the voice and the captions. The reader's choices are kept in the browser for their next visit, except Talk: the microphone is only ever turned on by a press in the current visit.

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
| Talk       | `SpeechRecognition` | Chrome, Edge, and Safari |

A control whose API is missing is not shown.

> **Speech recognition can leave the device.** In some browsers, what the microphone hears is sent to the browser vendor's servers to be turned into text. Say so where your readers can see it before they press Talk.

## Voices from a model

The browser's voices are free and instant, and they sound like a browser. A voice from a speech model sounds better, and some models take speech in and give speech out with no text in between. This prototype does not include one. The design it leaves room for:

- **The captions do not change.** A speech service that returns audio with word timestamps drives the same caption line the browser's `boundary` events drive now.
- **Audio is another stream.** The reply's HTML keeps streaming into the page as it does today. The audio for the same reply is a second response the script plays, keyed by the conversation, so the page and the voice are two views of one turn.
- **Components still arrive as HTML.** A model that speaks can still call for a chart. What it says is the audio; what it shows is a component in the thread, rendered on the server as on every other page here.
- **The server stays the trust boundary.** Whatever produces the words, text that reaches the page goes through the same renderer.
