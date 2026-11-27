/**
 * Recorded sessions, played back. A cassette (voice-lab/cassette.ts) is every
 * message of a real voice session, in order and in time; here the stand-in
 * provider plays one to a real browser, and the call is held to what any
 * call must do with it: stay up, play all of the model's voice, show its
 * words, and let everything go at the end.
 *
 * Every cassette in e2e/cassettes/ and e2e/cassettes/live/ is played, by the provider its first line
 * names. To add one, record a session (see voice-lab/README.md):
 *
 *   node voice-lab/record.ts gemini-live --out e2e/cassettes/books.jsonl
 *
 * Two small cassettes written here are always played, so the path from a
 * cassette to the loudspeaker is tested even with no recording on file.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readCassette,
  typedIn,
  voiceSeconds,
  writeCassette,
} from "../voice-lab/cassette.ts";
import type { Cassette, Frame } from "../voice-lab/cassette.ts";
import { soundStretches } from "../voice-lab/signal.ts";
import { labVoicePieces } from "./fake-lab.ts";
import {
  installLab,
  labCount,
  openContexts,
  played,
  resetLab,
} from "./lab-helpers.ts";

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

/** A session as Gemini Live has it: setup, a typed message, a spoken answer. */
function geminiTape(): Cassette {
  let at = 0;
  const frames: Frame[] = [];
  const from =
    (who: Frame["from"]) =>
    (message: unknown, after = 5): void => {
      at += after;
      frames.push({ at, from: who, data: JSON.stringify(message) });
    };
  const browser = from("browser");
  const provider = from("provider");
  browser({ setup: { model: "models/stand-in" } });
  provider({ setupComplete: {} }, 40);
  browser({
    clientContent: {
      turns: [{ role: "user", parts: [{ text: "Say something" }] }],
      turnComplete: true,
    },
  });
  provider(
    { serverContent: { outputTranscription: { text: "This is " } } },
    300,
  );
  provider({ serverContent: { outputTranscription: { text: "the tape." } } });
  for (const data of labVoicePieces(1.5)) {
    provider(
      { serverContent: { modelTurn: { parts: [{ inlineData: { data } }] } } },
      20,
    );
  }
  provider({ serverContent: { generationComplete: true } });
  provider({ serverContent: { turnComplete: true } });
  return { provider: "gemini-live", note: "Written by the spec.", frames };
}

/** The same session as Azure Voice Live has it, between the relay and the provider. */
function azureTape(): Cassette {
  let at = 0;
  const frames: Frame[] = [];
  const from =
    (who: Frame["from"]) =>
    (message: unknown, after = 5): void => {
      at += after;
      frames.push({ at, from: who, data: JSON.stringify(message) });
    };
  const browser = from("browser");
  const provider = from("provider");
  provider({ type: "session.created", session: { id: "sess_tape" } });
  browser({ type: "session.update", session: {} });
  provider({ type: "session.updated", session: {} }, 40);
  browser({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Say something" }],
    },
  });
  browser({ type: "response.create" });
  provider({ type: "response.created", response: { id: "resp_tape" } }, 300);
  provider({
    type: "response.audio_transcript.delta",
    response_id: "resp_tape",
    delta: "This is the tape.",
  });
  for (const delta of labVoicePieces(1.5)) {
    provider(
      { type: "response.audio.delta", response_id: "resp_tape", delta },
      20,
    );
  }
  provider({
    type: "response.done",
    response: { id: "resp_tape", status: "completed" },
  });
  return { provider: "azure-voice-live", note: "Written by the spec.", frames };
}

const CASSETTES = join(import.meta.dirname, "cassettes");
const tapes: { name: string; cassette: Cassette }[] = [
  { name: "a written Gemini Live session", cassette: geminiTape() },
  { name: "a written Azure Voice Live session", cassette: azureTape() },
  // Recordings put here by hand, and the ones the live lane leaves in live/.
  ...["", "live"].flatMap((folder) =>
    existsSync(join(CASSETTES, folder))
      ? readdirSync(join(CASSETTES, folder))
          .filter((file) => file.endsWith(".jsonl"))
          .map((file) => ({
            name: join(folder, file),
            cassette: readCassette(
              readFileSync(join(CASSETTES, folder, file), "utf8"),
            ),
          }))
      : [],
  ),
];

async function type(page: Page, text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-composer-send").click();
}

/** How many seconds of sound the loudspeaker has played. */
async function soundPlayed(page: Page): Promise<number> {
  const { samples, sampleRate } = await played(page);
  return soundStretches(samples, sampleRate, 0.003, 0.05).reduce(
    (total, stretch) => total + stretch.end - stretch.start,
    0,
  );
}

/** Wait for the model's voice to start, and then for the loudspeaker to go quiet. */
async function voiceOver(page: Page): Promise<void> {
  await expect
    .poll(() => soundPlayed(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  let before = -1;
  await expect
    .poll(
      async () => {
        const now = await soundPlayed(page);
        const settled = now === before;
        before = now;
        return settled;
      },
      { timeout: 60_000, intervals: [700] },
    )
    .toBe(true);
}

/** Whether the model was ever cut in on, which leaves some of its voice unplayed. */
const wasCutIn = (cassette: Cassette): boolean =>
  cassette.frames.some(
    (frame) =>
      frame.from === "provider" &&
      /"interrupted":true|input_audio_buffer\.speech_started|"status":"cancelled"/.test(
        frame.data,
      ),
  );

/** The first words the model said, as the provider wrote them down. */
function firstWords(cassette: Cassette): string {
  let said = "";
  for (const frame of cassette.frames) {
    if (frame.from !== "provider") continue;
    const message = JSON.parse(frame.data) as {
      type?: string;
      delta?: string;
      serverContent?: { outputTranscription?: { text?: string } };
    };
    if (message.type === "response.audio_transcript.delta") {
      said += message.delta ?? "";
    }
    said += message.serverContent?.outputTranscription?.text ?? "";
    if (said.trim().length >= 12) break;
  }
  return said.trim().replace(/\s+/g, " ").slice(0, 12);
}

for (const { name, cassette } of tapes) {
  test(`plays back ${name}`, async ({ page }) => {
    test.skip(!withScripts(), "a voice call is a script");
    const provider = cassette.provider;
    await resetLab(provider, false, writeCassette(cassette));
    try {
      await page.route("**/api/voice-session", (route) =>
        route.continue({
          url: `${route.request().url()}?provider=${provider}`,
        }),
      );
      await installLab(page);
      await page.goto("/");
      await page.getByTestId("chat-sidebar-new").click();
      await expect(page.getByTestId("chat-welcome")).toBeVisible();

      // From here on the page is the call's: nothing in it may throw.
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const toggle = page.getByTestId("voice-call-toggle");
      await toggle.click();
      await expect(page.getByTestId("voice-call-status")).toHaveText(
        "Listening.",
        { timeout: 15_000 },
      );

      // The reader's part: each message they typed in the recording, in turn,
      // once the voice that answered the one before has been played.
      const total = voiceSeconds(cassette);
      for (const text of typedIn(cassette)) {
        await type(page, text);
        await expect(page.getByTestId("turn-user").last()).toHaveText(text);
        await voiceOver(page);
      }
      // A recording the reader only spoke in has nothing to type: its voice
      // comes when the recording says, seconds after the call is up.
      if (total > 0) await voiceOver(page);

      // The model's voice was played: never more of it than there was (a
      // piece played twice), and not much less. A voice pauses between
      // words, which is not counted as sound, so "all of it" is most of its
      // length; a reader who cut in is the one reason for far less.
      const heard = await soundPlayed(page);
      test.info().annotations.push({
        type: "measured",
        description: `voice played: ${heard.toFixed(2)} of ${total.toFixed(2)} s`,
      });
      expect(heard).toBeLessThan(total * 1.03 + 0.1);
      if (!wasCutIn(cassette)) expect(heard).toBeGreaterThan(total * 0.6);
      // And its words are in the thread.
      const words = firstWords(cassette);
      if (words) {
        await expect(page.getByTestId("chat-thread")).toContainText(words);
      }
      expect(errors).toEqual([]);

      // The call ends when the reader says so, or when the recording did.
      if ((await toggle.getAttribute("aria-pressed")) === "true") {
        await toggle.click();
      }
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await expect.poll(() => labCount(page, "liveTracks()")).toBe(0);
      await expect.poll(() => openContexts(page)).toEqual([]);
      await expect.poll(() => labCount(page, "openSockets()")).toBe(0);
    } finally {
      await resetLab(provider, true);
    }
  });
}
