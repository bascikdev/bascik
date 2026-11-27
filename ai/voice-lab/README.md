# The voice lab

How `@bascik/ai` tests a voice call as sound, with nobody at a microphone.

A voice call can look right and be wrong. The status says "Listening.", the caption moves, the test passes, and the reader hears a voice at the wrong pitch, a gap every second, or a model that keeps talking after they cut in. The lab tests what a reader hears and what a provider is sent, not only what the page shows.

Nothing here ships in the package. The lab is the `voice-lab/` folder, the specs that use it in `e2e/` and `live/`, and two stand-in providers.

## The four lanes

| Lane            | Command                              | Provider                              | Microphone                                | Runs in CI                     |
| --------------- | ------------------------------------ | ------------------------------------- | ----------------------------------------- | ------------------------------ |
| Lab             | `yarn ai:e2e` (`voice-lab`)          | Stand-in, steered by the test         | A stream the test says sound into         | Yes                            |
| Real microphone | `yarn ai:e2e` (`voice-capture`)      | Stand-in                              | Chromium's own `getUserMedia`, fed a file | Yes                            |
| Cassette        | `yarn ai:e2e` (`voice-cassette`)     | A recorded real session, played back  | None needed                               | Yes                            |
| Live            | `yarn workspace @bascik/ai e2e:live` | The real provider, through a recorder | A stream the test says real speech into   | No: needs keys, spends credits |

The first three need no key, no device and no network. They measure sound in real time, to the sample, so on a shared CI runner, where a browser's audio thread can be kept waiting, a spec gets up to three tries; Playwright reports one that needed a retry as flaky. On a developer's machine a spec gets one try. The live lane is run by hand, and each run leaves cassettes that the cassette lane then plays back for nothing.

## What is measured

Every lab spec reports its numbers with the run (`--reporter=list` or the HTML report shows them as `measured` annotations), so a slow drift is seen before it is a failure.

| Measurement              | How it is taken                                                                                                                      | Limit                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Capture match            | A known signal is said into the microphone. The provider's copy is lined up with it and compared, whole and in every quarter second. | Over 0.95 in every quarter second |
| Capture clock slip       | How far any quarter second had to be moved to match. Two sound clocks differ by a few samples; a lost block is 8 ms.                 | Under 4 ms                        |
| Capture gain             | The copy's loudness over the original's.                                                                                             | 0.85 to 1.15                      |
| Capture pace             | Seconds of sound received over seconds passed. A page that captured at 48 kHz and said 16 would send three times too much.           | 0.93 to 1.07                      |
| Playback match           | The provider sends a known voice. What the page sends to the loudspeaker is recorded sample for sample and compared.                 | Over 0.99 of 1                    |
| Playback gaps and clicks | One stretch of sound as long as the voice, and no jump between samples larger than the voice's own.                                  | None                              |
| Barge-in stop            | From the reader's first sound into the microphone to the last sample of the model's voice out of the loudspeaker.                    | Under 700 ms                      |
| Hang-up stop             | From the press to the last sample played.                                                                                            | Under 300 ms                      |
| Nothing held             | Live microphone tracks, open audio contexts and open sockets after a call ends, however it ended.                                    | 0, 0 and 0                        |
| Word error rate (live)   | The provider's own transcript of a spoken sentence against the sentence.                                                             | At most 34%                       |
| Answer starts (live)     | From the end of the reader's sentence to the model's first sound.                                                                    | Under 10 s                        |

On a developer laptop the stand-in lanes measure a barge-in stop of 50 to 100 ms and a hang-up stop under 30 ms. Those are the page's own share: the provider's time to notice speech is added in a real call, which the live lane measures.

## How it works

### A signal instead of a recording

`signal.ts` makes a speech-like signal from a formula: a pitched buzz with moving formants, in syllables, in words with gaps. It has speech's level, rhythm and spectrum, which is what capture, playback and level detection work on, and the same arguments always give the same samples. So no audio file is committed, and any piece of it can be told from any other, which is what lets a test say "this quarter second is missing".

`findSignal(recording, signal, rate)` finds the signal in a recording and gives a score for the whole, the worst score of any quarter second, the gain, and the slip. The worst quarter second is the number that matters: a dropped, repeated or reordered piece moves everything after it, so its stretch scores near 0 while the whole can still look fair.

### A microphone the test speaks into

`browser.ts` is a script a spec adds to the page (`installLab(page)`). It replaces `getUserMedia` with a stream the test plays sound into on cue: `say(page, samples, rate)`. The page still opens a capture context, resamples, measures the level, cuts the sound into pieces and sends them, as it does a real microphone's. The test can also deny the microphone, delay the answer, and unplug it mid-call.

The same script records everything the page sends to an audio output, with an audio worklet, by sample position. `played(page)` gives it back with the time its first sample was played, so a test can say when the model's voice started and stopped to within a few milliseconds.

### Stand-in providers a test can steer

`e2e/fake-live-server.ts` (Gemini Live) and `e2e/fake-azure-server.ts` (Azure Voice Live) keep the microphone audio they receive, and `GET /__lab/heard` gives it to the test. A typed message that starts with `lab:` steers a session:

| Message              | What the stand-in does                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `lab:speak 4`        | Says four seconds of a known voice, and stops if the reader cuts in      |
| `lab:late 4`         | The same, and a few pieces still arrive after the cut (Azure)            |
| `lab:slow 2`         | Sends the voice slower than it plays                                     |
| `lab:drop`           | Starts speaking, then cuts the connection with no close frame            |
| `lab:close 1011 Why` | Closes with that code and reason                                         |
| `lab:garbage`        | Sends a frame that is not JSON and audio that is not base64, then speaks |

### The browser's real capture

One lane does not replace `getUserMedia`. The `real-microphone` Playwright project starts Chromium with `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture`, so the browser's own capture, with its echo canceling and noise suppression, hears a file in place of a device. That processing changes the sound on purpose, so this lane asks for what a provider needs (the rate named, the pace, the level, the rhythm) and not for the samples back.

### Cassettes

A stand-in says what its author thought the provider says. A cassette (`cassette.ts`) says what the provider did say: every message of a real session, in order, with the time between them.

Record one:

```sh
GEMINI_API_KEY=... yarn workspace @bascik/ai voice:record gemini-live --out e2e/cassettes/books.jsonl
```

This starts a recorder in front of the provider and the demo pointed at the recorder. Open the address the demo prints, hold one call, hang up, and press Ctrl+C. Every `.jsonl` in `e2e/cassettes/` is then played back by `e2e/voice-cassette.spec.ts` on every run: the reader's typed messages are typed again, the provider's messages arrive with their recorded gaps, and the call must stay up, play the model's voice once, show its words and let everything go.

A cassette keeps the provider's messages whole, its audio included. It does not keep the reader's microphone audio, only its size, and tokens, keys and session ids are replaced before anything is written. What the reader typed and what the model said are in it as text: read a cassette before committing it. A minute of the model's voice is about 4 MB.

### The live lane

```sh
GEMINI_API_KEY=... yarn workspace @bascik/ai e2e:live
AZURE_VOICE_LIVE_ENDPOINT=https://<resource>.services.ai.azure.com yarn workspace @bascik/ai e2e:live
```

`live/voice-live.spec.ts` holds three short calls with each provider that is set: a spoken question, a long answer the reader cuts in on, and a typed request that makes the model show components. It checks the provider's transcript by word error rate, the wait before the answer, and the barge-in stop, and saves each call as a cassette in `e2e/cassettes/live/`.

The speech is real. `speech.ts` looks for your own recording of each sentence first, and on macOS makes it with the `say` command when there is none. `yarn workspace @bascik/ai voice:sentences` lists the sentences and the file names. Synthesized speech is cleaner than a person's and easier to recognize, so recordings of a real voice, in a real room, are the better test. Recordings in `voice-lab/speech/` are ignored by git unless you remove the `.gitignore` there.

## Adding a test

A spec that needs sound in or out starts like the ones in `e2e/voice-lab.spec.ts`:

```ts
await resetLab(provider, false); // no scripted first turn
await installLab(page);
await page.goto("/");
// ...start a call...
await say(page, speechLike(2, 16_000), 16_000); // the reader speaks
const out = await played(page); // what the loudspeaker played
const got = await heard(provider); // what the provider received
```

Then assert on `findSignal`, `soundStretches`, `largestJump` and `rms` from `signal.ts`. Add a `lab:` message to the stand-ins when a test needs the provider to do something new.

## What the lab does not test

- **Other browsers.** The lanes run in Chromium. Firefox's fake microphone is a tone, and WebKit has no file option in Playwright; the lab microphone (a replaced `getUserMedia`) would run there, and is not wired up yet.
- **A real loudspeaker and a real room.** Echo of the model's own voice into the microphone, a Bluetooth headset that changes rate mid-call, and a phone call that takes the audio away are simulated at most (a suspended context, an ended track).
- **The model's judgment.** Whether the answer is good is the provider's and the prompt's. `stress/adherence.ts` measures the format; the live lane only checks that a call works.
- **Noise and accents.** `signal.ts` can mix noise at a level (`noise`, `mix`), and the level detector is tested with it, but the live lane says clean sentences. A matrix of noise levels and voices is the next thing to add.
