/**
 * How long a reader may pause before a speech-to-speech provider takes their
 * turn as over. One number for every provider, so a call feels the same on
 * each: a provider's own default is as short as half a second, which answers
 * a pause for thought.
 */

/** How long the reader may be silent before their turn is over, in milliseconds. */
export const PAUSE_MS = 800;

/**
 * A pause as a whole number of milliseconds, from a fifth of a second to
 * three. Anything that is not a number is a mistake the developer is told of.
 */
export function pauseMsOf(given: number | undefined): number {
  if (given === undefined) return PAUSE_MS;
  if (!Number.isFinite(given)) {
    throw new TypeError("pauseMs must be a number of milliseconds.");
  }
  return Math.min(3000, Math.max(200, Math.round(given)));
}

/**
 * A provider's own turn-taking settings, which are laid over the default: an
 * object of them, or nothing. Anything else is a mistake the developer is
 * told of, by the option's name.
 */
export function turnSettingsOf(
  name: string,
  given: unknown,
): Record<string, unknown> | undefined {
  if (given === undefined) return undefined;
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return given as Record<string, unknown>;
}
