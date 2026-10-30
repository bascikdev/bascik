/**
 * @bascik/bascik/html runs on the published Node floor (22.22) as well as on
 * Node 24 and in workerd. The module is bundled from source (no type
 * stripping needed) and a smoke script exercising every export runs under a
 * Node 22.22 binary: BASCIK_NODE22_BIN, or nvm's v22.22.0 when installed.
 * Without one the case is skipped with the reason in its name.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const NODE22 = [
  process.env.BASCIK_NODE22_BIN,
  join(homedir(), ".nvm/versions/node/v22.22.0/bin/node"),
].find((p): p is string => typeof p === "string" && existsSync(p));

const SMOKE = `
import { html, raw, esc, safeUrl, json, isHtml, HtmlError } from "./html.mjs";
const out = [];
out.push(String(html\`<p title="\${'"'}">\${"<b>"}</p>\`));
out.push(String(html\`<ul>\${["a", "b"].map((x) => html\`<li>\${x}</li>\`)}</ul>\`));
out.push(String(html\`<a href="\${"javascript:alert(1)"}">x</a>\`));
out.push(String(html\`<script type="application/json">\${json({ a: "</script>" })}</script>\`));
out.push(String(raw("<i>ok</i>")), esc("<&>"), safeUrl("https://x.example/y", { origins: ["https://x.example"] }));
out.push(String(isHtml(raw("x"))));
try { html\`<button onclick="\${1}">\`; } catch (e) { out.push(e instanceof HtmlError ? e.code : "wrong"); }
console.log(JSON.stringify(out));
`;

describe("@bascik/bascik/html on Node 22.22", () => {
  it.skipIf(!NODE22)(
    `renders every context and refuses a handler (${NODE22 ?? "no Node 22.22 binary found: set BASCIK_NODE22_BIN"})`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "bascik-html-node22-"));
      try {
        await build({
          entryPoints: [resolve(import.meta.dirname, "../html.ts")],
          bundle: true,
          format: "esm",
          platform: "neutral",
          target: "node22",
          outfile: join(dir, "html.mjs"),
          logLevel: "silent",
        });
        writeFileSync(join(dir, "smoke.mjs"), SMOKE);
        const result = spawnSync(NODE22!, ["smoke.mjs"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(
          spawnSync(NODE22!, ["--version"], { encoding: "utf8" }).stdout.trim(),
        ).toBe("v22.22.0");
        expect(JSON.parse(result.stdout)).toEqual([
          `<p title="&quot;">&lt;b&gt;</p>`,
          "<ul><li>a</li><li>b</li></ul>",
          `<a href="about:invalid">x</a>`,
          `<script type="application/json">{"a":"\\u003c/script\\u003e"}</script>`,
          "<i>ok</i>",
          "&lt;&amp;&gt;",
          "https://x.example/y",
          "true",
          "event-handler",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
