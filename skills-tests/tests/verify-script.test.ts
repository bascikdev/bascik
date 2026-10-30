import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface TestIdGap {
  file: string;
  line: number;
  message: string;
}

interface VerifyScript {
  integratedPerFileChecksCompleted: (output: string) => boolean;
  testIdAdvisory: (root: string, configModule?: unknown) => TestIdGap[];
  formatTestIdAdvisory: (gaps: TestIdGap[]) => string;
}

const {
  integratedPerFileChecksCompleted,
  testIdAdvisory,
  formatTestIdAdvisory,
} = (await import(
  new URL("../../skills/bascik/scripts/verify.mjs", import.meta.url).href
)) as VerifyScript;

describe("verify script per-file check detection", () => {
  it("confirms integrated per-file results from the positive check summary", () => {
    expect(
      integratedPerFileChecksCompleted(
        "✓ 1 file checked by @bascik/language-server",
      ),
    ).toBe(true);
    expect(
      integratedPerFileChecksCompleted(
        "✓ 0 files checked by @bascik/language-server",
      ),
    ).toBe(true);
  });

  it("does not infer that checks ran from missing skip output", () => {
    expect(
      integratedPerFileChecksCompleted(
        "✓ 3 pages and 2 components checked — no errors",
      ),
    ).toBe(false);
    expect(integratedPerFileChecksCompleted("per-file checks skipped")).toBe(
      false,
    );
  });
});

describe("verify script data-testid advisory", () => {
  let root: string;
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const page = (body: string) =>
    `<!doctype html>\n<html lang="en">\n<head><title>Home</title></head>\n<body>\n${body}\n</body>\n</html>\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bascik-verify-testid-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports nothing for a project where every root, control, form, and landmark has a test id", () => {
    write(
      "src/components/like-button/like-button.html",
      `<style>
  .like { border: 0; }
</style>
<button
  class="like"
  type="button"
  data-testid="like-button"
>
  Like
</button>
<script>
  document.getElementById("x");
</script>
`,
    );
    write(
      "src/components/signup-form/signup-form.html",
      `<form class="signup" data-testid="signup-form">
  <label>Email <input type="email" name="email" data-testid="signup-form-email" /></label>
  <input type="hidden" name="source" value="home" />
  <button data-testid="signup-form-submit">Sign up</button>
</form>
`,
    );
    write(
      "src/pages/index.html",
      page(`<main data-testid="home">
  <h1>Hello</h1>
  <p>Read the <a href="/docs">docs</a>.</p>
  <img src="/a.png" alt="" />
  <like-button />
  <signup-form />
</main>`),
    );
    const gaps = testIdAdvisory(root);
    expect(gaps).toEqual([]);
    expect(formatTestIdAdvisory(gaps)).toBe("");
  });

  it("lists component roots and interactive parts without a test id, by file and line", () => {
    write(
      "src/components/plan-card/plan-card.html",
      `<!-- @bascik
One plan.
-->
<style>
  .plan { display: grid; }
</style>
<article class="plan">
  <h3>Plan</h3>
  <a href="/buy">Choose plan</a>
  <button type="button">Compare</button>
  <div role="switch" tabindex="0" aria-checked="false">Yearly</div>
  <span tabindex="-1">Not in the tab order</span>
</article>
`,
    );
    write(
      "src/pages/index.html",
      page(`<header><a href="/">Home</a></header>
<main>
  <plan-card />
  <form action="/search"><input type="search" name="q" aria-label="Search" /></form>
</main>`),
    );
    const gaps = testIdAdvisory(root);
    const where = gaps.map((gap) => `${gap.file}:${gap.line}`);
    expect(where).toEqual([
      "src/components/plan-card/plan-card.html:7",
      "src/components/plan-card/plan-card.html:10",
      "src/components/plan-card/plan-card.html:11",
      "src/pages/index.html:5",
      "src/pages/index.html:6",
      "src/pages/index.html:8",
      "src/pages/index.html:8",
    ]);
    expect(gaps[0].message).toContain('data-testid="plan-card"');
    expect(gaps[1].message).toContain('data-testid="plan-card-');
    const text = formatTestIdAdvisory(gaps);
    expect(text).toContain("src/components/plan-card/plan-card.html:7");
    expect(text).toMatch(/advisory/i);
    // A navigating link is found by its role and name; it is not a gap.
    expect(text).not.toContain("<a>");
  });

  it("counts a data-testid bound from a prop, and a usage tag's test id on a component used as the root", () => {
    write(
      "src/components/site-link/site-link.html",
      `<a data-bascik-attr-href="href" data-bascik-attr-data-testid="testid" role="button">Go</a>\n`,
    );
    write(
      "src/components/hero-banner/hero-banner.html",
      `<site-link data-testid="hero-banner" data-bascik-prop-href="/start" />\n`,
    );
    write("src/pages/index.html", page(`<main data-testid="home"></main>`));
    expect(testIdAdvisory(root)).toEqual([]);
  });

  it("reads the component and page folders from the project config", () => {
    write(
      "site/parts/promo-box/promo-box.html",
      `<div class="promo"><button>Go</button></div>\n`,
    );
    write("site/routes/index.html", page(`<main data-testid="home"></main>`));
    const gaps = testIdAdvisory(root, {
      default: {
        directory: { components: "site/parts", pages: "site/routes" },
      },
    });
    expect(gaps.map((gap) => `${gap.file}:${gap.line}`)).toEqual([
      "site/parts/promo-box/promo-box.html:1",
      "site/parts/promo-box/promo-box.html:1",
    ]);
  });
});
