/*
 * Real speech for the live specs, which talk to a real provider that must
 * understand what it hears. A sentence is looked for as a recording of
 * yours first, and made by this machine's own voice when there is none:
 *
 * - voice-lab/speech/<the-sentence-in-lower-case-with-dashes>.wav, mono or
 *   stereo, 16-bit PCM, any rate. `node voice-lab/speech.ts` lists the file
 *   names the live specs look for, with the sentence to read for each.
 * - On macOS, the `say` command, each run. Its output is used and thrown
 *   away, never committed: the system voices are licensed for use on your
 *   own machine.
 *
 * The specs that use stand-in providers need none of this: they use the
 * formula in signal.ts, since a stand-in does not understand anything.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fromWav, resample } from "./signal.ts";

/** The rate the lab's microphone is given speech at. */
export const SPEECH_RATE = 16_000;

/** What the live specs say. Record these to test with a human voice. */
export const SENTENCES = {
  question: "What is a good book about gardening?",
  story: "Tell me a long story about a lighthouse keeper.",
  cutIn: "Stop. Wait a moment, please.",
  yes: "Yes.",
} as const;

/** The file name a sentence's recording has, without its folder. */
export const recordingName = (sentence: string): string =>
  `${sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)}.wav`;

const FOLDER = join(import.meta.dirname, "speech");

/** A sentence as sound at 16 kHz, and where it came from. */
export async function utterance(
  sentence: string,
): Promise<{ samples: Float32Array; source: "recorded" | "synthesized" }> {
  const recorded = join(FOLDER, recordingName(sentence));
  if (existsSync(recorded)) {
    const { samples, sampleRate } = fromWav(readFileSync(recorded));
    return {
      samples: resample(samples, sampleRate, SPEECH_RATE),
      source: "recorded",
    };
  }
  if (process.platform !== "darwin") {
    throw new Error(
      `No recording of "${sentence}". Put one at voice-lab/speech/${recordingName(sentence)} (16-bit WAV); only macOS can make one itself.`,
    );
  }
  const folder = mkdtempSync(join(tmpdir(), "bascik-voice-lab-"));
  try {
    const file = join(folder, "said.wav");
    await promisify(execFile)("say", [
      "-o",
      file,
      "--file-format=WAVE",
      `--data-format=LEI16@${SPEECH_RATE}`,
      sentence,
    ]);
    const { samples, sampleRate } = fromWav(readFileSync(file));
    return {
      samples: resample(samples, sampleRate, SPEECH_RATE),
      source: "synthesized",
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// Run as a script: list what to record.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  console.log(
    "Record each sentence in a quiet room, as 16-bit WAV, into voice-lab/speech/:\n",
  );
  for (const sentence of Object.values(SENTENCES)) {
    const name = recordingName(sentence);
    const have = existsSync(join(FOLDER, name)) ? "have it" : "missing";
    console.log(`  ${name.padEnd(52)} "${sentence}"  (${have})`);
  }
}
