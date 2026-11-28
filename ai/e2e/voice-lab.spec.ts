/**
 * The voice lab: a voice call tested as sound, with nobody at a microphone.
 *
 * chat.spec.ts checks what a call shows. These specs check what it sends and
 * what it plays. A speech-like recording is said into the page's microphone,
 * and the stand-in provider's copy of it is compared with the original. The
 * provider answers in a known voice, and what the page sends to the
 * loudspeaker is recorded and compared with that. So a wrong sample rate, a
 * dropped or repeated piece, a gap, or a voice that keeps talking after the
 * reader cut in fails a test here, though the page would look right.
 *
 * See voice-lab/README.md for the method and what each number means.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  findSignal,
  largestJump,
  percentile,
  rms,
  soundStretches,
  speechLike,
} from "../voice-lab/signal.ts";
import { labVoice, LATE, PAUSED, VOICE_RATE } from "./fake-lab.ts";
import {
  heard,
  installLab,
  labCount,
  openContexts,
  played,
  resetLab,
  say,
  setMicrophone,
} from "./lab-helpers.ts";

/** What the page captures the microphone at. */
const MIC_RATE = 16_000;
/** What a reader says: three seconds, in a voice that is not the model's. */
const READER = speechLike(3, MIC_RATE, { pitch: 120, rate: 4.2 });
/** A word or two, to cut in with. */
const CUT_IN = speechLike(0.8, MIC_RATE, { pitch: 120, rate: 4.2 });

const withScripts = (): boolean => test.info().project.name === "js";

/**
 * These specs measure sound in real time, to the sample. A shared CI runner
 * can keep a browser's audio thread waiting for longer than a block of
 * sound, which leaves a gap that is the machine's and not the page's. A
 * second and third try are allowed there, and only there: a fault in the
 * page fails every try, and Playwright reports a spec that needed one as
 * flaky. On a developer's machine a spec gets one try.
 */
test.describe.configure({ retries: process.env.CI ? 2 : 0 });

/** Record a measurement in the report, so a run shows the numbers and not only pass or fail. */
const measured = (name: string, value: number, unit: string): void => {
  test.info().annotations.push({
    type: "measured",
    description: `${name}: ${Number(value.toFixed(3))} ${unit}`,
  });
};

async function type(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
}

/** Wait until the loudspeaker has played sound, and then been quiet for a while. */
async function playedOut(page: Page, quietFor = 0.6): Promise<void> {
  await expect
    .poll(
      async () => {
        const { samples, sampleRate } = await played(page);
        const stretches = soundStretches(samples, sampleRate);
        const last = stretches.at(-1);
        return last ? samples.length / sampleRate - last.end : -1;
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(quietFor);
}

/** Wait until the loudspeaker has played `seconds` of sound. */
async function playedFor(page: Page, seconds: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const { samples, sampleRate } = await played(page);
        return soundStretches(samples, sampleRate).reduce(
          (total, stretch) => total + stretch.end - stretch.start,
          0,
        );
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThan(seconds);
}

/**
 * How the provider's copy of the reader's sentence compares with the
 * sentence. On a developer's machine every quarter second of it must match,
 * moved by no more than two sound clocks differ (4 ms): a block the page
 * lost is 8 ms, and fails. A CI runner has no sound device, and the path
 * from the lab's microphone into the page, which is the browser's and not
 * the page's, loses a block there now and then, the same on every try. So
 * on a runner up to two quarter seconds may be spoiled, and the rest must
 * still match where they landed; what was found is printed when any is.
 */
function captured(samples: Float32Array): ReturnType<typeof findSignal> {
  const strict = findSignal(samples, READER, MIC_RATE, 0.25, 64);
  if (!process.env.CI) {
    expect(strict.worst).toBeGreaterThan(0.95);
    expect(strict.slip).toBeLessThan(64);
    return strict;
  }
  const loose = findSignal(samples, READER, MIC_RATE, 0.25, 512);
  const spoiled = loose.stretches.filter((stretch) => stretch.score <= 0.95);
  if (strict.worst <= 0.95) {
    console.log(
      `[voice lab] capture, each quarter second as score@samples moved: ${loose.stretches
        .map((stretch) => `${stretch.score.toFixed(2)}@${stretch.moved}`)
        .join(" ")}`,
    );
  }
  expect(spoiled.length).toBeLessThanOrEqual(2);
  return loose;
}

/**
 * Say `samples` into the microphone once it carries sound. A call says it is
 * listening as soon as the microphone is open; the first sound through a
 * newly opened one can be clipped, by more on a slow machine. So the
 * provider must have had a second of the room's quiet before the reader speaks.
 */
const speakTo =
  (provider: string) =>
  async (page: Page, samples: Float32Array): ReturnType<typeof say> => {
    await expect
      .poll(async () => (await heard(provider)).sizes.length, {
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(10);
    return say(page, samples, MIC_RATE);
  };

for (const provider of ["gemini-live", "azure-voice-live"]) {
  test.describe(`the voice lab (${provider})`, () => {
    const speak = speakTo(provider);
    test.beforeEach(async ({ page }) => {
      test.skip(!withScripts(), "a voice call is a script");
      await resetLab(provider, false);
      await page.route("**/api/voice-session", (route) =>
        route.continue({
          url: `${route.request().url()}?provider=${provider}`,
        }),
      );
      await installLab(page);
      await page.goto("/");
      await page.getByTestId("chat-sidebar-new").click();
      await expect(page.getByTestId("chat-welcome")).toBeVisible();
    });

    test.afterEach(async () => {
      await resetLab(provider, true);
    });

    const status = (page: Page) => page.getByTestId("voice-call-status");
    const toggle = (page: Page) => page.getByTestId("voice-call-toggle");

    async function startCall(page: Page): Promise<void> {
      await toggle(page).click();
      await expect(status(page)).toHaveText("Listening.", { timeout: 15_000 });
    }

    /** Nothing a call held is still held. */
    async function expectAllLetGo(page: Page): Promise<void> {
      await expect.poll(() => labCount(page, "liveTracks()")).toBe(0);
      await expect.poll(() => openContexts(page)).toEqual([]);
      await expect.poll(() => labCount(page, "openSockets()")).toBe(0);
    }

    test("sends the provider what the microphone heard: every sample, once, at the rate it says", async ({
      page,
    }) => {
      await startCall(page);
      // The open microphone of a quiet room, for a moment, then a sentence.
      await page.waitForTimeout(500);
      await speak(page, READER);
      await page.waitForTimeout(3600);
      const got = await heard(provider);
      await toggle(page).click();

      if (provider === "gemini-live") {
        // The provider is told the rate with every piece.
        expect(got.formats).toEqual(["audio/pcm;rate=16000"]);
      }
      // Whole samples, in pieces of about a tenth of a second.
      expect(got.sizes.every((size) => size > 0 && size % 2 === 0)).toBe(true);
      expect(percentile(got.sizes, 0.5)).toBeGreaterThanOrEqual(3200);
      expect(Math.max(...got.sizes)).toBeLessThanOrEqual(6400);

      // The sentence arrived as it was said: the same shape overall, and in
      // every quarter second of it, so nothing was dropped, repeated or
      // reordered on the way, and it was not sped up or slowed down.
      // The lab's microphone and the page's capture run on two sound clocks,
      // which may differ by a few samples over a sentence: that much is
      // allowed for (4 ms), and no more. A lost block of capture is 8 ms.
      const match = captured(got.samples);
      measured("capture match", match.score, "of 1");
      measured("capture worst quarter second", match.worst, "of 1");
      measured("capture gain", match.gain, "x");
      measured("capture clock slip", (match.slip / MIC_RATE) * 1000, "ms");
      // Every quarter second is judged where it best matches, within the
      // slip allowed. The score of the whole is at one place for all of it,
      // so a slip within the allowance lowers it: it is reported, not judged.
      expect(match.gain).toBeGreaterThan(0.85);
      expect(match.gain).toBeLessThan(1.15);

      // Before the sentence the room was quiet, and stayed quiet in the copy.
      expect(rms(got.samples, 0, Math.max(0, match.lag - 800))).toBeLessThan(
        0.002,
      );

      // Sound arrives as fast as it is made: as many seconds of it as passed.
      const elapsed = (got.arrivals.at(-1)! - got.arrivals[0]!) / 1000;
      const seconds = (got.samples.length - got.sizes[0]! / 2) / MIC_RATE;
      measured("capture pace", seconds / elapsed, "x real time");
      expect(seconds / elapsed).toBeGreaterThan(0.93);
      expect(seconds / elapsed).toBeLessThan(1.07);
      const waits = got.arrivals
        .slice(1)
        .map((at, index) => at - got.arrivals[index]!);
      measured("capture longest wait", Math.max(...waits), "ms");
      expect(percentile(waits, 0.95)).toBeLessThan(300);
    });

    test("plays the model's voice whole: in order, with no gap, click or overlap", async ({
      page,
    }) => {
      await startCall(page);
      await type(page, "lab:speak 4");
      await playedOut(page);
      const out = await played(page);
      expect(await page.evaluate("window.__voiceLab.tapLate")).toBe(false);
      await toggle(page).click();

      expect(out.sampleRate).toBe(VOICE_RATE);
      const voice = labVoice(4);
      const match = findSignal(out.samples, voice, VOICE_RATE);
      measured("playback match", match.score, "of 1");
      measured("playback worst quarter second", match.worst, "of 1");
      expect(match.score).toBeGreaterThan(0.995);
      expect(match.worst).toBeGreaterThan(0.99);
      expect(match.gain).toBeGreaterThan(0.98);
      expect(match.gain).toBeLessThan(1.02);
      // One stretch of sound as long as the voice: nothing before, after or between.
      const stretches = soundStretches(out.samples, VOICE_RATE);
      expect(stretches).toHaveLength(1);
      expect(stretches[0]!.end - stretches[0]!.start).toBeGreaterThan(3.9);
      expect(stretches[0]!.end - stretches[0]!.start).toBeLessThan(4.05);
      // No click where one piece meets the next.
      expect(largestJump(out.samples)).toBeLessThan(largestJump(voice) * 1.2);
    });

    test("plays every piece once when the voice arrives slower than it plays", async ({
      page,
    }) => {
      await startCall(page);
      await type(page, "lab:slow 2");
      await playedOut(page, 1);
      const out = await played(page);
      await toggle(page).click();

      const voice = labVoice(2);
      // Pieces that come late leave gaps, but each is played once and whole:
      // the same sound in total, and never two pieces on top of each other.
      const energy = (samples: Float32Array): number =>
        samples.reduce((total, sample) => total + sample * sample, 0);
      expect(energy(out.samples) / energy(voice)).toBeGreaterThan(0.97);
      expect(energy(out.samples) / energy(voice)).toBeLessThan(1.03);
      const loudest = out.samples.reduce(
        (most, sample) => Math.max(most, Math.abs(sample)),
        0,
      );
      expect(loudest).toBeLessThanOrEqual(0.51);
    });

    test("stops talking when the reader cuts in", async ({ page }) => {
      await startCall(page);
      await type(page, "lab:speak 8");
      await playedFor(page, 1.5);
      await expect(page.getByTestId("voice-call-caption")).not.toBeEmpty();
      const cut = await speak(page, CUT_IN);
      await page.waitForTimeout(2500);
      const out = await played(page);

      const stretches = soundStretches(out.samples, out.sampleRate);
      const stoppedAt = out.startedAt + stretches.at(-1)!.end * 1000;
      const latency = stoppedAt - cut.at;
      measured("barge-in stop", latency, "ms after the reader spoke");
      // The voice was cut off well before its eight seconds were up, soon
      // after the reader's first sound, and it stayed off.
      expect(stretches).toHaveLength(1);
      expect(stretches[0]!.end - stretches[0]!.start).toBeLessThan(6);
      expect(latency).toBeGreaterThan(0);
      expect(latency).toBeLessThan(700);
      expect(out.now - stoppedAt).toBeGreaterThan(1500);
      // The caption does not go on showing words nobody is saying.
      await expect(page.getByTestId("voice-call-caption")).toBeEmpty();
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("stops talking at once when the reader hangs up", async ({ page }) => {
      await startCall(page);
      await type(page, "lab:speak 8");
      await playedFor(page, 1);
      const hungUpAt = (await page.evaluate("performance.now()")) as number;
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await page.waitForTimeout(600);
      const out = await played(page);
      const stretches = soundStretches(out.samples, out.sampleRate);
      const latency = out.startedAt + stretches.at(-1)!.end * 1000 - hungUpAt;
      measured("hang-up stop", latency, "ms after the press");
      expect(latency).toBeLessThan(300);
      await expectAllLetGo(page);
    });

    test("ends the call, and lets everything go, when the connection is cut", async ({
      page,
    }) => {
      await startCall(page);
      await type(page, "lab:drop");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false", {
        timeout: 15_000,
      });
      // The reader is told, in words.
      await expect(status(page)).not.toBeEmpty();
      await expect(page.getByTestId("voice-call-meter")).toBeHidden();
      await expectAllLetGo(page);
      // And the next call is a new one that works.
      await startCall(page);
      await type(page, "lab:speak 1");
      await playedFor(page, 0.8);
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("says why when the provider ends the call", async ({ page }) => {
      await startCall(page);
      await type(page, "lab:close 1011 The model is busy.");
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false", {
        timeout: 15_000,
      });
      await expect(status(page)).not.toBeEmpty();
      if (provider === "gemini-live") {
        await expect(status(page)).toHaveText("The model is busy.");
      }
      await expectAllLetGo(page);
    });

    test("goes on with the call when the provider sends something unreadable", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await startCall(page);
      await type(page, "lab:garbage");
      // The voice that follows the unreadable messages is still played.
      await playedFor(page, 2);
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await toggle(page).click();
      expect(errors).toEqual([]);
      await expectAllLetGo(page);
    });

    test("tells the reader when the microphone goes away, and the call goes on by typing", async ({
      page,
    }) => {
      await startCall(page);
      await expect(page.getByTestId("voice-call-meter")).toBeVisible();
      await page.evaluate("window.__voiceLab.unplug()");
      await expect(status(page)).toHaveText("No microphone: type to talk.");
      await expect(page.getByTestId("voice-call-meter")).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await type(page, "lab:speak 1");
      await playedFor(page, 0.8);
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("holds nothing after any number of presses", async ({ page }) => {
      // Fast enough that most presses land while a call is connecting.
      for (let press = 0; press < 9; press++) {
        await toggle(page).click();
        await page.waitForTimeout(press * 35);
      }
      // An odd number of presses: the last one started a call.
      await expect(status(page)).toHaveText("Listening.", { timeout: 15_000 });
      expect(await labCount(page, "liveTracks()")).toBe(1);
      expect(await labCount(page, "openSockets()")).toBe(1);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expectAllLetGo(page);
    });

    test("lets the microphone go when the call ends while the browser is still asking for it", async ({
      page,
    }) => {
      await setMicrophone(page, "lab", 1500);
      await toggle(page).click();
      await expect(status(page)).toHaveText("Connected. Type to talk.", {
        timeout: 15_000,
      });
      await toggle(page).click();
      // The browser answers after the call is over.
      await expect.poll(() => labCount(page, "tracks.length")).toBe(1);
      await expectAllLetGo(page);
      await expect(status(page)).toBeEmpty();
    });

    test("starts playing again when the browser had put the sound to sleep", async ({
      page,
    }) => {
      await startCall(page);
      // What a phone does when a call comes in, or a browser to a tab it rests.
      await page.evaluate(
        "Promise.all(window.__voiceLab.contexts.map((context) => context.suspend()))",
      );
      await type(page, "lab:speak 2");
      await playedFor(page, 1.5);
      await playedOut(page);
      const out = await played(page);
      const match = findSignal(out.samples, labVoice(2), VOICE_RATE);
      expect(match.worst).toBeGreaterThan(0.99);
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("stores what was said when the reader leaves the page mid-call", async ({
      page,
    }) => {
      await startCall(page);
      await type(page, "lab:speak 6");
      await expect(page.getByTestId("turn-voice")).toContainText(
        "The lab voice speaks.",
      );
      await page.reload();
      // The turn is sent as the page is left, and the next page is asked for
      // at the same moment: whichever the server takes first, the turn is kept.
      await expect(async () => {
        await page.reload();
        await expect(
          page.getByTestId("turn-assistant").locator(".spoken"),
        ).toHaveText("The lab voice speaks.", { timeout: 1000 });
      }).toPass({ timeout: 15_000 });
    });

    /* ---- Mute: in the call, and unheard ---- */

    const mute = (page: Page) => page.getByTestId("voice-call-mute");

    test("sends the provider nothing the reader says while muted, and all of it after", async ({
      page,
    }) => {
      await expect(mute(page)).toBeHidden();
      await startCall(page);
      await expect(
        page.getByRole("button", { name: "Mute microphone", pressed: false }),
      ).toBeVisible();
      const atPress = (await heard(provider)).sizes.length;
      // By keyboard, as by pointer.
      await mute(page).focus();
      await page.keyboard.press("Space");
      await expect(mute(page)).toHaveAttribute("aria-pressed", "true");
      await expect(status(page)).toHaveText(
        "Muted. The model cannot hear you.",
      );
      expect(await labCount(page, "enabledTracks()")).toBe(0);
      // Silence follows the press for longer than the longest pause a
      // provider can be told to wait (3 s), and then nothing at all.
      await page.waitForTimeout(4200);
      const before = await heard(provider);
      await speak(page, READER);
      await page.waitForTimeout(3600);
      const during = await heard(provider);
      expect(during.sizes.length).toBe(before.sizes.length);
      const tail = before.sizes.length - atPress;
      measured("pieces sent after the mute", tail, "pieces");
      expect(tail).toBeGreaterThanOrEqual(32);
      expect(tail).toBeLessThanOrEqual(38);
      // None of the reader's sentence is in what the provider has.
      expect(rms(during.samples)).toBeLessThan(0.002);
      const told = during.events.map((event) => event.type);
      if (provider === "gemini-live") {
        // The provider is told the microphone's sound has ended, once.
        expect(told.filter((type) => type === "audioStreamEnd")).toHaveLength(
          1,
        );
      } else {
        expect(told).not.toContain("clear");
      }
      // The level shows nothing of a voice the model cannot hear.
      await expect(page.getByTestId("voice-call-meter")).toHaveAttribute(
        "data-level",
        "0.00",
      );
      await expect(status(page)).not.toHaveText("Hearing you…");

      await mute(page).click();
      await expect(mute(page)).toHaveAttribute("aria-pressed", "false");
      await expect(status(page)).toHaveText("Listening.");
      expect(await labCount(page, "enabledTracks()")).toBe(1);
      await page.waitForTimeout(300);
      await speak(page, READER);
      await page.waitForTimeout(3600);
      const after = await heard(provider);
      const since = after.samples.subarray(during.samples.length);
      const match = captured(since);
      measured(
        "capture worst quarter second after unmuting",
        match.worst,
        "of 1",
      );
      expect(match.gain).toBeGreaterThan(0.85);
      expect(match.gain).toBeLessThan(1.15);
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("a muted reader does not cut the model off, and can still type", async ({
      page,
    }) => {
      await startCall(page);
      await mute(page).click();
      await type(page, "lab:speak 4");
      await playedFor(page, 1);
      await speak(page, CUT_IN);
      await playedOut(page);
      const out = await played(page);
      const stretches = soundStretches(out.samples, out.sampleRate);
      expect(stretches).toHaveLength(1);
      expect(stretches[0]!.end - stretches[0]!.start).toBeGreaterThan(3.5);
      const told = (await heard(provider)).events.map((event) => event.type);
      expect(told).not.toContain("cut");
      // The line goes back to saying the reader is muted.
      await expect(status(page)).toHaveText(
        "Muted. The model cannot hear you.",
      );
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("hanging up while muted lets everything go, and the next call is not muted", async ({
      page,
    }) => {
      await startCall(page);
      await mute(page).focus();
      await page.keyboard.press("Enter");
      await expect(mute(page)).toHaveAttribute("aria-pressed", "true");
      await toggle(page).click();
      await expectAllLetGo(page);
      await expect(mute(page)).toBeHidden();
      // The keyboard's place went to the button that is still there.
      await expect(toggle(page)).toBeFocused();
      await startCall(page);
      await expect(mute(page)).toHaveAttribute("aria-pressed", "false");
      // The lab's microphone takes a moment to carry sound into a second
      // call on one page: the sentence is said once it does.
      await page.waitForTimeout(1000);
      await speak(page, READER);
      await page.waitForTimeout(3600);
      const got = await heard(provider);
      captured(got.samples);
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("a microphone that goes away while muted is said to be gone", async ({
      page,
    }) => {
      await startCall(page);
      await mute(page).click();
      await page.evaluate("window.__voiceLab.unplug()");
      await expect(status(page)).toHaveText("No microphone: type to talk.");
      await expect(mute(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    /* ---- A reader who pauses mid-question ---- */

    for (const early of [false, true]) {
      test(`keeps a question said in two parts as one turn${early ? ", and takes back a reply nobody heard" : ""}`, async ({
        page,
      }) => {
        const stored: string[] = [];
        page.on("request", (request) => {
          if (!request.url().endsWith("/api/voice-turn")) return;
          const reader = /name="reader"\r\n\r\n([\s\S]*?)\r\n--/.exec(
            request.postData() ?? "",
          );
          stored.push(
            reader?.[1] ??
              new URLSearchParams(request.postData() ?? "").get("reader") ??
              "",
          );
        });
        await startCall(page);
        await type(page, `lab:paused${early ? " yep" : ""}`);
        const whole = `${PAUSED.first} ${PAUSED.second}`;
        await expect(page.getByTestId("turn-user").last()).toHaveText(whole);
        await expect(page.getByTestId("turn-voice").last()).toContainText(
          PAUSED.answer,
        );
        // The command, then the question: two turns of the reader's, and an
        // answer to each. The reply that was cut off is not one of them.
        await expect(page.getByTestId("turn-user")).toHaveCount(2);
        await expect(page.getByTestId("turn-voice")).toHaveCount(2);
        await expect(page.getByTestId("chat-thread")).not.toContainText(
          PAUSED.early,
        );
        // And it is stored as it is shown.
        await expect.poll(() => stored).toContain(whole);
        await toggle(page).click();
        await expectAllLetGo(page);
      });
    }

    /* ---- The word being said, marked in the answer ---- */

    test("marks the word being said in the answer, and nothing once the voice is over", async ({
      page,
    }) => {
      await startCall(page);
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __spoken: string[] }).__spoken = seen;
        new MutationObserver((changes) => {
          for (const change of changes) {
            const word = (change.target as HTMLElement).dataset.spokenWord;
            if (word && seen.at(-1) !== word) seen.push(word);
          }
        }).observe(document.body, {
          subtree: true,
          attributes: true,
          attributeFilter: ["data-spoken-word"],
        });
      });
      await type(page, "lab:speak 3");
      const reply = page.getByTestId("turn-voice").last();
      const said = reply.getByTestId("voice-call-said");
      await expect(said).toHaveAttribute("data-spoken-word", /\S/);
      // It is a mark on the answer's own text: the same word, in that answer.
      const mark = await page.evaluate(() => {
        const range = [...(CSS.highlights.get("voice-call-word") ?? [])][0] as
          Range | undefined;
        const holder = range?.startContainer.parentElement;
        return {
          text: range?.toString(),
          word: holder?.dataset.spokenWord,
          at: holder?.dataset.testid,
          elements: holder?.childElementCount,
        };
      });
      expect(mark.text).toBe(mark.word);
      expect(mark.at).toBe("voice-call-said");
      // Nothing was put into the answer to do it.
      expect(mark.elements).toBe(0);
      await playedOut(page);
      await expect(said).not.toHaveAttribute("data-spoken-word");
      expect(
        await page.evaluate(
          () => CSS.highlights.get("voice-call-word")?.size ?? 0,
        ),
      ).toBe(0);
      // Each word of the sentence had its turn. Where the provider does not
      // time its words the place is estimated from how much has played, and
      // can step back a word while the voice is still arriving.
      const seen = (await page.evaluate("window.__spoken")) as string[];
      expect([...new Set(seen)].join(" ")).toBe("The lab voice speaks.");
      await expect(reply).toHaveText("The lab voice speaks.");
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    /* ---- A call nobody is speaking on ---- */

    /** Set how soon a quiet call asks, and how soon after that it ends, before it starts. */
    const idleAfter = (page: Page, seconds: string, warning = "2") =>
      page.getByTestId("voice-call").evaluate(
        (call, [idle, warn]) => {
          (call as HTMLElement).dataset.idleSeconds = idle;
          (call as HTMLElement).dataset.idleWarningSeconds = warn;
        },
        [seconds, warning],
      );
    const stay = (page: Page) => page.getByTestId("voice-call-stay");

    test("asks whether anyone is there, and ends a call nobody speaks on", async ({
      page,
    }) => {
      await idleAfter(page, "2");
      await startCall(page);
      await expect(stay(page)).toBeHidden();
      await expect(status(page)).toHaveText(
        "Still there? The call is about to end.",
        { timeout: 6000 },
      );
      await expect(stay(page)).toBeVisible();
      await expect(status(page)).toHaveText(
        "The call ended because nobody spoke.",
        { timeout: 6000 },
      );
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect(stay(page)).toBeHidden();
      await expectAllLetGo(page);
    });

    test("stays on when the reader says so, or when the model speaks", async ({
      page,
    }) => {
      await idleAfter(page, "2", "3");
      await startCall(page);
      await expect(stay(page)).toBeVisible({ timeout: 6000 });
      await stay(page).click();
      await expect(stay(page)).toBeHidden();
      await expect(status(page)).toHaveText("Listening.");
      // A voice on the line is the call in use for as long as it plays.
      await type(page, "lab:speak 5");
      await playedFor(page, 4);
      await expect(stay(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      // Quiet again, it asks again; a muted call is asked the same.
      await mute(page).click();
      await expect(stay(page)).toBeVisible({ timeout: 10_000 });
      await mute(page).click();
      await expect(stay(page)).toBeHidden();
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("does not ask while the reader is speaking", async ({ page }) => {
      test.skip(provider !== "azure-voice-live", "the stand-in for it");
      await idleAfter(page, "2", "1");
      await startCall(page);
      await type(page, "lab:hearing");
      await expect(status(page)).toHaveText("Hearing you…", {
        timeout: 10_000,
      });
      await page.waitForTimeout(4500);
      await expect(status(page)).toHaveText("Hearing you…");
      await expect(stay(page)).toBeHidden();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("words written down after their turn was over do not start the next one", async ({
      page,
    }) => {
      test.skip(provider !== "azure-voice-live", "the stand-in for it");
      await startCall(page);
      await type(page, "lab:latewords");
      await expect(page.getByTestId("voice-call-said").last()).toHaveText(
        LATE.answer,
        { timeout: 10_000 },
      );
      await page.waitForTimeout(1000);
      await expect(
        page.getByTestId("turn-user").filter({ hasText: LATE.words }),
      ).toHaveCount(0);
      await type(page, "lab:speak 1");
      await expect(page.getByTestId("turn-user").last()).toHaveText(
        "lab:speak 1",
      );
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("a second call does not start with the first call's caption", async ({
      page,
    }) => {
      const caption = page.getByTestId("voice-call-caption");
      await startCall(page);
      await type(page, "lab:speak 8");
      await playedFor(page, 1);
      await expect(caption).not.toBeEmpty();
      await toggle(page).click();
      await expectAllLetGo(page);
      await startCall(page);
      for (let checks = 0; checks < 6; checks++) {
        await expect(caption).toBeEmpty();
        await expect(caption).not.toHaveAttribute("data-key");
        await page.waitForTimeout(250);
      }
      await toggle(page).click();
      await expectAllLetGo(page);
    });

    test("never asks when the limit is 0", async ({ page }) => {
      await idleAfter(page, "0", "1");
      await startCall(page);
      await page.waitForTimeout(4000);
      await expect(stay(page)).toBeHidden();
      await expect(status(page)).toHaveText("Listening.");
      await toggle(page).click();
      await expectAllLetGo(page);
    });
  });
}

test.describe("the voice lab (azure-voice-live only)", () => {
  const provider = "azure-voice-live";
  const speak = speakTo(provider);

  test.beforeEach(async ({ page }) => {
    test.skip(!withScripts(), "a voice call is a script");
    await resetLab(provider, false);
    await page.route("**/api/voice-session", (route) =>
      route.continue({ url: `${route.request().url()}?provider=${provider}` }),
    );
    await installLab(page);
    await page.goto("/");
    await page.getByTestId("chat-sidebar-new").click();
    await expect(page.getByTestId("chat-welcome")).toBeVisible();
  });

  test.afterEach(async () => {
    await resetLab(provider, true);
  });

  test("plays and shows nothing of a reply that was cut off, though more of it arrives", async ({
    page,
  }) => {
    await page.getByTestId("voice-call-toggle").click();
    await expect(page.getByTestId("voice-call-status")).toHaveText(
      "Listening.",
      { timeout: 15_000 },
    );
    await type(page, "lab:late 8");
    await playedFor(page, 1.5);
    const cut = await speak(page, CUT_IN);
    await page.waitForTimeout(2500);
    const out = await played(page);
    const stretches = soundStretches(out.samples, out.sampleRate);
    // Half a second of the old reply arrived after the cut: none of it is heard.
    expect(stretches).toHaveLength(1);
    const latency = out.startedAt + stretches[0]!.end * 1000 - cut.at;
    measured("barge-in stop, with late audio", latency, "ms");
    expect(latency).toBeLessThan(700);
    await expect(page.getByTestId("chat-thread")).not.toContainText(
      "Stale words.",
    );
    await page.getByTestId("voice-call-toggle").click();
  });
});
