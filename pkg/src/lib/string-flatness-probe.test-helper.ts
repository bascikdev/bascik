/**
 * Test-only probe for V8 string representation (prompt 85).
 *
 * `%StringIsFlat` is a V8 runtime intrinsic that reports whether a string is
 * a contiguous character array (flat) or a `ConsString` concatenation tree.
 * It requires `--allow-natives-syntax`, which is enabled here at runtime for
 * the current isolate before the probe function is compiled. Never import
 * this from production code; the `.test-helper.ts` suffix keeps it out of
 * `tsconfig.build.json`.
 *
 * WHY the support flag: `%StringIsFlat` first shipped in V8 13.6, which Node
 * 24.0.0 bundles. Every Node 22.x release ships V8 12.4, where compiling the
 * probe throws. The published package floor is Node 22.22, so the probe is
 * detected once at module load and the tests that need it skip (rather than
 * fail) below Node 24 via `stringFlatnessProbeSupported`.
 */
import { setFlagsFromString } from "node:v8";

type FlatnessProbe = (value: string) => boolean;

let probe: FlatnessProbe | undefined;
let unsupportedReason: string | undefined;
try {
  setFlagsFromString("--allow-natives-syntax");
  const candidate = new Function(
    "value",
    "return %StringIsFlat(value);",
  ) as FlatnessProbe;
  if (typeof candidate("probe") !== "boolean")
    throw new Error("%StringIsFlat did not return a boolean");
  probe = candidate;
} catch (error) {
  unsupportedReason = error instanceof Error ? error.message : String(error);
}

/** True when this runtime's V8 exposes `%StringIsFlat` (Node 24.0.0+). */
export const stringFlatnessProbeSupported = probe !== undefined;

/** Human-readable skip reason for `describe.skipIf` / `it.skipIf` gates. */
export const stringFlatnessProbeSkipReason = `V8 %StringIsFlat probe needs Node 24.0.0+ (V8 13.6); running ${process.version} (V8 ${process.versions.v8})${unsupportedReason ? `: ${unsupportedReason}` : ""}`;

export const isFlatString: FlatnessProbe = (value) => {
  if (!probe) throw new Error(stringFlatnessProbeSkipReason);
  return probe(value);
};

/** Build a deep cons string the way an iterative splice loop does. */
export const makeConsString = (
  base: string,
  splices: number,
  insert = "<x>",
): string => {
  let result = base;
  for (let i = 0; i < splices; i++) {
    const at = Math.min(result.length, i * 3);
    result = result.slice(0, at) + insert + result.slice(at);
  }
  return result;
};
