/**
 * The one place e2e specs resolve a build output directory.
 *
 * pkg/e2e and base-fixture are built by every main Playwright lane, so each
 * lane config sets BASCIK_E2E_OUT (dist-static, dist-dev, dist-http1,
 * dist-http2) and both fixtures route `directory.out` through it. Use
 * `outDir()` for those two.
 *
 * Fixtures that only one lane uses (symlink-fixture, exec-fixture) and the
 * temporary projects specs create keep bascik's default `dist`. Use
 * `defaultOutDir()` for those.
 *
 * Both functions check the fixture's bascik.config.ts so picking the wrong one
 * fails with a message instead of reading another lane's (or no) output.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_OUT = "dist";
const LANE_OUT_VAR = "BASCIK_E2E_OUT";

const readsLaneOut = (fixtureDir: string): boolean | undefined => {
  try {
    return readFileSync(join(fixtureDir, "bascik.config.ts"), "utf8").includes(
      `process.env.${LANE_OUT_VAR}`,
    );
  } catch {
    return undefined; // no config: bascik's default directory.out applies
  }
};

/** Output directory of a fixture whose config reads BASCIK_E2E_OUT (pkg/e2e, base-fixture). */
export function outDir(fixtureDir: string): string {
  if (readsLaneOut(fixtureDir) !== true) {
    throw new Error(
      `outDir(${fixtureDir}): this fixture's bascik.config.ts does not set directory.out from ${LANE_OUT_VAR}, ` +
        `so its output is not per lane. Use defaultOutDir() for it.`,
    );
  }
  return join(fixtureDir, process.env[LANE_OUT_VAR] ?? DEFAULT_OUT);
}

/** Output directory of a single-lane fixture or temporary project that keeps bascik's default `dist`. */
export function defaultOutDir(projectDir: string): string {
  if (readsLaneOut(projectDir) === true) {
    throw new Error(
      `defaultOutDir(${projectDir}): this fixture's bascik.config.ts sets directory.out from ${LANE_OUT_VAR}. ` +
        `Use outDir() so the spec reads this lane's output.`,
    );
  }
  return join(projectDir, DEFAULT_OUT);
}
