/**
 * The browser's own microphone capture, end to end. The other voice specs
 * replace getUserMedia with a stream of their own. Here it is the real one:
 * Chromium is started with a recording in place of the device (see the
 * real-microphone project in playwright.config.ts), so the browser's capture
 * and its echo canceling, noise suppression and resampling all run, as they
 * do for a reader with a headset.
 *
 * That processing changes the sound, on purpose, so this does not ask for
 * the samples back. It asks for what a provider needs: sound at the rate
 * the call says, at the pace it is made, as loud as speech, with the
 * recording's rhythm (its quiet second, its three seconds of voice).
 */
import { expect, test } from "@playwright/test";
import {
  envelope,
  percentile,
  rms,
  soundStretches,
} from "../voice-lab/signal.ts";
import { heard, resetLab } from "./lab-helpers.ts";

const MIC_RATE = 16_000;

for (const provider of ["gemini-live", "azure-voice-live"]) {
  test.describe(`the browser's own microphone (${provider})`, () => {
    test.beforeEach(async ({ page }) => {
      await resetLab(provider, false);
      await page.route("**/api/voice-session", (route) =>
        route.continue({
          url: `${route.request().url()}?provider=${provider}`,
        }),
      );
      await page.goto("/");
      await page.getByTestId("chat-sidebar-new").click();
      await expect(page.getByTestId("chat-welcome")).toBeVisible();
    });

    test.afterEach(async () => {
      await resetLab(provider, true);
    });

    test("reaches the provider as speech: at the rate named, at the pace it was said, with its rhythm", async ({
      page,
    }) => {
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        /Listening\.|Hearing you…|Thinking…/,
        { timeout: 15_000 },
      );
      // The recording is five seconds, and is played again when it ends:
      // long enough here for the whole of it, wherever it started.
      await page.waitForTimeout(8000);
      // The meter saw a voice, not a flat line.
      const got = await heard(provider);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false");

      if (provider === "gemini-live") {
        expect(got.formats).toEqual(["audio/pcm;rate=16000"]);
      }
      expect(got.sizes.every((size) => size > 0 && size % 2 === 0)).toBe(true);

      // As many seconds of sound as passed: the rate is the one named. A
      // browser that captured at 48 kHz and said 16 would send three times this.
      const elapsed = (got.arrivals.at(-1)! - got.arrivals[0]!) / 1000;
      const seconds = (got.samples.length - got.sizes[0]! / 2) / MIC_RATE;
      expect(elapsed).toBeGreaterThan(6);
      expect(seconds / elapsed).toBeGreaterThan(0.93);
      expect(seconds / elapsed).toBeLessThan(1.07);
      const waits = got.arrivals
        .slice(1)
        .map((at, index) => at - got.arrivals[index]!);
      expect(percentile(waits, 0.95)).toBeLessThan(300);

      // Speech, as loud as speech: not silence, not a clipped square.
      const stretches = soundStretches(got.samples, MIC_RATE, 0.01, 0.3);
      const voiced = stretches.filter(
        (stretch) => stretch.end - stretch.start > 1,
      );
      expect(voiced.length).toBeGreaterThanOrEqual(1);
      const longest = voiced.reduce((most, stretch) =>
        stretch.end - stretch.start > most.end - most.start ? stretch : most,
      );
      const level = rms(
        got.samples,
        Math.round(longest.start * MIC_RATE),
        Math.round(longest.end * MIC_RATE),
      );
      expect(level).toBeGreaterThan(0.02);
      expect(level).toBeLessThan(0.6);
      // The sentence is three seconds long, and was heard as about that.
      expect(longest.end - longest.start).toBeGreaterThan(2.5);
      expect(longest.end - longest.start).toBeLessThan(3.5);
      // Between sentences the room is quiet: most of a second well below the voice.
      const levels = [...envelope(got.samples, MIC_RATE, 0.05)];
      expect(percentile(levels, 0.1)).toBeLessThan(level / 10);
    });
  });
}
