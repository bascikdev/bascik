/** TEMPORARY: prints growth readings on CI for the flaky "quote that never ends" scan. Removed before merge. */
import { it } from "vitest";
import { extractPageScopeScripts } from "./typescript-blocks.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const page = (n: number) => `text/javascript <script type="${"a".repeat(n)}`;
const work: Record<string, (html: string) => unknown> = {
  "new scan": extractPageScopeScripts,
  "page-sized toLowerCase (what the old scan paid)": (html) => html.toLowerCase(),
  "native indexOf pass": (html) => html.indexOf("\u0001"),
};
it(
  "CI probe",
  () => {
    const lines: string[] = [];
    for (const smallChars of [256_000, 1_000_000, 4_000_000]) {
      const small = page(smallChars);
      const large = page(4 * smallChars);
      for (const [label, run] of Object.entries(work)) {
        const readings = Array.from({ length: 5 }, () =>
          growthOf(
            () => run(small),
            () => run(large),
          ).toFixed(1),
        );
        lines.push(`PROBE ${smallChars / 1000}k vs ${(4 * smallChars) / 1000}k | ${label}: ${readings.join(" ")}`);
      }
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  },
  LINEAR_TIME_TIMEOUT_MS * 4,
);
