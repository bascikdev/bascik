/**
 * Tests for the portable expansion loop (prompt 157).
 *
 * `expandComponents` is `recursivelyTranspile`'s loop with its host-bound
 * calls turned into parameters so the same loop can render server and stream
 * script output at request time on hosts without `node:*`. The parity oracle
 * is `__fixtures__/component-expansion-core.golden.json`: the output of
 * `recursivelyTranspile` BEFORE the loop was extracted, recorded on the shared
 * fixtures in both identifier modes. Both entry points must reproduce it byte
 * for byte, so a regression inside the loop fails here even though the build
 * wrapper now runs that same loop. Regenerate the golden only from a build
 * known to be correct, never from the code under test.
 *
 * The request-time cases pin the parameters a manifest-backed host plugs in.
 * Injecting attr-bound props after scoping is byte-identical to injecting
 * them before it, except where scoping would have rewritten the injected
 * value: id references (`href="#x"`, `for`, `form`, `aria-*`, ...). Those are
 * restored per target attribute by `rewriteIdRefs` through `scopedIdNames`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./config.ts")>();
  return {
    ...original,
    BascikConfig: {
      ...original.BascikConfig,
      minify: { ...original.BascikConfig.minify, identifiers: true },
      // Own copy: the real config is frozen, and the expansionLimits tests
      // set a limit for one test.
      components: { ...original.BascikConfig.components },
      scoping: {
        scriptBlocks: true,
        inheritAttributes: true,
        attributes: { class: true, id: true, name: true },
        preserve: ["code"],
        deduplicateCss: true,
      },
    },
    shouldLog: vi.fn(() => true),
  };
});

import { stripSourceFileComments } from "./component-expansion-core.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripSourceFileComments", () => {
  it(
    "runs in linear time on many unclosed markers",
    () => {
      // Request-time expansion runs it on server-script output, which can
      // carry visitor text. `/<!--bascik-source-file:[\s\S]*?-->/g` rescanned
      // to the end from every opener: 40k openers took 4 s (CodeQL
      // js/polynomial-redos).
      for (const opener of [
        "<!--bascik-source-file:",
        "<!--bascik-source-file-end:",
      ]) {
        const html = (count: number) => `<p>a</p>${opener.repeat(count)}`;
        expect(stripSourceFileComments(html(40_000))).toBe(html(40_000));
        expectLinearTime(html, 40_000, stripSourceFileComments, {
          label: opener,
        });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
