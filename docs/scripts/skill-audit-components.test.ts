// Tests for skills/bascik/scripts/audit-components.mjs: one fixture project per finding, a clean project that must
// report nothing, the misuse cases (typo'd flags, a root that is not a project), and the repository's starter site.
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditProject,
  suggestTagName,
} from "../../skills/bascik/scripts/audit-components.mjs";
import { parseMarkup } from "../../skills/bascik/scripts/lib/markup.mjs";
import { buildComponentFiles } from "../../skills/bascik/scripts/new-component.mjs";

const script = fileURLToPath(
  new URL("../../skills/bascik/scripts/audit-components.mjs", import.meta.url),
);
const starterSite = fileURLToPath(
  new URL("../../examples/starter-site", import.meta.url),
);

type Finding = {
  rule: string;
  level: "warn" | "info";
  file: string;
  line: number;
  message: string;
  suggestion: string;
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** Write a throwaway Bascik project. Paths are relative to its root. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "bascik-audit-components-"));
  made.push(root);
  const all = {
    "package.json": JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@bascik/bascik": "*" },
    }),
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const page = (body: string, head = "") =>
  `<!doctype html>
<html lang="en">
  <head>
    <site-head />
${head}  </head>
  <body>
    <site-header />
    <main id="main">
${body}
    </main>
    <site-footer />
  </body>
</html>
`;

/** The layout components every fixture page uses, written the way the skill teaches. */
const layout = {
  "src/components/site-head/site-head.html": `<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/css/styles.css" />
`,
  "src/components/site-header/site-header.html": `<style>
  .bar {
    display: flex;
  }
</style>
<header class="bar" data-testid="site-header">
  <a href="/">Milk frother</a>
  <nav aria-label="Main">
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
</header>
`,
  "src/components/site-footer/site-footer.html": `<footer data-testid="site-footer">
  <p>Milk frother, since 2026.</p>
  <p><a href="/privacy">Privacy</a></p>
</footer>
`,
};

const clean = {
  ...layout,
  "src/pages/index.html": page(`      <home-hero />
      <feature-card data-bascik-prop-title="Quiet" data-bascik-prop-body="Under 40 dB." />
      <feature-card data-bascik-prop-title="Fast" data-bascik-prop-body="Foam in 60 seconds." />
      <signup-form />`),
  "src/pages/about.html": page(`      <h1>About</h1>
      <p>We make one thing well.</p>
      <feature-card data-bascik-prop-title="Repairable" data-bascik-prop-body="Every part is sold separately." />`),
  "src/components/home-hero/home-hero.html": `<section class="hero" data-testid="home-hero">
  <h1>Silky milk at home</h1>
  <p>A frother that fits on a shelf and cleans itself.</p>
  <a class="cta" href="/shop">Shop now</a>
</section>
`,
  "src/components/feature-card/feature-card.html": `<article class="card" data-testid="feature-card">
  <h2 data-bascik-prop-title>Feature</h2>
  <p data-bascik-prop-body></p>
</article>
`,
  "src/components/signup-form/signup-form.html": `<form class="signup" id="form" data-testid="signup-form">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />
  <button type="submit">Sign up</button>
  <p id="status" role="status"></p>
</form>
<script src="signup-form.ts"></script>
`,
  "src/components/signup-form/signup-form.ts": `const form = document.getElementById("form") as HTMLFormElement;
const status = document.getElementById("status") as HTMLElement;
form.addEventListener("submit", (event: SubmitEvent) => {
  event.preventDefault();
  status.textContent = "Thanks";
});
`,
  "src/lib/greeting.ts": `export const greeting = (name: string): string => \`Hello \${name}\`;\n`,
  "src/pages/css/styles.css": "body { margin: 0; }\n",
};

const audit = async (root: string, options = {}) =>
  (await auditProject(root, options)) as {
    findings: Finding[];
    stats: Record<string, any>;
  };
const rules = (findings: Finding[]) => findings.map((f) => f.rule);

describe("parseMarkup", () => {
  it("records tags, attributes, and 1-based lines, and never parses script or comment bodies", () => {
    const tree = parseMarkup(`<div class="a b">
  <!-- <section class="fake"> -->
  <script>const x = "<section>";</script>
  <img src="a.png" alt="">
  <my-card data-bascik-prop-title="T" />
  <p>one
  <p>two
</div>`);
    const div = tree.children[0];
    expect(div.tag).toBe("div");
    expect(div.attrs.class).toBe("a b");
    expect(div.line).toBe(1);
    expect(div.endLine).toBe(8);
    expect(div.children.map((c: { tag: string }) => c.tag)).toEqual([
      "script",
      "img",
      "my-card",
      "p",
      "p",
    ]);
    expect(div.children[0].body).toBe('const x = "<section>";');
    expect(div.children[2].line).toBe(5);
    expect(div.children[2].attrs["data-bascik-prop-title"]).toBe("T");
  });

  it("closes unclosed elements at the end instead of throwing on broken markup", () => {
    const tree = parseMarkup("<section><div><p>open\n</section></span>");
    expect(tree.children[0].tag).toBe("section");
    expect(tree.children[0].children[0].tag).toBe("div");
  });
});

describe("suggestTagName", () => {
  it("builds a hyphenated, lowercase tag name from a class, id, label, or heading", () => {
    expect(suggestTagName("section", "Pricing")).toBe("pricing-section");
    expect(suggestTagName("article", "feature")).toBe("feature-card");
    expect(suggestTagName("section", "customer-quotes")).toBe(
      "customer-quotes",
    );
    expect(suggestTagName("form", "Join the waitlist today!")).toBe(
      "join-waitlist-form",
    );
    expect(suggestTagName("div", "")).toBe("page-block");
  });
});

describe("audit-components", () => {
  it("reports nothing for a page composed of components with TypeScript scripts", async () => {
    const result = await audit(project(clean));
    expect(result.findings).toEqual([]);
    expect(result.stats.pages).toBe(2);
    expect(result.stats.components).toBe(6);
    expect(result.stats.tsScripts).toBe(1);
    expect(result.stats.jsScripts).toBe(0);
  });

  it("flags a page longer than the limit with the line count and a way to split it", async () => {
    const paragraphs = Array.from(
      { length: 90 },
      (_, i) => `      <p>Paragraph ${i} about the frother.</p>`,
    ).join("\n");
    const root = project({
      ...layout,
      "src/pages/index.html": page(paragraphs),
    });
    const { findings } = await audit(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "oversized-page",
      level: "warn",
      file: "src/pages/index.html",
      line: 1,
    });
    expect(findings[0].message).toMatch(/\d+ lines of markup \(limit 80\)/);
    expect(findings[0].suggestion).toMatch(/content\/.*\.md/);

    const raised = await audit(root, { maxPageLines: 200 });
    expect(raised.findings).toEqual([]);
  });

  it("flags an oversized component and points at slots, child components, and companion files", async () => {
    const rows = Array.from(
      { length: 130 },
      (_, i) => `  <span class="cell">Cell ${i}</span>`,
    ).join("\n");
    const root = project({
      ...clean,
      "src/components/spec-sheet/spec-sheet.html": `<div class="sheet">\n${rows}\n</div>\n`,
      "src/pages/specs.html": page("      <spec-sheet />"),
    });
    const { findings } = await audit(root);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "oversized-component",
      file: "src/components/spec-sheet/spec-sheet.html",
      line: 1,
    });
    expect(findings[0].message).toMatch(/limit 120/);
  });

  it("flags an inline section with a nameable job on its own line and suggests a tag name", async () => {
    const root = project({
      ...clean,
      "src/pages/pricing.html": page(`      <h1>Pricing</h1>
      <section class="plans" aria-labelledby="plans-title">
        <h2 id="plans-title">Plans</h2>
        <div class="plan">
          <h3>Home</h3>
          <p>One frother.</p>
          <p>$49</p>
        </div>
        <div class="plan-pro">
          <h3>Cafe</h3>
          <p>Three frothers and a stand.</p>
          <p>$129</p>
        </div>
        <p class="note">Prices include shipping.</p>
      </section>`),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["inline-section"]);
    expect(findings[0]).toMatchObject({
      file: "src/pages/pricing.html",
      line: 10,
      level: "warn",
    });
    expect(findings[0].message).toMatch(/<section class="plans">/);
    expect(findings[0].suggestion).toContain("<plans-section />");
  });

  it("leaves short sections, <main>, and unnamed wrappers alone", async () => {
    const root = project({
      ...clean,
      "src/pages/faq.html": page(`      <section>
        <h2>Short</h2>
        <p>Two lines is not a component.</p>
      </section>`),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  it("flags the same block pasted several times, with every location, and not its children again", async () => {
    const card = (title: string) => `      <article class="review">
        <h3>${title}</h3>
        <p class="stars">5 stars</p>
        <p class="quote">Great foam.</p>
      </article>`;
    const root = project({
      ...clean,
      "src/pages/reviews.html": page(
        [card("Ana"), card("Ben"), card("Cy")].join("\n"),
      ),
      "src/pages/press.html": page(card("Daily Brew")),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["repeated-block"]);
    expect(findings[0]).toMatchObject({
      file: "src/pages/press.html",
      line: 9,
    });
    expect(findings[0].message).toMatch(/4 times in 2 files/);
    expect(findings[0].message).toMatch(/src\/pages\/reviews\.html:9/);
    expect(findings[0].suggestion).toContain("<review-card");
    expect(findings[0].suggestion).toContain("data-bascik-prop-");
  });

  // Found in a real-site evaluation: four sections each hand-wrote the same eyebrow, heading, and intro, with a
  // modifier class on one and a link inside another, so the exact-structure check never matched.
  it("flags the same heading group hand-written in three or more files despite modifier classes and inline links", async () => {
    const head = (cls: string, extra = "") => `<section class="block">
  <div${cls}>
    <p class="eyebrow">Label</p>
    <h2>Heading</h2>
    <p>Intro text${extra}.</p>
  </div>
</section>
`;
    const root = project({
      ...clean,
      "src/components/feature-grid/feature-grid.html": head(
        ' class="section-head centered"',
      ),
      "src/components/how-it-works/how-it-works.html": head(""),
      "src/components/faq-section/faq-section.html": head(
        "",
        ' <a href="mailto:hi@example.com">Email us</a>',
      ),
      "src/pages/features.html": page(
        "      <feature-grid />\n      <how-it-works />\n      <faq-section />",
      ),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["repeated-pattern"]);
    expect(findings[0]).toMatchObject({
      file: "src/components/faq-section/faq-section.html",
      line: 2,
    });
    expect(findings[0].message).toMatch(/3 files/);
    expect(findings[0].message).toContain(
      "src/components/how-it-works/how-it-works.html:2",
    );
    expect(findings[0].suggestion).toContain("<section-head");
    expect(findings[0].suggestion).toContain("data-bascik-prop-");
  });

  it("leaves a heading group that appears in only two files alone (a 404 and a home page may both open with h1 and p)", async () => {
    const root = project({
      ...clean,
      "src/pages/404.html": page(
        "      <section>\n        <h1>Not found</h1>\n        <p>Gone.</p>\n        <p><a href='/'>Home</a></p>\n      </section>",
      ),
      "src/pages/thanks.html": page(
        "      <section>\n        <h1>Thanks</h1>\n        <p>Sent.</p>\n        <p>Back soon.</p>\n      </section>",
      ),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  // Found in a real-site evaluation: a bakery's street address was typed into three components.
  it("flags the same fact typed into several files, with every location", async () => {
    const address = "214 Larkspur Avenue, Millbrook, OR 97000";
    const root = project({
      ...clean,
      "src/components/visit-info/visit-info.html": `<section class="visit">\n  <h2>Visit</h2>\n  <address>${address}</address>\n  <p>Park on the side street.</p>\n  <a href="/map">Map</a>\n</section>\n`,
      "src/components/hours-section/hours-section.html": `<section class="hours">\n  <h2>Hours</h2>\n  <p>Daily 7 to 3</p>\n  <p class="where">${address}</p>\n</section>\n`,
      "src/pages/visit.html": page(
        "      <visit-info />\n      <hours-section />",
      ),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["repeated-text"]);
    expect(findings[0]).toMatchObject({
      file: "src/components/hours-section/hours-section.html",
      line: 4,
    });
    expect(findings[0].message).toContain(address);
    expect(findings[0].message).toContain(
      "src/components/visit-info/visit-info.html:3",
    );
    expect(findings[0].suggestion).toMatch(/one place/);
  });

  it("ignores short repeated text, text in the head, and text repeated inside one file", async () => {
    const root = project({
      ...clean,
      "src/components/plan-a/plan-a.html": `<article class="a">\n  <a href="/buy">Choose plan</a>\n  <p>Billed monthly, cancel any time.</p>\n  <p>Billed monthly, cancel any time.</p>\n</article>\n`,
      "src/components/plan-b/plan-b.html": `<article class="b">\n  <a href="/buy">Choose plan</a>\n</article>\n`,
      "src/pages/plans.html": page(
        "      <plan-a />\n      <plan-b />",
        "    <title>Milk frother plans and prices</title>\n",
      ),
      "src/pages/prices.html": page(
        "      <plan-a />\n      <plan-b />",
        "    <title>Milk frother plans and prices</title>\n",
      ),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  // Found in a real-site evaluation: every page passed the same brand name to the header and the footer.
  it("flags a prop that every use passes with the same value", async () => {
    const pageWith = (title: string) =>
      page(
        `      <page-title data-bascik-prop-text="${title}" data-bascik-prop-brand="Mara Lindqvist" />`,
      );
    const root = project({
      ...clean,
      "src/components/page-title/page-title.html": `<header class="page-title">\n  <p class="brand" data-bascik-prop-brand>My Site</p>\n  <h1 data-bascik-prop-text></h1>\n</header>\n`,
      "src/pages/work.html": pageWith("Work"),
      "src/pages/team.html": pageWith("Team"),
      "src/pages/press.html": pageWith("Press"),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["constant-prop"]);
    expect(findings[0]).toMatchObject({
      file: "src/components/page-title/page-title.html",
    });
    expect(findings[0].message).toContain("brand");
    expect(findings[0].message).toContain('"Mara Lindqvist"');
    expect(findings[0].message).toMatch(/all 3 uses/);
    expect(findings[0].suggestion).toContain("Mara Lindqvist");
  });

  it("does not flag a prop whose value differs, or one used fewer than three times", async () => {
    const root = project({
      ...clean,
      "src/components/page-title/page-title.html": `<header class="page-title">\n  <p class="brand" data-bascik-prop-brand>My Site</p>\n  <h1 data-bascik-prop-text></h1>\n</header>\n`,
      "src/pages/work.html": page(
        `      <page-title data-bascik-prop-text="Work" data-bascik-prop-brand="Mara" />`,
      ),
      "src/pages/team.html": page(
        `      <page-title data-bascik-prop-text="Team" data-bascik-prop-brand="Mara" />`,
      ),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  it("flags a tiny component used once and suggests inlining it into the one place that uses it", async () => {
    const root = project({
      ...clean,
      "src/components/hero-title/hero-title.html": `<h1 data-bascik-prop-text></h1>\n`,
      "src/pages/story.html": page(
        `      <hero-title data-bascik-prop-text="Our story" />\n      <p>It started with bad foam.</p>`,
      ),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["tiny-component"]);
    expect(findings[0]).toMatchObject({
      file: "src/components/hero-title/hero-title.html",
      line: 1,
    });
    expect(findings[0].message).toContain("src/pages/story.html:9");
    expect(findings[0].suggestion).toMatch(/inline/i);
  });

  it("keeps tiny components that are reused, own a script, or compose other components", async () => {
    const root = project({
      ...clean,
      "src/components/price-tag/price-tag.html": `<span class="price" data-bascik-prop-amount></span>\n`,
      "src/components/live-clock/live-clock.html": `<time id="t"></time>\n<script type="text/typescript">\n  const t = document.getElementById("t") as HTMLTimeElement;\n  t.textContent = new Date().toISOString();\n</script>\n`,
      "src/components/deal-row/deal-row.html": `<div class="deals"><price-tag data-bascik-prop-amount="$9" /></div>\n`,
      "src/pages/shop.html": page(
        `      <price-tag data-bascik-prop-amount="$49" />\n      <price-tag data-bascik-prop-amount="$129" />\n      <live-clock />\n      <deal-row />`,
      ),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  it("counts a component printed by a build helper as a use", async () => {
    const root = project({
      ...clean,
      "src/components/post-link/post-link.html": `<a class="post" data-bascik-attr-href="href" data-bascik-prop-title></a>\n`,
      "src/lib/posts.ts": `export const links = (slugs: string[]): string => slugs.map((s) => \`<post-link data-bascik-prop-href="/\${s}" />\`).join("");\n`,
      "src/pages/blog.html": page(
        `      <post-link data-bascik-prop-href="/a" data-bascik-prop-title="A" />`,
      ),
    });
    expect(rules((await audit(root)).findings)).toEqual([]);
  });

  it("flags a prop a component only forwards to a child, naming the whole chain", async () => {
    const root = project({
      ...clean,
      "src/components/product-panel/product-panel.html": `<section class="panel">
  <h2>Product</h2>
  <product-body data-bascik-attr-data-bascik-prop-price="price" />
</section>
`,
      "src/components/product-body/product-body.html": `<div class="body">
  <p>Ships in a day.</p>
  <price-line data-bascik-attr-data-bascik-prop-amount="price" />
</div>
`,
      "src/components/price-line/price-line.html": `<p class="line">Price: <span data-bascik-prop-amount></span></p>\n<p class="line">Tax included.</p>\n`,
      "src/pages/product.html": page(
        `      <product-panel data-bascik-prop-price="$49" />\n      <product-panel data-bascik-prop-price="$129" />\n      <product-body data-bascik-prop-price="$9" />\n      <price-line data-bascik-prop-amount="$1" />`,
      ),
    });
    const { findings } = await audit(root);
    expect(rules(findings)).toEqual(["prop-drilling", "prop-drilling"]);
    const [body, panel] = findings;
    expect(panel).toMatchObject({
      file: "src/components/product-panel/product-panel.html",
      line: 3,
    });
    expect(panel.message).toContain(
      "<product-panel> -> <product-body> -> <price-line>",
    );
    expect(panel.suggestion).toMatch(/slot/);
    expect(body.file).toBe("src/components/product-body/product-body.html");
  });

  it("does not flag a prop the component renders itself and also hands to a child", async () => {
    const root = project({
      ...clean,
      "src/components/plan-box/plan-box.html": `<div class="box">
  <h3 data-bascik-prop-name></h3>
  <plan-price data-bascik-attr-data-bascik-prop-label="name" />
</div>
`,
      "src/components/plan-price/plan-price.html": `<p class="price"><span data-bascik-prop-label></span> costs more.</p>\n<p>Monthly.</p>\n`,
      "src/pages/plans.html": page(
        `      <plan-box data-bascik-prop-name="Home" />\n      <plan-box data-bascik-prop-name="Cafe" />\n      <plan-price data-bascik-prop-label="Solo" />`,
      ),
    });
    expect((await audit(root)).findings).toEqual([]);
  });

  it("flags browser JavaScript and .js helpers where TypeScript is expected, and stays quiet with allowJs", async () => {
    const root = project({
      ...clean,
      "src/components/like-button/like-button.html": `<button id="btn" type="button">Like</button>
<script>
  const btn = document.getElementById("btn");
  btn.addEventListener("click", () => btn.classList.toggle("on"));
</script>
`,
      "src/components/old-widget/old-widget.html": `<div id="w">Old</div>\n<script src="old-widget.js"></script>\n`,
      "src/components/old-widget/old-widget.js": `document.getElementById("w").hidden = false;\n`,
      "src/lib/format.mjs": `export const format = (n) => String(n);\n`,
      "src/pages/likes.html": page(
        `      <like-button />\n      <like-button />\n      <old-widget />\n      <script type="application/ld+json">{"@type":"WebPage"}</script>\n      <script data-bascik-build>\n        export default () => "<p>built</p>";\n      </script>\n      <script type="text/typescript">\n        const n: number = 1;\n      </script>\n      <script>\n        console.log("page");\n      </script>\n      <script src="https://cdn.example.com/lib.js"></script>`,
      ),
    });
    const { findings, stats } = await audit(root);
    const js = findings.filter((f) => f.rule === "js-not-ts");
    expect(js.map((f) => `${f.file}:${f.line}`).sort()).toEqual([
      "src/components/like-button/like-button.html:2",
      "src/components/old-widget/old-widget.html:2",
      "src/lib/format.mjs:1",
      "src/pages/likes.html:19",
    ]);
    const like = js.find((f) => f.file.includes("like-button"))!;
    expect(like.suggestion).toContain('type="text/typescript"');
    expect(like.suggestion).toContain("like-button.ts");
    const pageScript = js.find((f) => f.file.includes("likes.html"))!;
    expect(pageScript.suggestion).toContain('type="text/typescript"');
    expect(js.find((f) => f.file.includes("old-widget"))!.suggestion).toContain(
      "old-widget.ts",
    );
    expect(js.find((f) => f.file.endsWith(".mjs"))!.suggestion).toContain(
      "format.ts",
    );
    expect(stats.jsScripts).toBe(3);
    expect(stats.tsScripts).toBe(2);

    const allowed = await audit(root, { allowJs: true });
    expect(allowed.findings.filter((f) => f.rule === "js-not-ts")).toEqual([]);
  });

  it("flags bascik.config.js and an inline module script with the TypeScript way to write each", async () => {
    const root = project({
      ...clean,
      "bascik.config.js": "export default {};\n",
      "src/components/confetti-button/confetti-button.html": `<button id="go" type="button">Party</button>
<script type="module">
  import { celebrate } from "/assets/js/confetti-bundle.mjs";
  document.getElementById("go").addEventListener("click", celebrate);
</script>
`,
      "src/pages/party.html": page("      <confetti-button />"),
    });
    const { findings } = await audit(root);
    const js = findings.filter((f) => f.rule === "js-not-ts");
    expect(js.map((f) => f.file).sort()).toEqual([
      "bascik.config.js",
      "src/components/confetti-button/confetti-button.html",
    ]);
    expect(js.find((f) => f.file === "bascik.config.js")!.suggestion).toContain(
      "bascik.config.ts",
    );
    expect(js.find((f) => f.file.includes("confetti"))!.suggestion).toContain(
      '<script type="module" src="confetti-button.ts">',
    );
  });

  it('misuse: flags a page <script src="x.ts">, which Bascik does not compile, even with allowJs', async () => {
    const root = project({
      ...clean,
      "src/pages/app.ts": `const n: number = 1;\n`,
      "src/pages/tool.html": page(`      <script src="app.ts"></script>`),
    });
    for (const allowJs of [false, true]) {
      const { findings } = await audit(root, { allowJs });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        rule: "js-not-ts",
        file: "src/pages/tool.html",
        line: 9,
      });
      expect(findings[0].message).toMatch(/not compiled/);
    }
  });

  it("reads directory.pages and directory.components from the config", async () => {
    const root = project({
      "bascik.config.ts": `export default { directory: { pages: "site/pages", components: ["site/parts"] } };\n`,
      "site/parts/site-head/site-head.html":
        layout["src/components/site-head/site-head.html"],
      "site/parts/site-header/site-header.html":
        layout["src/components/site-header/site-header.html"],
      "site/parts/site-footer/site-footer.html":
        layout["src/components/site-footer/site-footer.html"],
      "site/parts/x-y/x-y.html": `<b>x</b>\n`,
      "site/pages/index.html": page("      <x-y />"),
    });
    const { findings, stats } = await audit(root);
    expect(stats.pages).toBe(1);
    expect(rules(findings)).toEqual(["tiny-component"]);
    expect(findings[0].file).toBe("site/parts/x-y/x-y.html");
  });
});

describe("audit-components CLI", () => {
  const cli = (args: string[], cwd?: string) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
    });

  it("prints file:line, the finding, and the suggestion, and exits 1 on a warning", () => {
    const root = project({
      ...clean,
      "src/components/hero-title/hero-title.html": `<h1 data-bascik-prop-text></h1>\n`,
      "src/pages/story.html": page(
        `      <hero-title data-bascik-prop-text="Our story" />`,
      ),
    });
    const run = cli(["--root", root]);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(
      /warn {2}tiny-component {2}src\/components\/hero-title\/hero-title\.html:1/,
    );
    expect(run.stdout).toMatch(/\n {4}-> /);
  });

  it("exits 0 and says so for a clean project, and prints JSON with stats", () => {
    const root = project(clean);
    const run = cli([], root);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/No component structure problems found/);
    const json = cli(["--json", "--root", root]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.findings).toEqual([]);
    expect(parsed.stats.medianPageLines).toBeGreaterThan(0);
    expect(parsed.stats.largestFile.file).toMatch(/\.html$/);
  });

  it("misuse: rejects a typo'd flag, a non-numeric limit, and a root without pages, with exit code 2", () => {
    const typo = cli(["--alow-js"]);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toMatch(/audit-components: .*--alow-js/);
    const limit = cli(["--max-page-lines", "eighty"]);
    expect(limit.status).toBe(2);
    expect(limit.stderr).toMatch(
      /--max-page-lines must be a positive whole number/,
    );
    const empty = mkdtempSync(join(tmpdir(), "bascik-audit-empty-"));
    made.push(empty);
    const missing = cli(["--root", empty]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/no pages directory at src\/pages/);
  });

  it("--help explains every rule", () => {
    const run = cli(["--help"]);
    expect(run.status).toBe(0);
    for (const rule of [
      "oversized-page",
      "oversized-component",
      "inline-section",
      "repeated-block",
      "repeated-pattern",
      "repeated-text",
      "constant-prop",
      "tiny-component",
      "prop-drilling",
      "js-not-ts",
    ])
      expect(run.stdout).toContain(rule);
  });
});

describe("new-component scaffolds TypeScript by default", () => {
  it("writes an inline script as text/typescript, and plain JavaScript only with inline-js", () => {
    const ts = buildComponentFiles("nav-toggle", { script: "inline" });
    expect(ts["nav-toggle.html"]).toContain('<script type="text/typescript">');
    expect(ts["nav-toggle.html"]).toContain(
      'document.getElementById("root") as HTMLElement',
    );
    const js = buildComponentFiles("nav-toggle", { script: "inline-js" });
    expect(js["nav-toggle.html"]).toMatch(/<script>\n/);
    expect(js["nav-toggle.html"]).not.toContain(" as HTMLElement");
    const companion = buildComponentFiles("nav-toggle", { script: "ts" });
    expect(companion["nav-toggle.html"]).toContain(
      '<script src="nav-toggle.ts"></script>',
    );
    expect(companion["nav-toggle.ts"]).toContain("as HTMLElement");
  });

  it("puts a data-testid on the component root", () => {
    const files = buildComponentFiles("feature-card", { props: ["title"] });
    expect(files["feature-card.html"]).toMatch(
      /<div class="feature-card" id="root" data-testid="feature-card">/,
    );
  });

  it("scaffolds components the audit accepts, and flags the inline-js one", async () => {
    const files: Record<string, string> = { ...clean };
    for (const [tag, script] of [
      ["menu-toggle", "inline"],
      ["menu-panel", "ts"],
      ["old-toggle", "inline-js"],
    ]) {
      for (const [name, text] of Object.entries(
        buildComponentFiles(tag, { script, props: ["label"] }) as Record<
          string,
          string
        >,
      ))
        files[`src/components/${tag}/${name}`] = text;
    }
    files["src/pages/menu.html"] = page(
      "      <menu-toggle />\n      <menu-panel />\n      <old-toggle />",
    );
    const { findings } = await audit(project(files));
    expect(findings.map((f) => `${f.rule} ${f.file}`)).toEqual([
      "js-not-ts src/components/old-toggle/old-toggle.html",
    ]);
  });
});

describe("the starter site follows the composition and TypeScript rules", () => {
  it("has no audit findings, including the shared example components it uses", async () => {
    const { findings, stats } = await audit(starterSite);
    expect(findings).toEqual([]);
    expect(stats.jsScripts).toBe(0);
    expect(stats.tsScripts).toBeGreaterThan(0);
  });
});
