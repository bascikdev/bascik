/**
 * Test-only probe for V8 string representation (prompt 85).
 *
 * `%StringIsFlat` is a V8 runtime intrinsic that reports whether a string is
 * a contiguous character array (flat) or a `ConsString` concatenation tree.
 * It requires `--allow-natives-syntax`, which is enabled here at runtime for
 * the current isolate before the probe function is compiled. Never import
 * this from production code; the `.test-helper.ts` suffix keeps it out of
 * `tsconfig.build.json`.
 */
import { setFlagsFromString } from "node:v8";

setFlagsFromString("--allow-natives-syntax");

export const isFlatString: (value: string) => boolean = new Function(
  "value",
  "return %StringIsFlat(value);",
) as (value: string) => boolean;

/** Build a deep cons string the way an iterative splice loop does. */
export const makeConsString = (base: string, splices: number, insert = "<x>"): string => {
  let result = base;
  for (let i = 0; i < splices; i++) {
    const at = Math.min(result.length, i * 3);
    result = result.slice(0, at) + insert + result.slice(at);
  }
  return result;
};
