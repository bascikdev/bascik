import { setFlagsFromString } from "node:v8";

/**
 * Node 24's V8 (13.6) can abort the whole process when two threads use
 * WebAssembly and one of them tears down: "Check failed:
 * jit_page.has_value()" or "jit_page_->allocations_.erase(addr) == 1"
 * (SIGTRAP), or a SIGSEGV on the same path (nodejs/node#66366).
 *
 * Wasm-to-JS import wrappers are shared by every isolate in the process.
 * When the last instance that uses a wrapper goes away (a worker thread
 * ending, by `terminate()`, `process.exit()` or its event loop draining),
 * V8 marks the wrapper as dying and a wasm code GC frees it. A thread that
 * tiers up the same import at that moment (`Runtime_TierUpWasmToJSWrapper`)
 * looks the dying wrapper up, and the wrapper is freed a second time. CI's
 * abort had exactly that stack. Fixed upstream in V8 9b8ca54d5a and
 * 68210d500a, which Node 24 does not carry (backport nodejs/node#66376).
 *
 * Bascik's threads run wasm without asking for it: Node strips the types of
 * every `.ts` module it loads (a `bascik.config.ts`, a TypeScript helper)
 * with Amaro, which is swc compiled to wasm. Which thread stops, or how,
 * does not matter, so no stop protocol avoids the race.
 *
 * Without wasm code GC a dying wrapper is never freed, so it cannot be freed
 * twice. V8 reads the flag each time code becomes dead, so turning it off
 * at run time works, and it applies to every thread of the process. The
 * cost is that dead wasm code (a wrapper nothing uses, baseline code
 * replaced by optimized code) stays allocated until its module is freed:
 * a `bascik --build` of a 25-page site with eight page workers peaked
 * about 16 MB (2 to 3 %) higher, in every one of 16 paired runs, and the
 * extra memory is not given back. It does not grow: starting and
 * terminating four type-stripping workers 240 times kept memory level.
 */

/** V8 versions with the wrapper race: 13.x, which only Node 24 ships among
 * the Node versions Bascik supports (Node 22 has 12.4, Node 25 and later 14). */
export const hasWasmWrapperRace = (v8Version: string): boolean =>
  Number.parseInt(v8Version, 10) === 13;

/** The user asked for wasm code GC on the command line or in NODE_OPTIONS;
 * the last of `--wasm-code-gc` / `--no-wasm-code-gc` wins, as in V8. */
const userChoseWasmCodeGc = (
  execArgv: readonly string[],
  nodeOptions: string,
): boolean => {
  let chosen = false;
  for (const arg of [...nodeOptions.split(/\s+/), ...execArgv]) {
    // Node accepts a V8 boolean flag as `--x`, `--no-x` or `--nox`, with `-`
    // and `_` interchangeable (it rejects `--x=true` and `--x=false`).
    const flag = arg.replaceAll("_", "-");
    if (flag === "--wasm-code-gc") chosen = true;
    else if (flag === "--no-wasm-code-gc" || flag === "--nowasm-code-gc") {
      chosen = false;
    }
  }
  return chosen;
};

let applied = false;

/**
 * Turn off wasm code GC for this process when its V8 has the wrapper race,
 * before Bascik starts a worker thread. Does nothing on other V8 versions,
 * when the user passed `--wasm-code-gc` themselves, or after the first call.
 * Reports whether it turned the flag off now.
 */
export const avoidWasmWrapperRace = ({
  v8Version = process.versions.v8,
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? "",
  setFlags = setFlagsFromString,
}: {
  v8Version?: string;
  execArgv?: readonly string[];
  nodeOptions?: string;
  setFlags?: (flags: string) => void;
} = {}): boolean => {
  if (applied) return false;
  applied = true;
  if (!hasWasmWrapperRace(v8Version)) return false;
  if (userChoseWasmCodeGc(execArgv, nodeOptions)) return false;
  try {
    setFlags("--no-wasm-code-gc");
    return true;
  } catch {
    // An embedder that froze V8's flags: nothing else to do.
    return false;
  }
};

/** Forget the first call, so a test can run `avoidWasmWrapperRace` again. */
export const resetWasmWrapperRaceForTests = (): void => {
  applied = false;
};
