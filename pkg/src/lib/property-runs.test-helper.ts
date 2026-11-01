/**
 * Bounds for fast-check properties in the unit project. Test-only; never
 * imported by production code.
 *
 * A property with no explicit bounds draws a fresh random seed on every run,
 * so its cost changes from run to run, and runs under Vitest's 5 s default
 * timeout: the Node 22.22 floor runner on CI timed out a property that takes
 * under a second on a developer machine. Each property therefore runs a
 * fixed number of cases from a fixed seed, sized to finish well under a
 * second locally, with a 30 s timeout as the margin for a slow runner.
 *
 * A deeper local run raises the count through the variable the test names
 * (`MASK_ORACLE_RUNS=20000`), and its timeout grows with it; `PROPERTY_SEED`
 * starts every bounded property from another seed. fast-check runs no case
 * at all for `numRuns` of `NaN` or 0 and passes, so a value that is not a
 * positive whole number throws instead of turning the property into a no-op.
 */

/** The seed every bounded property starts from unless `PROPERTY_SEED` is set. */
export const PROPERTY_SEED = 20_261_031;
/** The timeout for a property at its CI run count. */
export const PROPERTY_TEST_TIMEOUT_MS = 30_000;

export interface PropertyBounds {
  /** Pass to `fc.assert` as its parameters. */
  options: { numRuns: number; seed: number };
  /** Pass to `it` as its timeout. */
  timeoutMs: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

const readRuns = (name: string, value: string): number => {
  const runs = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(runs) || runs < 1) {
    throw new Error(
      `${name} must be a positive whole number of property runs, got ${JSON.stringify(value)}`,
    );
  }
  return runs;
};

const readSeed = (value: string): number => {
  const seed = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(seed) || seed < -(2 ** 31) || seed >= 2 ** 31) {
    throw new Error(
      `PROPERTY_SEED must be a 32-bit whole number, got ${JSON.stringify(value)}`,
    );
  }
  return seed;
};

/**
 * The run count, seed and timeout for one property: `ciRuns` cases unless
 * the environment variable `runsVariable` asks for another count.
 */
export function propertyBounds(
  ciRuns: number,
  runsVariable?: string,
  env: Environment = process.env,
): PropertyBounds {
  if (!Number.isSafeInteger(ciRuns) || ciRuns < 1) {
    throw new Error(
      `propertyBounds needs a positive whole number of CI runs, got ${ciRuns}`,
    );
  }
  const requested = runsVariable === undefined ? undefined : env[runsVariable];
  const numRuns =
    requested === undefined || runsVariable === undefined
      ? ciRuns
      : readRuns(runsVariable, requested);
  const seedValue = env.PROPERTY_SEED;
  const seed = seedValue === undefined ? PROPERTY_SEED : readSeed(seedValue);
  const timeoutMs =
    PROPERTY_TEST_TIMEOUT_MS * Math.max(1, Math.ceil(numRuns / ciRuns));
  return { options: { numRuns, seed }, timeoutMs };
}
