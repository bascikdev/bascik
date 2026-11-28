/**
 * What the voice lab specs do to a page and ask of a stand-in provider: say
 * recorded sound into the microphone, read back what the loudspeaker played,
 * and read what the provider received. The page side is voice-lab/browser.ts;
 * the provider side is fake-lab.ts.
 */
import type { Page } from "@playwright/test";
import { VOICE_LAB } from "../voice-lab/browser.ts";
import { fromPcm16, toPcm16 } from "../voice-lab/signal.ts";
import type { LabEvent } from "./fake-lab.ts";

/** The stand-in providers' ports (see playwright.config.ts). */
export const LAB_PORTS: Readonly<Record<string, number>> = {
  "gemini-live": 4480,
  "azure-voice-live": 4481,
};

/** Put the lab in the page. It takes effect on the next load. */
export async function installLab(page: Page): Promise<void> {
  await page.addInitScript(VOICE_LAB);
}

/** Change how the lab's microphone behaves, from now on. */
export async function setMicrophone(
  page: Page,
  microphone: "lab" | "denied" | "none",
  delay = 0,
): Promise<void> {
  await page.evaluate(
    `window.__voiceLab.microphone = ${JSON.stringify(microphone)}; window.__voiceLab.microphoneDelay = ${delay};`,
  );
}

/** Say `samples` into the open microphone. Gives when it started, on the page's clock. */
export async function say(
  page: Page,
  samples: Float32Array,
  sampleRate: number,
): Promise<{ at: number; seconds: number }> {
  const pcm = toPcm16(samples).toString("base64");
  return (await page.evaluate(
    `window.__voiceLab.say(${JSON.stringify(pcm)}, ${sampleRate})`,
  )) as { at: number; seconds: number };
}

/** What the loudspeaker played. */
export interface Played {
  samples: Float32Array;
  sampleRate: number;
  /** When the first sample was played, on the page's clock (performance.now). */
  startedAt: number;
  /** The page's clock when this was read. */
  now: number;
}

export async function played(page: Page): Promise<Played> {
  const result = (await page.evaluate("window.__voiceLab.played()")) as {
    sampleRate: number;
    pcm: string;
    startedAt: number;
    now: number;
  };
  return {
    samples: fromPcm16(Buffer.from(result.pcm, "base64")),
    sampleRate: result.sampleRate,
    startedAt: result.startedAt,
    now: result.now,
  };
}

/** A number the page's lab gives: `liveTracks()`, `openSockets()`, `asked`. */
export const labCount = (page: Page, what: string): Promise<number> =>
  page.evaluate(`window.__voiceLab.${what}`) as Promise<number>;

/** The states of the audio contexts the page has not closed. */
export const openContexts = (page: Page): Promise<string[]> =>
  page.evaluate("window.__voiceLab.openContexts()") as Promise<string[]>;

/** What a stand-in provider's latest session received. */
export interface Heard {
  sessions: number;
  samples: Float32Array;
  /** The size of each message's audio, in bytes. */
  sizes: number[];
  /** When each message arrived, in milliseconds (Date.now). */
  arrivals: number[];
  formats: string[];
  events: LabEvent[];
}

export async function heard(provider: string): Promise<Heard> {
  const response = await fetch(
    `http://127.0.0.1:${LAB_PORTS[provider]}/__lab/heard`,
  );
  const body = (await response.json()) as Omit<Heard, "samples"> & {
    pcm: string;
  };
  return { ...body, samples: fromPcm16(Buffer.from(body.pcm, "base64")) };
}

/**
 * Forget what a stand-in heard. `canned: false` turns its scripted first
 * turn off; `cassette` is a recorded session for it to play instead.
 */
export async function resetLab(
  provider: string,
  canned: boolean,
  cassette?: string,
): Promise<void> {
  await fetch(`http://127.0.0.1:${LAB_PORTS[provider]}/__lab/reset`, {
    method: "POST",
    body: JSON.stringify({ canned, cassette }),
  });
}
