/**
 * A voice call with a real provider, and nobody at the microphone. Real
 * speech (your recordings, or this machine's voice: see voice-lab/speech.ts)
 * is said into the page; the provider's own transcript says whether it was
 * understood, and what the page plays says how long the reader waited and
 * how fast the model stopped when it was cut in on.
 *
 * Run with `yarn workspace @bascik/ai e2e:live` (see playwright.live.config.ts).
 * Each spec saves its call as a cassette for `yarn e2e` to play back.
 *
 * The limits here are loose on purpose: a model's speed is the provider's,
 * and changes from day to day. The numbers are reported with every run
 * (`--reporter=list` shows them), and a limit fails only when a call would
 * feel broken to a reader.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  installLab,
  labCount,
  openContexts,
  played,
  say,
} from "../e2e/lab-helpers.ts";
import { soundStretches } from "../voice-lab/signal.ts";
import { SENTENCES, SPEECH_RATE, utterance } from "../voice-lab/speech.ts";
import { wordErrorRate } from "../voice-lab/words.ts";

const RECORDERS: Record<string, number> = {
  "gemini-live": 4490,
  "azure-voice-live": 4491,
};
const providers = (process.env.VOICE_LIVE_PROVIDERS ?? "")
  .split(",")
  .filter(Boolean);

const measured = (name: string, value: number, unit: string): void => {
  test.info().annotations.push({
    type: "measured",
    description: `${name}: ${Math.round(value)} ${unit}`,
  });
  console.log(`  ${test.info().title}: ${name}: ${Math.round(value)} ${unit}`);
};

/** Keep the call just made as a cassette. */
async function saveCassette(provider: string, name: string): Promise<void> {
  const response = await fetch(
    `http://127.0.0.1:${RECORDERS[provider]}/__lab/save?name=${provider}-${name}`,
    { method: "POST" },
  );
  expect(response.status, await response.text()).toBe(200);
}

/** Every stretch of sound the loudspeaker played, on the page's clock, in ms. */
async function sounds(page: Page): Promise<{ start: number; end: number }[]> {
  const out = await played(page);
  return soundStretches(out.samples, out.sampleRate, 0.003, 0.4).map(
    (stretch) => ({
      start: out.startedAt + stretch.start * 1000,
      end: out.startedAt + stretch.end * 1000,
    }),
  );
}

for (const provider of providers) {
  test.describe(`a live call (${provider})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.route("**/api/voice-session", (route) =>
        route.continue({
          url: `${route.request().url()}?provider=${provider}`,
        }),
      );
      await installLab(page);
      await page.goto("/");
      await page.getByTestId("chat-sidebar-new").click();
      await expect(page.getByTestId("chat-welcome")).toBeVisible();
      await page.getByTestId("voice-call-toggle").click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "Listening.",
        { timeout: 30_000 },
      );
    });

    test.afterEach(async ({ page }) => {
      const toggle = page.getByTestId("voice-call-toggle");
      if ((await toggle.getAttribute("aria-pressed")) === "true") {
        await toggle.click();
      }
      await expect.poll(() => labCount(page, "liveTracks()")).toBe(0);
      await expect.poll(() => openContexts(page)).toEqual([]);
      await expect.poll(() => labCount(page, "openSockets()")).toBe(0);
    });

    test("understands a spoken question, and answers aloud", async ({
      page,
    }) => {
      const question = await utterance(SENTENCES.question);
      test.info().annotations.push({
        type: "speech",
        description: question.source,
      });
      // A moment of an open microphone in a quiet room first, as in life.
      await page.waitForTimeout(700);
      const said = await say(page, question.samples, SPEECH_RATE);
      const saidUntil = said.at + said.seconds * 1000;

      // The provider wrote down what it heard: most of the words are right.
      const reader = page.getByTestId("turn-user").last();
      await expect
        .poll(
          async () =>
            wordErrorRate(
              SENTENCES.question,
              (await reader.textContent().catch(() => "")) ?? "",
            ),
          { timeout: 40_000 },
        )
        .toBeLessThanOrEqual(0.34);
      measured(
        "word error rate",
        wordErrorRate(SENTENCES.question, (await reader.textContent()) ?? "") *
          100,
        "%",
      );

      // The model answers aloud, soon enough to be a conversation.
      await expect
        .poll(async () => (await sounds(page)).length, { timeout: 40_000 })
        .toBeGreaterThan(0);
      const [first] = await sounds(page);
      measured(
        "answer starts",
        first!.start - saidUntil,
        "ms after the reader stopped",
      );
      expect(first!.start - saidUntil).toBeLessThan(10_000);
      // It says something of some length, and its words are shown.
      await expect
        .poll(
          async () =>
            (await sounds(page)).reduce(
              (total, sound) => total + sound.end - sound.start,
              0,
            ),
          { timeout: 40_000 },
        )
        .toBeGreaterThan(1000);
      await expect(page.getByTestId("turn-voice").last()).not.toBeEmpty();
      await expect(page.getByTestId("voice-call-caption")).not.toBeEmpty();
      await saveCassette(provider, "spoken-question");
    });

    test("stops talking when the reader cuts in", async ({ page }) => {
      const cutIn = await utterance(SENTENCES.cutIn);
      // Typed, so the long answer starts without waiting on a recognizer.
      await page.getByTestId("chat-composer-input").fill(SENTENCES.story);
      await page.getByTestId("chat-composer-send").click();
      // The model is well into its story.
      await expect
        .poll(
          async () =>
            (await sounds(page)).reduce(
              (total, sound) => total + sound.end - sound.start,
              0,
            ),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(3000);
      const cut = await say(page, cutIn.samples, SPEECH_RATE);
      await page.waitForTimeout(6000);

      // The voice that was playing when the reader spoke stopped soon after.
      // (The model may then answer the reader: that is a later sound.)
      const playing = (await sounds(page)).find(
        (sound) => sound.start < cut.at && sound.end > cut.at,
      );
      expect(
        playing,
        "the model was speaking when the reader cut in",
      ).toBeTruthy();
      measured(
        "barge-in stop",
        playing!.end - cut.at,
        "ms after the reader spoke",
      );
      expect(playing!.end - cut.at).toBeLessThan(3000);
      await saveCassette(provider, "cut-in");
    });

    test("takes a typed message, and shows what the model shows", async ({
      page,
    }) => {
      await page
        .getByTestId("chat-composer-input")
        .fill("Recommend two books and show them to me.");
      await page.getByTestId("chat-composer-send").click();
      const sentAt = (await page.evaluate("performance.now()")) as number;
      await expect
        .poll(async () => (await sounds(page)).length, { timeout: 60_000 })
        .toBeGreaterThan(0);
      measured(
        "answer starts",
        (await sounds(page))[0]!.start - sentAt,
        "ms after a typed message",
      );
      // The model called the show tool, and the server rendered components.
      await expect(
        page.getByTestId("turn-voice").getByTestId("book-card").first(),
      ).toBeVisible({ timeout: 60_000 });
      await saveCassette(provider, "typed-show");
    });
  });
}
