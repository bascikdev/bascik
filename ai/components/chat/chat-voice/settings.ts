/*
 * chat-voice's settings: read from storage with safe defaults, written back
 * when the reader changes them, and named for the button that opens them.
 * Storage is passed in as functions, so a page without it still works.
 */

import type { Settings } from "./types.ts";

/** Where the settings are kept, in localStorage. */
export const STORE = "bascik-genui-voice";

/**
 * The reader's settings: what `read` gives, over the defaults. Listening
 * starts only when the reader presses Dictate in this visit, and reading
 * aloud needs a browser that can speak.
 */
export function loadSettings(
  read: () => string | null,
  canSpeak: boolean,
): Settings {
  const settings: Settings = {
    captions: false,
    aloud: false,
    talk: false,
    speed: "1",
  };
  try {
    Object.assign(settings, JSON.parse(read() ?? "{}"));
  } catch {
    // No storage, or nothing stored: the defaults stand.
  }
  settings.talk = false;
  if (!canSpeak) settings.aloud = false;
  return settings;
}

/** Keep the settings with `write`; nothing else depends on it. */
export function saveSettings(
  write: (value: string) => void,
  settings: Settings,
): void {
  try {
    write(JSON.stringify(settings));
  } catch {
    // Not kept. Nothing else depends on it.
  }
}

/** True while something follows the reply: captions or the voice. */
export const isActive = (settings: Settings): boolean =>
  settings.captions || settings.aloud;

/** The button's name, which says what is on even with the controls closed. */
export function aidsLabel(settings: Settings): { name: string; on: boolean } {
  const on = [
    settings.captions && "captions",
    settings.aloud && "read aloud",
    settings.talk && "dictate",
  ].filter(Boolean);
  return {
    name: on.length ? `Reading aids: ${on.join(", ")}` : "Reading aids",
    on: on.length > 0,
  };
}
