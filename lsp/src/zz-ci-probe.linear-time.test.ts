/** TEMPORARY: prints growth readings on CI for the flaky "quote that never ends" scan. Removed before merge. */
import { it } from "vitest";
import { extractPageScopeScripts } from "./typescript-blocks.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const page = (n: number) => `text/javascript <script type="${"a".repeat(n)}`;
const reference = (html: string) => html.indexOf("\u0001");
// Quadratic control: a full rescan from each 1M-character offset, so 4x the text is about 16x the reading.
const quadratic = (html: string) => {
  let found = 0;
  for (let at = 0; at < html.length; at += 1_000_000)
    found += html.indexOf("\u0001", at);
  return found;
};
const work: Record<string, (html: string) => unknown> = {
  "new scan": extractPageScopeScripts,
  "page-sized toLowerCase (what the old scan paid)": (html) =>
    html.toLowerCase(),
  "quadratic control": quadratic,
};
it(
  "CI probe",
  () => {
    const lines: string[] = [];
    for (const smallChars of [1_000_000, 4_000_000]) {
      const small = page(smallChars);
      const large = page(4 * smallChars);
      for (const [label, run] of Object.entries(work)) {
        const readings = Array.from({ length: 5 }, () => {
          const growth = growthOf(
            () => run(small),
            () => run(large),
          );
          const base = growthOf(
            () => reference(small),
            () => reference(large),
          );
          return `${growth.toFixed(1)}/${base.toFixed(1)}=${(growth / base).toFixed(2)}`;
        });
        lines.push(
          `PROBE ${smallChars / 1000}k vs ${(4 * smallChars) / 1000}k | ${label}: ${readings.join("  ")}`,
        );
      }
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  },
  LINEAR_TIME_TIMEOUT_MS * 4,
);
