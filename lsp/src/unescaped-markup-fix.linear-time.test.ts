/**
 * Linear-time check for the "Wrap template in html`...`" quick fix
 * (unescaped-markup-fix.test.ts has its behavior). CPU-growth sampling takes
 * minutes on Windows, so this runs in the `linear-time` Vitest project, not
 * `unit`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createCodeActions, createDiagnostics } from "./analyzer.js";
import type { ProjectSnapshot } from "./project.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const RULE = "server-script-unescaped-markup";

let root: string;
const snapshot = (): ProjectSnapshot => ({
  projectRoot: root,
  componentRoots: [path.join(root, "src/components")],
  componentMap: new Map(),
  componentMetadata: new Map(),
  importRoot: path.join(root, "src"),
  htmlUsageByFile: new Map(),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-unescaped-markup-"));
  fs.writeFileSync(path.join(root, "bascik.config.ts"), "export default {};\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PAGE = (script: string): string =>
  `<!DOCTYPE html>
<html>
<body>
  <main>
    <script data-bascik-server>
${script}
    </script>
  </main>
</body>
</html>
`;

const SEARCH = `      export default function (request) {
        const q = new URL(request.url).searchParams.get("q") ?? "";
        return \`<p>You searched for \${q}</p>\`;
      }`;

const open = (text: string) => {
  const fsPath = path.join(root, "src/pages/search.html");
  const doc = TextDocument.create(`file://${fsPath}`, "html", 1, text);
  return { doc, diags: createDiagnostics(doc, fsPath, snapshot()) };
};

describe("quick fix: Wrap template in html`...`, linear time", () => {
  it(
    "an existing import split by a long run of tabs: the fix reads it in linear time",
    () => {
      const script = (tabs: number) =>
        `      import { esc${"\t".repeat(tabs)}x } from "@bascik/bascik/html";\n${SEARCH}`;
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      const fixer = (tabs: number) => {
        const { doc, diags } = open(PAGE(script(tabs)));
        const diag = diags.filter((d) => d.code === RULE)[0];
        expect(diag).toBeDefined();
        return () => createCodeActions(doc, diag.range, diags, snapshot());
      };
      expect(growthOf(fixer(5_000), fixer(20_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
