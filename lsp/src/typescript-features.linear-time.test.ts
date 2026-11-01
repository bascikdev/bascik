/**
 * Linear-time checks for TypeScript language features in a page's blocks, which run as the author types (a
 * completion per `.`, a signature per `(`, a hover per pause).
 *
 * In a page with four times the blocks, a request may cost about four times as much (finding the block, mapping
 * offsets, walking the shared text to the cursor), never sixteen: nothing may rescan the page per block or per
 * completion entry.
 */
import { afterAll, describe, expect, it } from "vitest";
import { TypeScriptProject } from "./typescript-service.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";
import { createFixture, typescript6 as ts } from "./typescript.test.util.js";

const fixture = createFixture({
  "bascik.config.ts": "export default {};\n",
  "src/lib/frother.ts":
    "export interface Frother {\n  speed: number;\n  label: string;\n}\nexport const frother: Frother = { speed: 1200, label: 'Milk frother' };\nexport function froth(level: number): string {\n  return String(level);\n}\n",
});
afterAll(() => fixture.remove());

/** A page of `count` client blocks; the last one imports the helper and has the cursor's text. */
const pageOf = (count: number, last: string) =>
  [
    ...Array.from(
      { length: count - 1 },
      (_, index) =>
        `<section>Milk frother ${index}</section>\n<script type="text/typescript">\n  const speed${index}: number = ${index};\n  document.title = String(speed${index});\n</script>\n`,
    ),
    `<script type="text/typescript">\n  import { frother, froth } from "@/lib/frother.ts";\n  ${last}\n</script>\n`,
  ].join("");

describe("TypeScript language features: linear time", () => {
  for (const crossFileOnly of [false, true]) {
    it(
      `costs a member completion and a signature in proportion to the page's blocks${crossFileOnly ? ", beside an editor's own mode" : ""}`,
      () => {
        const requestIn = (count: number) => {
          const service = new TypeScriptProject({
            ts,
            projectRoot: fixture.root,
            importRoot: fixture.file("src"),
          });
          const file = fixture.write(
            `src/pages/features-${count}-${crossFileOnly}.html`,
            pageOf(count, "frother.speed;"),
          );
          let typed = 0;
          return () => {
            typed++;
            // A new text per sample, as each keystroke is: the program is brought up to date every time.
            const member = pageOf(count, `frother.s${"p".repeat(typed % 3)}`);
            const offset = member.lastIndexOf("frother.s") + 9;
            const entries = service.feature(
              file,
              member,
              {},
              {
                kind: "completion",
                offset,
                crossFileOnly,
              },
            );
            if (!entries?.some((entry) => entry.name === "speed"))
              throw new Error("no member completion");
            const call = pageOf(count, `froth(${typed});`);
            const help = service.feature(
              file,
              call,
              {},
              {
                kind: "signatureHelp",
                offset: call.lastIndexOf("froth(") + 6,
                crossFileOnly,
              },
            );
            if (!help) throw new Error("no signature help");
          };
        };
        expect(growthOf(requestIn(10), requestIn(40))).toBeLessThan(8);
      },
      LINEAR_TIME_TIMEOUT_MS,
    );
  }
});
