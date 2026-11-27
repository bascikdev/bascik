# Testing Voice

A voice call can look right and be wrong. The status line says "Listening.", the caption moves, the test passes, and the reader hears a voice at the wrong pitch, a gap every second, or a model that keeps talking after they cut in. So `@bascik/ai` tests a call as sound, with nobody at a microphone: what a reader hears and what a provider is sent, not only what the page shows.

This page is for people evaluating Bascik AI or contributing to it. The tooling is the [voice lab](https://github.com/bascikdev/bascik/tree/main/ai/voice-lab), a folder in the repository. None of it ships in the package.

## The four lanes

A call is tested four ways. Each lane answers a question the others cannot.

| Lane            | Provider                              | Microphone                                | Runs in CI                     |
| :-------------- | :------------------------------------ | :---------------------------------------- | :----------------------------- |
| Lab             | A stand-in, steered by the test       | A stream the test says sound into         | Yes                            |
| Real microphone | A stand-in                            | Chromium's own `getUserMedia`, fed a file | Yes                            |
| Cassette        | A recorded real session, played back  | None needed                               | Yes                            |
| Live            | The real provider, through a recorder | A stream the test says real speech into   | No: needs keys, spends credits |

The first three need no key, no device, and no network, and run with the package's browser tests:

```sh
yarn ai:e2e
```

The live lane is run by hand. Each run leaves cassettes, which the cassette lane then plays back at no cost.

## What is measured

Every lab test reports its numbers with the run, as `measured` annotations in Playwright's list and HTML reports, so a slow drift is seen before it becomes a failure.

| Measurement              | How it is taken                                                                                                                      | Limit                             |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------- |
| Capture match            | A known signal is said into the microphone. The provider's copy is lined up with it and compared, whole and in every quarter second. | Over 0.95 in every quarter second |
| Capture clock slip       | How far any quarter second had to be moved to match. Two sound clocks differ by a few samples; a lost block is 8 ms.                 | Under 4 ms                        |
| Capture gain             | The copy's loudness over the original's.                                                                                             | 0.85 to 1.15                      |
| Capture pace             | Seconds of sound received over seconds passed. A page that captured at 48 kHz and said 16 kHz would send three times too much.       | 0.93 to 1.07                      |
| Playback match           | The provider sends a known voice. What the page sends to the loudspeaker is recorded sample for sample and compared.                 | Over 0.99 of 1                    |
| Playback gaps and clicks | One stretch of sound as long as the voice, and no jump between samples larger than the voice's own.                                  | None                              |
| Barge-in stop            | From the reader's first sound into the microphone to the last sample of the model's voice out of the loudspeaker.                    | Under 700 ms                      |
| Hang-up stop             | From the press to the last sample played.                                                                                            | Under 300 ms                      |
| Nothing held             | Live microphone tracks, open audio contexts, and open sockets after a call ends, however it ended.                                   | 0, 0, and 0                       |
| Word error rate (live)   | The provider's own transcript of a spoken sentence against the sentence.                                                             | At most 34%                       |
| Answer starts (live)     | From the end of the reader's sentence to the model's first sound.                                                                    | Under 10 s                        |

On a developer laptop the stand-in lanes measure a barge-in stop of 50 to 100 ms and a hang-up stop under 30 ms. Those are the page's own share. In a real call the provider's time to notice speech is added, and the live lane measures that.

## A signal instead of a recording

The lab says a speech-like signal made from a formula: a pitched buzz with moving formants, in syllables, in words with gaps ([`signal.ts`](https://github.com/bascikdev/bascik/blob/main/ai/voice-lab/signal.ts)). It has the level, rhythm, and spectrum of speech, which is what capture, playback, and level detection work on. The same arguments always give the same samples, so no audio file is committed, and any piece of the signal can be told from any other. That is what lets a test say "this quarter second is missing".

`findSignal` finds the signal in a recording and gives a score for the whole, the worst score of any quarter second, the gain, and the slip. The worst quarter second is the number that matters: a dropped, repeated, or reordered piece moves everything after it, so its stretch scores near 0 while the whole can still look fair.

## A microphone the test speaks into

A lab test adds a script to the page ([`browser.ts`](https://github.com/bascikdev/bascik/blob/main/ai/voice-lab/browser.ts)) that replaces `getUserMedia` with a stream the test plays sound into on cue. The `voice-call` component still opens a capture context, resamples, measures the level, cuts the sound into pieces, and sends them, as it does with a real microphone. The test can also deny the microphone, delay the answer to the permission prompt, and unplug the microphone in the middle of a call.

## A tap on the loudspeaker

The same script records everything the page sends to an audio output, with an audio worklet, by sample position. A test reads it back with the time its first sample was played, so it can say when the model's voice started and stopped to within a few milliseconds. The playback, barge-in, and hang-up measurements come from this tap.

## Stand-in providers a test can steer

Two small servers stand in for the providers: one speaks the Gemini Live protocol and one the Azure Voice Live protocol ([`fake-live-server.ts` and `fake-azure-server.ts`](https://github.com/bascikdev/bascik/tree/main/ai/e2e)). Each keeps the microphone audio it receives and gives it to the test on request. A typed message that starts with `lab:` steers a session:

| Message              | What the stand-in does                                                    |
| :------------------- | :------------------------------------------------------------------------ |
| `lab:speak 4`        | Says four seconds of a known voice, and stops if the reader cuts in.      |
| `lab:late 4`         | The same, and a few pieces still arrive after the cut (Azure).            |
| `lab:slow 2`         | Sends the voice slower than it plays.                                     |
| `lab:drop`           | Starts speaking, then cuts the connection with no close frame.            |
| `lab:close 1011 Why` | Closes with that code and reason.                                         |
| `lab:garbage`        | Sends a frame that is not JSON and audio that is not base64, then speaks. |

These are how the failures a reader can meet are tested: a provider that hangs up, a connection that stalls, a reply cut off, a message that cannot be read. What the component does in each case is on [Voice & Captions](/ai/voice#what-the-reader-sees-while-a-call-works).

## The browser's real capture

One lane does not replace `getUserMedia`. The `real-microphone` Playwright project starts Chromium with `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture`, so the browser's own capture, with its echo cancellation and noise suppression, hears a file in place of a device. That processing changes the sound on purpose. So this lane asks for what a provider needs (the rate named, the pace, the level, the rhythm) and not for the samples back.

## Cassettes

A stand-in says what its author thought the provider says. A cassette says what the provider did say: every message of a real session, in order, with the time between them ([`cassette.ts`](https://github.com/bascikdev/bascik/blob/main/ai/voice-lab/cassette.ts)).

Every `.jsonl` file in [`ai/e2e/cassettes/`](https://github.com/bascikdev/bascik/tree/main/ai/e2e/cassettes) is played back on every run. The reader's typed messages are typed again, and the provider's messages arrive with their recorded gaps. The call must stay up, play the model's voice once, show its words, and let go of everything it held.

### Record a cassette

Recording needs a provider key. From the repository root:

```sh
GEMINI_API_KEY=... yarn workspace @bascik/ai voice:record gemini-live --out e2e/cassettes/books.jsonl
```

This starts a recorder in front of the provider, and the demo pointed at the recorder. Open the address the demo prints, hold one call, hang up, and press Ctrl+C.

> **Read a cassette before committing it.** A cassette keeps the provider's messages whole, its audio included, so what the reader typed and what the model said are in it as text. It does not keep the reader's microphone audio, only its size, and tokens, keys, and session ids are replaced before anything is written. A minute of the model's voice is about 4 MB.

## The live lane

The live lane calls the real providers, so it needs keys and spends credits. It runs for each provider that is set:

```sh
GEMINI_API_KEY=... yarn workspace @bascik/ai e2e:live
AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com yarn workspace @bascik/ai e2e:live
```

It holds three short calls with each provider: a spoken question, a long answer the reader cuts in on, and a typed request that makes the model show components. It checks the provider's transcript by word error rate, the wait before the answer, and the barge-in stop, and saves each call as a cassette.

The speech is real. The lane looks for your own recording of each sentence first, and on macOS makes one with the `say` command when there is none. `yarn workspace @bascik/ai voice:sentences` lists the sentences and the file names. Synthesized speech is cleaner than a person's and easier to recognize, so recordings of a real voice, in a real room, are the better test.

## Adding a test

A test that needs sound in or out starts like the ones in [`voice-lab.spec.ts`](https://github.com/bascikdev/bascik/blob/main/ai/e2e/voice-lab.spec.ts): it resets the stand-in, installs the lab script, starts a call, says a signal, and reads back what the loudspeaker played and what the provider received. It then asserts on the helpers in `signal.ts`. When a test needs the provider to do something new, add a `lab:` message to the stand-ins. The lab's [README](https://github.com/bascikdev/bascik/blob/main/ai/voice-lab/README.md) has the helper names and a starting snippet.

## What the lab does not test

- **Other browsers.** The lanes run in Chromium. Firefox's fake microphone is a tone, and WebKit has no file option in Playwright. The lab microphone would run in both, and is not wired up yet.
- **A real loudspeaker and a real room.** Echo of the model's own voice into the microphone, a Bluetooth headset that changes rate during a call, and a phone call that takes the audio away are simulated at most, as a suspended audio context or an ended track.
- **The model's judgment.** Whether an answer is good depends on the provider and the prompt. The live lane only checks that a call works.
- **Noise and accents.** The signal can be mixed with noise at a level, and the level detector is tested with it, but the live lane says clean sentences. A matrix of noise levels and voices is the next thing to add.
