import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  collectPreservedTargets,
  findPreservedCssTargets,
  findPreservedJsTargets,
} from "./preserved-targets.ts";

const names = (matches: { target: string }[]) => matches.map((m) => m.target);

describe("findPreservedCssTargets (finding 22)", () => {
  const markup = `
<div class="note">
  <code class="inline" id="snippet"><span class="tok">x</span></code>
  <span class="tok">outside</span>
  <x-chart class="chart-a"></x-chart>
  <section data-bascik-preserve="id class" id="kept-id" class="kept"><b class="inner">b</b></section>
  <em class="shared"></em><code class="shared"></code>
  <article data-bascik-preserve="id" id="only-id" class="still-scoped">a</article>
</div>`;
  const targets = collectPreservedTargets(markup, ["code", "x-*"]);

  it("flags an element selector for a preserved tag", () => {
    expect(
      names(findPreservedCssTargets("code { color: red; }", targets)),
    ).toEqual(["code"]);
  });

  it("flags a preserved tag in a descendant selector", () => {
    expect(
      names(findPreservedCssTargets(".note code { x: y }", targets)),
    ).toEqual(["code"]);
  });

  it("flags a class and an id that only a preserved element carries", () => {
    expect(
      names(
        findPreservedCssTargets(".inline { x: y }\n#snippet { x: y }", targets),
      ),
    ).toEqual(["inline", "snippet"]);
  });

  it("flags classes inside a preserved element's contents", () => {
    expect(names(findPreservedCssTargets(".tok { x: y }", targets))).toEqual(
      [],
    );
    expect(
      names(
        findPreservedCssTargets(
          ".x{}",
          collectPreservedTargets('<code><i class="in-code">x</i></code>', [
            "code",
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      names(
        findPreservedCssTargets(
          ".in-code{}",
          collectPreservedTargets('<code><i class="in-code">x</i></code>', [
            "code",
          ]),
        ),
      ),
    ).toEqual(["in-code"]);
  });

  it("flags a wildcard-preserved tag and its class", () => {
    expect(
      names(findPreservedCssTargets("x-chart, .chart-a { x: y }", targets)),
    ).toEqual(["x-chart", "chart-a"]);
  });

  it("flags data-bascik-preserve targets, the element's tag, and its descendants", () => {
    expect(
      names(
        findPreservedCssTargets(
          "section {}\n.kept {}\n#kept-id {}\n.inner {}\nb {}",
          targets,
        ),
      ),
    ).toEqual(["section", "kept", "kept-id", "inner", "b"]);
  });

  it("keeps the class and tag of an element whose directive preserves only its id", () => {
    expect(
      names(
        findPreservedCssTargets(
          "article {}\n.still-scoped {}\n#only-id {}",
          targets,
        ),
      ),
    ).toEqual(["only-id"]);
  });

  it("does not flag a class or tag that a scoped element also uses", () => {
    expect(
      names(findPreservedCssTargets(".shared {} span {} .tok {}", targets)),
    ).toEqual([]);
  });

  it("reports each match's offset in the stylesheet", () => {
    const css = "/* .inline */\n.a, .inline { x: y }";
    const [match] = findPreservedCssTargets(css, targets);
    expect(css.slice(match.index, match.index + match.length)).toBe(".inline");
    expect(match.message).toContain('".inline"');
  });

  it("ignores comments, strings, attribute selectors, pseudo arguments, and keyframes", () => {
    const css = `
/* code {} */
a[title="code .inline"] {}
a:not(.inline) {}
p::before { content: ".inline code"; }
@keyframes code { from { x: y } to { x: y } }
@media (min-width: 1px) { .inline { x: y } }`;
    expect(names(findPreservedCssTargets(css, targets))).toEqual(["inline"]);
  });

  it("flags nested rules after a declaration", () => {
    expect(
      names(
        findPreservedCssTargets(
          ".note { color: red; & code { x: y } }",
          targets,
        ),
      ),
    ).toEqual(["code"]);
  });

  it("matches tag names case-insensitively and classes case-sensitively", () => {
    const t = collectPreservedTargets(
      '<CODE class="Up">x</CODE><p class="up"></p>',
      ["code"],
    );
    expect(names(findPreservedCssTargets("Code {} .Up {} .up {}", t))).toEqual([
      "code",
      "Up",
    ]);
  });

  it("finds nothing when nothing is preserved", () => {
    const t = collectPreservedTargets('<code class="inline">x</code>', []);
    expect(findPreservedCssTargets("code {} .inline {}", t)).toEqual([]);
  });

  it("treats a bare or empty data-bascik-preserve as preserving everything", () => {
    for (const directive of [
      "data-bascik-preserve",
      'data-bascik-preserve=""',
    ]) {
      const t = collectPreservedTargets(
        `<p ${directive} class="bare" id="bare-id">x</p>`,
        [],
      );
      expect(
        names(findPreservedCssTargets(".bare {} #bare-id {} p {}", t)),
      ).toEqual(["bare", "bare-id", "p"]);
    }
  });

  it("skips markup inside script, style, textarea, and comments", () => {
    const t = collectPreservedTargets(
      `<!-- <code class="c1"></code> --><script>const s = '<code class="c2">';</script><textarea><code class="c3"></code></textarea><p class="c1 c2 c3"></p>`,
      ["code"],
    );
    expect(
      names(findPreservedCssTargets(".c1 {} .c2 {} .c3 {} code {}", t)),
    ).toEqual([]);
  });

  it("does not leave a preserved frame open after a void or self-closed element", () => {
    const t = collectPreservedTargets(
      '<br data-bascik-preserve class="v"><p class="after"></p>',
      [],
    );
    expect(names(findPreservedCssTargets(".v {} .after {}", t))).toEqual(["v"]);
  });

  it("ignores invalid preserve entries", () => {
    const t = collectPreservedTargets('<code class="c">x</code>', [
      "",
      "  ",
      "c(de",
    ]);
    expect(findPreservedCssTargets(".c {}", t)).toEqual([]);
  });

  it("stays linear on long unclosed input", () => {
    const start = performance.now();
    collectPreservedTargets(`<code class="a" ${'"'.repeat(50_000)}`, ["code"]);
    findPreservedCssTargets(
      `${"a[".repeat(20_000)}${"/*".repeat(20_000)}`,
      targets,
    );
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("findPreservedJsTargets (finding 22)", () => {
  const markup = `<code class="inline" id="snippet">x</code><p class="live"></p><x-chart class="chart-a"></x-chart>`;
  const targets = collectPreservedTargets(markup, ["code", "x-*"]);
  const cssClasses = new Set(["inline", "live", "chart-a"]);

  it("flags a class query that Bascik rewrites but only a preserved element carries", () => {
    const js = `
document.querySelector(".inline");
root.querySelectorAll('.note .inline');
el.closest(\`.chart-a\`);
document.getElementsByClassName("inline");
el.matches(".inline");`;
    expect(names(findPreservedJsTargets(js, targets, cssClasses))).toEqual([
      "inline",
      "inline",
      "chart-a",
      "inline",
      "inline",
    ]);
  });

  it("does not flag ids, tags, live classes, or classes the CSS never names", () => {
    const js = `
document.getElementById("snippet");
document.querySelector("#snippet");
document.querySelector("code");
document.querySelector(".live");
document.querySelector(".inline");`;
    expect(
      names(findPreservedJsTargets(js, targets, new Set(["live"]))),
    ).toEqual([]);
  });

  it("reports the offset of the class inside the string", () => {
    const js = 'const a = document.querySelector("p .inline");';
    const [match] = findPreservedJsTargets(js, targets, cssClasses);
    expect(js.slice(match.index, match.index + match.length)).toBe(".inline");
  });

  it("skips template literals with substitutions", () => {
    expect(
      findPreservedJsTargets(
        "q.querySelector(`.inline${x}`)",
        targets,
        cssClasses,
      ),
    ).toEqual([]);
  });
});

describe("preserved-targets copies", () => {
  it("keeps the language server's copy byte-identical to the compiler's", () => {
    const pkgCopy = readFileSync(
      new URL("./preserved-targets.ts", import.meta.url),
      "utf8",
    );
    const lspCopy = readFileSync(
      new URL("../../../lsp/src/preserved-targets.ts", import.meta.url),
      "utf8",
    );
    expect(lspCopy).toBe(pkgCopy);
  });
});
