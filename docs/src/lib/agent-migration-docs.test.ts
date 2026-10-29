/**
 * The "Migrating with Coding Agents" how-to page and the bascik-refactor skill files it hands to readers.
 *
 * The page is a recipe a reader copies from on day one, so every file it names must exist, every script must ship
 * with a unit test, and every entry point (switch guides, agent skills page, the skill itself) must lead to it.
 * The global tests (nav-label-h1, seo-meta, link-integrity, docs-editorial, skill-links, skill-bundle,
 * create/src/skill-sync) cover the shared rules once the page and files exist; this file pins what is specific here.
 *
 * Misuse lens: a page added to the nav in the wrong place, a label that drifts from the h1, a GitHub link to a
 * script that was renamed, a script shipped without a test, a demo pane wired to a marker that does not exist,
 * a skill template with a backticked example route (skill-links would read it as a docs path), and a page that
 * hints at one real site instead of the generic example.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { NAV } from "./nav.ts";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const SKILL_DIR = path.join(REPO_ROOT, "skills/bascik-refactor");

const PAGE_HREF = "/how-to/agent-migration";
const LABEL = "Migrating with Coding Agents";
const MD = "content/how-to/agent-migration.md";
const SHELL = "src/pages/how-to/agent-migration.html";

const readDocs = (rel: string) =>
  readFileSync(path.join(DOCS_ROOT, rel), "utf8");
const readRepo = (rel: string) =>
  readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** The md with fenced code blocks removed: prose a reader sees as text. */
const prose = (md: string) => md.replace(/```[\s\S]*?```/g, "");

const REFERENCES = [
  "references/production-parity.md",
  "references/templates/execution-contract.md",
  "references/templates/prompt-pack-index.md",
  "references/templates/one-route.md",
  "references/templates/one-failure.md",
  "references/templates/driver-agent.md",
  "references/templates/decisions-ledger.md",
  "references/templates/visual-review.md",
];

const SCRIPTS = [
  "scripts/geometry-diff.mjs",
  "scripts/compare-route.mjs",
  "scripts/breakpoint-matrix.mjs",
  "scripts/lighthouse-gate.mjs",
  "scripts/llms-txt.mjs",
  "scripts/responsive-webp.mjs",
  "scripts/worker-response-policy.mjs",
  "scripts/interaction-crawl.mjs",
  "scripts/state-capture.mjs",
  "scripts/repeated-sections.mjs",
  "scripts/text-style-diff.mjs",
  "scripts/spacing-diff.mjs",
  "scripts/alignment-diff.mjs",
  "scripts/overlap-diff.mjs",
  "scripts/testid-carryover.mjs",
  "scripts/testid-coverage.mjs",
  "scripts/presence-by-route.mjs",
  "scripts/production-defects.mjs",
  "scripts/run-checks.mjs",
  "scripts/review-page.mjs",
];

/** The parity checks run-checks.mjs runs, one per issue type a human caught after the automated loop passed. */
const CHECK_SCRIPTS = SCRIPTS.slice(7, 18).map((s) => path.basename(s, ".mjs"));

/**
 * The seven issue types, as a reader would name them. The how-to section, the visual review template and the review
 * page all carry this checklist.
 */
const ISSUE_TYPES: Array<[string, RegExp[]]> = [
  ["missing interactions", [/interaction/i, /scroll/i]],
  ["dropdown style and icons", [/dropdown/i, /icon/i]],
  ["repeated section as one component", [/repeated/i, /component/i]],
  ["link color and font weight", [/link/i, /colou?r/i, /weight/i]],
  ["vertical spacing", [/vertical spacing|spacing between/i]],
  ["alignment at breakpoints", [/align/i, /breakpoint/i]],
  ["overlapping elements", [/overlap/i]],
];

/** A list's lines that mention each issue type: every regex of the type must match one numbered or bulleted line. */
const coversIssueTypes = (text: string) => {
  const lines = text.split("\n").filter((l) => /^\s*(\d+\.|-)\s/.test(l));
  return ISSUE_TYPES.filter(
    ([, res]) => !lines.some((l) => res.every((re) => re.test(l))),
  ).map(([name]) => name);
};

const LIBS = [
  "scripts/lib/project-deps.mjs",
  "scripts/lib/matrix.mjs",
  "scripts/lib/capture.mjs",
  "scripts/lib/cli.mjs",
];

const DEMO_MARKERS = [
  "migration-grid-legacy",
  "migration-grid-usage",
  "migration-grid-source-html",
  "migration-grid-source-css",
  "migration-grid-output-html",
  "migration-grid-output-css",
];

/** Slot name in the page's <component-demo> -> the md marker its extractDemoBlock reads. */
const SLOTS: Record<string, string> = {
  "source-usage": "migration-grid-usage",
  "source-html": "migration-grid-source-html",
  "source-css": "migration-grid-source-css",
  "output-html": "migration-grid-output-html",
  "output-css": "migration-grid-output-css",
};

describe("agent migration page: nav and head", () => {
  const howTo = NAV.find((s) => s.section === "How-to")!;

  it("is in the How-to section, right after Monorepos, with the label that is its h1", () => {
    const hrefs = howTo.pages.map((p) => p.href);
    const index = hrefs.indexOf(PAGE_HREF);
    expect(index, `${PAGE_HREF} in How-to`).toBeGreaterThan(-1);
    expect(howTo.pages[index].label).toBe(LABEL);
    expect(hrefs[index - 1]).toBe("/how-to/monorepos");
    expect(hrefs[index + 1]).toBe("/libraries");
  });

  it("the md h1 equals the nav label", () => {
    const h1 = /^# (.+)$/m.exec(readDocs(MD))?.[1];
    expect(h1).toBe(LABEL);
  });

  it("the shell has a 15-65 char title naming Bascik and a 70-160 char description", () => {
    const html = readDocs(SHELL);
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
    expect(title.length, title).toBeGreaterThanOrEqual(15);
    expect(title.length, title).toBeLessThanOrEqual(65);
    expect(title).toContain("Bascik");
    const description =
      /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(description.length, description).toBeGreaterThanOrEqual(70);
    expect(description.length, description).toBeLessThanOrEqual(160);
  });

  it("the shell carries the docs head scripts and its own section label", () => {
    const html = readDocs(SHELL);
    for (const helper of [
      "canonical",
      "openGraph",
      "breadcrumbLd",
      "articleSchema",
    ]) {
      expect(html, helper).toContain(`await ${helper}()`);
    }
    expect(html).toContain(`renderSectionLabel("${PAGE_HREF}")`);
  });
});

describe("agent migration page: editorial", () => {
  const md = () => readDocs(MD);

  it("has no em-dash and no numbered prompt provenance", () => {
    expect(md()).not.toContain("—");
    expect(readDocs(SHELL)).not.toContain("—");
    expect(prose(md())).not.toMatch(/\b[Pp]rompts?\s+\d+\b/);
  });

  it("reads as a recipe: the sections a reader follows, in order", () => {
    const h2 = [...md().matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const expected = [
      /^What You Get$/i,
      /^What You Need$/i,
      /three-source evidence/i,
      /set up the three sources/i,
      /inventor/i,
      /breakpoint matrix/i,
      /per-route loop/i,
      /interaction parity/i,
      /organiz/i,
      /score playbook/i,
      /gotchas/i,
      /reference configuration/i,
      /day-one checklist/i,
    ];
    let at = -1;
    for (const re of expected) {
      const found = h2.findIndex((h, i) => i > at && re.test(h));
      expect(
        found,
        `an h2 matching ${re} after "${h2[at] ?? "start"}"`,
      ).toBeGreaterThan(at);
      at = found;
    }
  });

  it("names the subsections the organizing and per-route sections promise", () => {
    const h3 = [...md().matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    for (const re of [
      /grid wrappers/i,
      /geometry diff/i,
      /route comparison/i,
      /execution contract/i,
      /prompt pack/i,
      /PASS gate/i,
      /disjoint ownership/i,
      /escalat/i,
      /ledger/i,
    ]) {
      expect(
        h3.some((h) => re.test(h)),
        `an h3 matching ${re}`,
      ).toBe(true);
    }
  });

  it("states the result as typical, with all five Lighthouse categories at 100", () => {
    const text = md();
    expect(text).toMatch(/60s and 70s/);
    expect(text).toMatch(/100 in all five categories/i);
  });

  it("uses the generic example site", () => {
    const text = md();
    for (const part of [
      /review carousel/i,
      /pricing slider/i,
      /contact form/i,
      /press list/i,
    ]) {
      expect(text, String(part)).toMatch(part);
    }
  });

  it("the breakpoint matrix rule and the geometry thresholds appear as written", () => {
    const text = md();
    expect(text).toMatch(/B - 1, B, (and )?B \+ 1/);
    for (const t of ["|dx| > 6", "|dy| > 12", "|dw| > 12"]) {
      expect(text, t).toContain(t);
    }
  });

  it("uses Bascik's real config and directive names, not the stale ones", () => {
    const text = md();
    expect(text).toContain("assets.inlineStyles");
    expect(text).toContain("generate.cspHashes");
    expect(text).toContain("pipeline.exec");
    expect(text).toContain("BASCIK_PAGE_PATH");
    expect(text).toContain("run_worker_first");
    expect(text).toContain("js-dynamic-id-lookup");
    // Bascik has no chunkNames option: chunk naming belongs to the reader's own esbuild script.
    expect(prose(text)).not.toMatch(
      /\bchunkNames\b.*\bBascik\b|Bascik's chunkNames/,
    );
    // The route-aware preload needs page context, which build-once scripts do not get.
    expect(text).not.toMatch(/data-bascik-build-once[^\n]*BASCIK_PAGE_PATH/);
  });
});

describe("agent migration page: what it links", () => {
  const md = () => readDocs(MD);
  const GITHUB = "https://github.com/bascikdev/bascik/tree/main/";

  it("links every reference, template and script on GitHub", () => {
    const text = md();
    for (const rel of [...REFERENCES, ...SCRIPTS]) {
      expect(text, rel).toContain(`${GITHUB}skills/bascik-refactor/${rel}`);
    }
  });

  it("every skills/bascik-refactor path it names exists on disk", () => {
    const text = md() + readDocs(SHELL);
    const named = new Set(
      [...text.matchAll(/skills\/bascik-refactor\/([\w./-]+[\w])/g)].map(
        (m) => m[1],
      ),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const rel of named) {
      expect(existsSync(path.join(SKILL_DIR, rel)), rel).toBe(true);
    }
  });

  it("links the related docs pages", () => {
    const text = md();
    for (const href of [
      "/switch",
      "/switch/from-next",
      "/switch/from-react",
      "/agent-skills",
      "/how-to/content-security-policy",
      "/how-to/bundling-npm-packages",
      "/deployment/cloudflare#composition-and-custom-worker-wrappers",
      "/lighthouse/performance",
      "/lighthouse/agentic-browsing",
      "/lighthouse/seo",
      "/testing/e2e-testing",
    ]) {
      expect(text, href).toContain(`](${href})`);
    }
  });
});

describe("agent migration page: the grid demo", () => {
  it("every demo:migration-grid-* marker appears exactly once", () => {
    const text = readDocs(MD);
    for (const marker of DEMO_MARKERS) {
      const hits =
        text.match(new RegExp(`<!--\\s*demo:${marker}\\s*-->`, "g")) ?? [];
      expect(hits.length, marker).toBe(1);
    }
  });

  it("the shell wires each slot to its marker and has a live Preview", () => {
    const html = readDocs(SHELL);
    const box = /<component-demo\b[^>]*>([\s\S]*?)<\/component-demo>/.exec(
      html,
    )?.[1];
    expect(box, "a <component-demo> box").toBeDefined();
    const example =
      /<div data-bascik-slot="example">([\s\S]*?)<\/div>\s*<div data-bascik-slot=/.exec(
        box!,
      )?.[1];
    expect(example, "example slot").toBeDefined();
    expect(example).toMatch(/<press-list\b/);
    for (const [slot, marker] of Object.entries(SLOTS)) {
      const start = box!.indexOf(`<div data-bascik-slot="${slot}">`);
      expect(start, slot).toBeGreaterThan(-1);
      const rest = box!.slice(start);
      const next = rest.indexOf("data-bascik-slot=", 30);
      const body = next > 0 ? rest.slice(0, next) : rest;
      expect(body, slot).toContain("extractDemoBlock");
      expect(body, slot).toContain(`"./${MD}"`);
      expect(body, slot).toContain(`"${marker}"`);
    }
  });

  it("the ranges around the box strip demo blocks so no fence leaks onto the page", () => {
    const html = readDocs(SHELL);
    const ranges = [
      ...html.matchAll(/<script data-bascik-build>([\s\S]*?)<\/script>/g),
    ]
      .map((m) => m[1])
      .filter((s) => /renderMdRange\(/.test(s));
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    for (const r of ranges) expect(r).toMatch(/stripDemoBlocks:\s*true/);
    expect(html).not.toMatch(/await renderMd\(/);
  });

  it("the legacy wrapper block is illustrative only: shown before the box, not wired into it", () => {
    // stripDemoBlocks removes every demo-marked fence from the rendered ranges, so the shell shows the legacy
    // block in its own <code-block>, outside the <component-demo> box.
    const shell = readDocs(SHELL);
    const box = /<component-demo\b[^>]*>([\s\S]*?)<\/component-demo>/.exec(
      shell,
    )![1];
    expect(box).not.toContain("migration-grid-legacy");
    expect(shell.match(/"migration-grid-legacy"/g) ?? []).toHaveLength(1);
    expect(shell.indexOf("migration-grid-legacy")).toBeLessThan(
      shell.indexOf("<component-demo"),
    );
    const md = readDocs(MD);
    const legacy =
      /<!--\s*demo:migration-grid-legacy\s*-->\s*\n```html\n([\s\S]*?)\n```/.exec(
        md,
      )?.[1];
    expect(legacy, "legacy html fence").toBeDefined();
    // Several nested framework grid wrappers around the press list.
    expect((legacy!.match(/<div\b/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // Grid classes and neutral generated hashes only: no extra stack fingerprint (styled-components names).
    expect(legacy).not.toMatch(/\bsc-[a-z0-9]+/i);
  });
});

describe("agent migration page: a newcomer can follow it on day one", () => {
  const md = () => readDocs(MD);
  const fences = (lang: string) =>
    [
      ...md().matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g")),
    ].map((m) => m[1]);
  // A missing file reads as empty here; "every reference, template, script and helper exists" reports it.
  const readIfExists = (rel: string) =>
    existsSync(path.join(SKILL_DIR, rel))
      ? readRepo(`skills/bascik-refactor/${rel}`)
      : "";
  const TEMPLATES = REFERENCES.map(readIfExists);
  const SCRIPT_SOURCES = SCRIPTS.map(readIfExists);

  it("points every script at Bascik's port and a production server, never port 3000", () => {
    for (const text of [md(), ...TEMPLATES, ...SCRIPT_SOURCES])
      expect(text).not.toContain("localhost:3000");
    expect(md()).toMatch(/export TARGET_URL=http:\/\/localhost:8080/);
    const serve = md().search(/bascik --build[^\n]*\n?[^\n]*bascik --server/);
    const firstCompare = md().indexOf('compare-route.mjs" \\');
    expect(serve, "a bascik --build then bascik --server step").toBeGreaterThan(
      -1,
    );
    expect(serve).toBeLessThan(md().indexOf('geometry-diff.mjs" \\'));
    expect(firstCompare).toBeGreaterThan(-1);
  });

  it("collects Lighthouse with the Lighthouse 13 CLI, mobile and desktop into separate folders, not lhci", () => {
    for (const text of [md(), ...TEMPLATES, ...SCRIPT_SOURCES]) {
      // Naming @lhci/cli in a warning is fine; telling readers to install it or collect with it is not.
      expect(text).not.toMatch(
        /lhci collect|npm install[^\n]*@lhci\/cli|\.lighthouseci/,
      );
    }
    const shell = fences("sh").join("\n");
    expect(shell).toMatch(/npx lighthouse [^\n]*--output=json/);
    expect(shell).toMatch(/--preset=desktop/);
    expect(shell).toMatch(
      /--dir artifacts\/lighthouse\/mobile --form-factor mobile/,
    );
    expect(shell).toMatch(
      /--dir artifacts\/lighthouse\/desktop --form-factor desktop/,
    );
  });

  it("creates every file it later reads: the docs/migration folder and urls.txt", () => {
    const text = md();
    const mkdir = text.indexOf("mkdir -p docs/migration");
    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(text.indexOf("docs/migration/breakpoints.json"));
    expect(text).toMatch(/> docs\/migration\/urls\.txt/);
    expect(text).toMatch(/BASCIK_SITE_URL/);
  });

  it("scaffolds without prompts and without starting the dev server", () => {
    expect(md()).toMatch(
      /npm create bascik@rc site -y -- --template (default|cloudflare) --no-dev/,
    );
  });

  it("names the skills folder once, so other install locations need one change", () => {
    const text = md();
    expect(text).toMatch(
      /export REFACTOR=\.agents\/skills\/bascik-refactor\/scripts/,
    );
    expect(
      text.match(/\.agents\/skills\/bascik-refactor\/scripts/g),
    ).toHaveLength(1);
    expect(text).toMatch(/\.claude\/skills/);
  });

  it("copies the build-time and runtime scripts into the project", () => {
    const text = md();
    expect(text).toMatch(
      /cp "\$REFACTOR\/llms-txt\.mjs" "\$REFACTOR\/worker-response-policy\.mjs" scripts\//,
    );
    const config = fences("ts").find((f) => f.includes("defineConfig"))!;
    expect(config).toContain('script: "scripts/llms-txt.mjs"');
  });

  it("the reference config builds as pasted: no missing vendor script, no uninstalled minifier", () => {
    const config = fences("ts").find((f) => f.includes("defineConfig"))!;
    expect(config).not.toMatch(/from "esbuild"/);
    for (const line of config
      .split("\n")
      .filter((l) => l.includes("bundle-vendor")))
      expect(line.trim().startsWith("//"), line).toBe(true);
  });

  it("the root wrangler.jsonc keeps the site's own 404 page", () => {
    const wrangler = fences("jsonc").find((f) =>
      f.includes("run_worker_first"),
    )!;
    expect(wrangler).toMatch(/"not_found_handling":\s*"404-page"/);
  });

  it("states what the matrix script finds and how to add what it misses", () => {
    const text = prose(md());
    expect(text).not.toMatch(/does steps 1 to 4/);
    expect(md()).toMatch(/--add /);
    expect(text).toMatch(/compiled stylesheets/);
  });

  it("turns ledger rows into accepted.json entries; no script is said to read the ledger", () => {
    const text = md();
    expect(text).not.toMatch(/Comparisons read it/);
    expect(text).toMatch(/--accepted docs\/migration\/accepted\.json/);
    const driver = readRepo(
      "skills/bascik-refactor/references/templates/driver-agent.md",
    );
    expect(driver).toMatch(/accepted\.json/);
    const ledger = readRepo(
      "skills/bascik-refactor/references/templates/decisions-ledger.md",
    );
    expect(ledger).toMatch(/accepted\.json/);
  });

  it("offers only working advice for uppercase chunk hashes", () => {
    for (const text of [md(), TEMPLATES[0]])
      expect(text).not.toMatch(/drop `\[hash\]`/);
  });

  it("gives the hero helper the preload example imports, built from the manifest's url", () => {
    const text = md();
    expect(text).toMatch(/src\/lib\/heroes\.ts/);
    const helper = fences("ts").find((f) =>
      f.includes("export function heroFor"),
    );
    expect(helper, "a heroFor implementation").toBeDefined();
    // The manifest responsive-webp.mjs wrote with --manifest src/lib/images.json.
    expect(text).toMatch(/--manifest src\/lib\/images\.json/);
    expect(helper).toMatch(/src\/lib\/images\.json/);
    expect(helper).toMatch(/\.url\b/);
  });

  it("points at the starter llms.txt example the way a reader can get it", () => {
    expect(md()).toContain("add-example.mjs starter-site/scripts/llms-txt.ts");
    expect(md()).not.toMatch(/The starter site's `scripts\/llms-txt\.ts`/);
  });

  it("the one-route template collects and gates its own route, mobile and desktop", () => {
    const route = readRepo(
      "skills/bascik-refactor/references/templates/one-route.md",
    );
    expect(route).toMatch(
      /npx lighthouse "\$TARGET_URL\{\{ROUTE\}\}"[^\n]*--output=json/,
    );
    expect(route).toMatch(/--preset=desktop/);
    expect(route).toMatch(/rm -f/);
    expect(route).toMatch(/\$REFACTOR\//);
    expect(route).not.toMatch(/\.agents\/skills/);
  });
});

describe("bascik-refactor skill: files the page hands out", () => {
  it("every reference, template, script and helper exists", () => {
    for (const rel of [...REFERENCES, ...SCRIPTS, ...LIBS]) {
      expect(existsSync(path.join(SKILL_DIR, rel)), rel).toBe(true);
    }
  });

  it("every script in scripts/ has a matching docs/scripts/refactor-*.test.ts", () => {
    const scripts = readdirSync(path.join(SKILL_DIR, "scripts")).filter((f) =>
      f.endsWith(".mjs"),
    );
    expect(scripts.sort()).toEqual(SCRIPTS.map((s) => path.basename(s)).sort());
    for (const script of scripts) {
      const test = `scripts/refactor-${script.replace(/\.mjs$/, "")}.test.ts`;
      expect(existsSync(path.join(DOCS_ROOT, test)), test).toBe(true);
    }
  });

  it("each script follows the skill convention: shebang, dependency note, HELP, parseArgs, isMain", () => {
    for (const rel of SCRIPTS) {
      const src = readFileSync(path.join(SKILL_DIR, rel), "utf8");
      expect(src.startsWith("#!/usr/bin/env node\n"), rel).toBe(true);
      expect(src, rel).toMatch(/Node\.js 22\.18\+/);
      expect(src, rel).toMatch(/\bconst HELP = /);
      expect(src, rel).toMatch(/parseArgs/);
      expect(src, rel).toMatch(/isMain\(import\.meta\.url\)/);
      // Each skill ships as its own archive: no import across skills.
      expect(src, rel).not.toMatch(/from\s+["']\.\.\/\.\.\//);
    }
  });

  it("no script imports playwright or sharp statically: they come from the reader's project", () => {
    for (const rel of [...SCRIPTS, ...LIBS]) {
      const src = readFileSync(path.join(SKILL_DIR, rel), "utf8");
      expect(src, rel).not.toMatch(
        /^\s*import\s[^;]*from\s+["'](playwright|@playwright\/test|sharp)["']/m,
      );
    }
  });

  it("SKILL.md links the page, every reference and the scripts, and stays concise", () => {
    const skill = readRepo("skills/bascik-refactor/SKILL.md");
    expect(skill).toContain(`read-doc.mjs ${PAGE_HREF}`);
    for (const rel of REFERENCES) expect(skill, rel).toContain(rel);
    for (const rel of SCRIPTS) expect(skill, rel).toContain(path.basename(rel));
    expect(skill.split("\n").length).toBeLessThan(500);
  });

  it("templates use {{PLACEHOLDER}} slots, never backticked example routes", () => {
    const placeholders: Record<string, string[]> = {
      "execution-contract.md": [
        "{{LIVE_URL}}",
        "{{LEGACY_REPO}}",
        "{{TARGET_REPO}}",
        "{{PAGE_FAMILIES}}",
        "{{MATRIX_FILE}}",
        "{{GATE_COMMANDS}}",
      ],
      "prompt-pack-index.md": ["{{NN}}"],
      "one-route.md": [
        "{{ROUTE}}",
        "{{LEGACY_ENTRY}}",
        "{{TARGET_PAGE}}",
        "{{BASELINE_IDS}}",
        "{{REQUIRED_COMPONENTS}}",
        "{{INTERACTIONS}}",
        "{{PARENT_PROMPT}}",
        "{{CHILD_ID}}",
      ],
      "one-failure.md": [
        "{{FAILURE_ID}}",
        "{{EVIDENCE}}",
        "{{MATRIX_CASE}}",
        "{{OWNER_FILES}}",
        "{{ACCEPTANCE}}",
      ],
    };
    for (const [file, slots] of Object.entries(placeholders)) {
      const text = readRepo(
        `skills/bascik-refactor/references/templates/${file}`,
      );
      for (const slot of slots) expect(text, `${file} ${slot}`).toContain(slot);
    }
    const driver = readRepo(
      "skills/bascik-refactor/references/templates/driver-agent.md",
    );
    expect(driver).toMatch(/PASS/);
    for (const part of [
      /minimal repro/i,
      /proposed resolution/i,
      /regression/i,
    ]) {
      expect(driver, String(part)).toMatch(part);
    }
    const ledger = readRepo(
      "skills/bascik-refactor/references/templates/decisions-ledger.md",
    );
    expect(ledger).toMatch(/\|\s*id\s*\|/i);
  });

  it("the production-parity reference is agent-agnostic", () => {
    const text = readRepo(
      "skills/bascik-refactor/references/production-parity.md",
    );
    // Editor- or vendor-specific agent tool names do not belong in a generic reference.
    expect(text).not.toMatch(/\b(TodoWrite|apply_patch|Cursor|Copilot)\b/);
    expect(text).not.toContain("—");
  });
});

describe("entry points lead to the page", () => {
  it.each([
    "content/switch.md",
    "content/switch/from-next.md",
    "content/switch/from-react.md",
    "content/agent-skills.md",
  ])("%s links /how-to/agent-migration", (rel) => {
    expect(readDocs(rel)).toContain(`](${PAGE_HREF})`);
  });

  it("agent-skills.md lists the new scripts and no longer claims only three scripts write", () => {
    const text = readDocs("content/agent-skills.md");
    for (const rel of SCRIPTS) expect(text, rel).toContain(path.basename(rel));
    expect(text).not.toMatch(
      /Only `new-component\.mjs`, `add-example\.mjs`, and `new-post\.mjs` write/,
    );
  });

  it("skills/README.md lists the new scripts", () => {
    const text = readRepo("skills/README.md");
    for (const rel of SCRIPTS) expect(text, rel).toContain(path.basename(rel));
  });
});

describe("bascik-refactor is an opt-in skill", () => {
  const INSTALL = "npx skills add bascikdev/bascik --skill bascik-refactor";
  const INSTALL_SITE =
    "npx skills add https://bascik.dev --skill bascik-refactor";

  it("bascik-migrate keeps none of the refactor files and points at bascik-refactor", () => {
    const migrate = path.join(REPO_ROOT, "skills/bascik-migrate");
    expect(readdirSync(migrate)).toEqual(["SKILL.md"]);
    const skill = readRepo("skills/bascik-migrate/SKILL.md");
    expect(skill).toContain(INSTALL);
    expect(skill).toContain(PAGE_HREF);
    expect(skill).not.toMatch(/\]\((references|scripts)\//);
    for (const rel of SCRIPTS)
      expect(skill, rel).not.toContain(path.basename(rel));
  });

  it("the page installs bascik-refactor before it uses $REFACTOR, since new projects do not include it", () => {
    const text = readDocs(MD);
    const install = text.indexOf(INSTALL);
    expect(install, "the setup step installs bascik-refactor").toBeGreaterThan(
      -1,
    );
    expect(install).toBeLessThan(text.indexOf("export REFACTOR="));
    expect(text).not.toContain("bascik-migrate");
  });

  it("agent-skills.md lists bascik-refactor and says new projects leave it out", () => {
    const text = readDocs("content/agent-skills.md");
    expect(text).toMatch(/^\| `bascik-refactor` +\|/m);
    expect(text).toContain(INSTALL);
    expect(text).toContain(INSTALL_SITE);
    expect(text).toMatch(/every skill except the opt-in `bascik-refactor`/);
    expect(text).not.toContain("bascik-migrate/scripts");
  });

  it.each(["skills/README.md", "create/assets/skills/README.md"])(
    "%s describes bascik-refactor as opt-in with its install command",
    (rel) => {
      const text = readRepo(rel);
      expect(text).toContain("bascik-refactor/SKILL.md");
      expect(text).toMatch(/opt-in/i);
      expect(text).toContain(INSTALL);
      expect(text).not.toContain("bascik-migrate/scripts");
    },
  );

  it("bascik-seo and bascik-testing point at bascik-refactor, not bascik-migrate, for its scripts", () => {
    for (const rel of [
      "skills/bascik-seo/SKILL.md",
      "skills/bascik-testing/SKILL.md",
    ]) {
      const text = readRepo(rel);
      expect(text, rel).toMatch(/bascik-refactor\/scripts\/[\w-]+\.mjs/);
      expect(text, rel).toMatch(/opt-in/);
      expect(text, rel).toContain(INSTALL);
      expect(text, rel).not.toContain("bascik-migrate/scripts");
    }
  });

  it("the core bascik skill lists bascik-refactor as an opt-in companion with its install command", () => {
    const text = readRepo("skills/bascik/SKILL.md");
    expect(text).toMatch(/^\| `bascik-refactor` +\|.*opt-in/im);
    expect(text).toContain(INSTALL);
  });

  it("setup step 3 installs the skill and step 4 copies the site scripts, after REFACTOR is set", () => {
    const text = readDocs(MD);
    const step3 = /^3\. Create the Bascik project.*$/m.exec(text)?.[0] ?? "";
    const step4 = /^4\. Name the origins.*$/m.exec(text)?.[0] ?? "";
    expect(step3).toContain("install the `bascik-refactor` skill");
    expect(step3).not.toMatch(/copy/);
    expect(step4).toMatch(/copy the two site scripts/);
  });
});

/**
 * The parity checks, the visual reviewer and the human sign-off.
 *
 * Why: in an agent-driven refactor the automated loop passed pages that a human then caught side by side with
 * production: a hero button that scrolled nowhere, dropdowns with the wrong style and no icons, a repeated section
 * pasted instead of made a component, links in the wrong color or weight, spacing off by tens of pixels, text
 * misaligned at some breakpoints and a timeline icon off its circle. The scripts compared absolute geometry with loose
 * thresholds, and agents read "no flags" as PASS.
 *
 * Misuse lens: a template that runs some checks but not all, a gate that accepts the agent's own word, a review file
 * with a typo'd verdict, a how-to section that grows into a second manual.
 */
describe("parity checks and review gates", () => {
  const template = (name: string) =>
    readRepo(`skills/bascik-refactor/references/templates/${name}`);
  /** The text under the first heading matching `re`, up to the next heading of the same or a higher level. */
  const section = (md: string, re: RegExp) => {
    const lines = md.split("\n");
    const start = lines.findIndex((l) => /^#{2,3} /.test(l) && re.test(l));
    if (start < 0) return undefined;
    const level = /^#+/.exec(lines[start])![0].length;
    const end = lines.findIndex(
      (l, i) =>
        i > start && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level,
    );
    return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
  };

  it("the production-parity reference describes every check, its tolerance and the CDP calls it needs", () => {
    const text = readRepo(
      "skills/bascik-refactor/references/production-parity.md",
    );
    for (const name of [...CHECK_SCRIPTS, "run-checks", "review-page"])
      expect(text, name).toContain(`${name}.mjs`);
    expect(text).toContain("DOMDebugger.getEventListeners");
    expect(text).toContain("CSS.forcePseudoState");
    expect(text).toMatch(/\b2 px\b/);
    expect(text).toMatch(/\b1 px\b/);
    expect(text).toContain("templates/visual-review.md");
    expect(text).toContain("docs/migration/review/");
    expect(coversIssueTypes(text)).toEqual([]);
  });

  it("SKILL.md names run-checks, the review page and the visual review, and stays short", () => {
    const skill = readRepo("skills/bascik-refactor/SKILL.md");
    expect(skill).toContain("run-checks.mjs");
    expect(skill).toContain("review-page.mjs");
    expect(skill).toContain("references/templates/visual-review.md");
    expect(skill).toMatch(/docs\/migration\/review\//);
    // Detail lives in the references.
    expect(skill.split("\n").length).toBeLessThan(70);
  });

  it("the visual review template sends an agent with image input to find differences, and blocks the route on any", () => {
    const text = template("visual-review.md");
    expect(text).toContain("{{ROUTE}}");
    expect(text).toMatch(/image input|reads? (the )?(images|screenshots)/i);
    expect(text).toMatch(/\brest\b/i);
    expect(text).toMatch(/\bopen states?\b/i);
    expect(text).toMatch(/side by side/i);
    expect(text).toMatch(/(job|task) is to find differences/i);
    expect(text).toMatch(/cannot pass while[^.]*any/i);
    expect(coversIssueTypes(text), "checklist items missing").toEqual([]);
  });

  it("the one-route template runs every check in one command and carries the test hooks over", () => {
    const text = template("one-route.md");
    expect(text).toMatch(
      /node "\$REFACTOR\/run-checks\.mjs" --prod "\$PROD_URL" --target "\$TARGET_URL" --route "\{\{ROUTE\}\}"/,
    );
    expect(text).toMatch(/--legacy-src/);
    // The hooks the old end-to-end suite uses, on the same elements, with the same attribute names.
    for (const attr of [
      "data-testid",
      "data-test",
      "data-test-id",
      "data-cy",
      "data-qa",
    ])
      expect(text, attr).toContain(attr);
    expect(text).toMatch(/testid-carryover/);
    expect(text).toMatch(/testid-coverage/);
    expect(text).toMatch(/<component>-<part>/);
    expect(text).toContain("visual-review.md");
    expect(text).toMatch(
      /node "\$REFACTOR\/review-page\.mjs" --route "\{\{ROUTE\}\}"/,
    );
    expect(text).toMatch(
      /node "\$REFACTOR\/review-page\.mjs" --verify --route "\{\{ROUTE\}\}"/,
    );
  });

  it("the driver's PASS gate needs run-checks, a visual review with no differences and a human pass verdict", () => {
    const text = template("driver-agent.md");
    const gate = /\*\*PASS gate:\*\*([\s\S]*?)\n\d+\. /.exec(text)?.[1] ?? "";
    expect(gate, "the PASS gate item").not.toBe("");
    expect(gate).toContain("run-checks.mjs");
    expect(gate).toMatch(/visual review/i);
    expect(gate).toMatch(/review-page\.mjs --verify/);
    expect(gate).toMatch(/docs\/migration\/review\//);
    expect(gate).toMatch(/verdict[^.]*pass/i);
    // The root cause, stated where the driver decides.
    expect(text).toMatch(/no (findings|flags)[^.]*not (a )?PASS/i);
    // Only a human writes the verdict file.
    expect(text).toMatch(
      /never (write|sign|create)[^.]*(verdict|review file|sign-off)/i,
    );
  });

  it("the how-to explains in one short section why a human signs off every route, with the checklist", () => {
    const md = readDocs(MD);
    const body = section(md, /human/i);
    expect(body, "a ## or ### heading about the human review").toBeDefined();
    const lines = body!.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length, "one short section").toBeLessThanOrEqual(24);
    expect(body).toMatch(/caught|catches/i);
    expect(body).toMatch(/\bpass(ed)?\b/i);
    expect(coversIssueTypes(body!), "checklist items missing").toEqual([]);
    expect(body).toContain("review-page.mjs");
    expect(body).toContain("docs/migration/review/");
  });

  it("production defects are found on production first, logged in the ledger and fixed, never copied", () => {
    const reference = readRepo(
      "skills/bascik-refactor/references/production-parity.md",
    );
    const oneRoute = template("one-route.md");
    const ledger = template("decisions-ledger.md");
    for (const [name, text] of [
      ["production-parity.md", reference],
      ["one-route.md", oneRoute],
      ["decisions-ledger.md", ledger],
    ])
      expect(text, name).toContain("production defect: fix in target");
    expect(reference).toMatch(/squish/i);
    expect(reference).toMatch(/icon[^.]*heading/i);
    expect(reference).toMatch(/horizontal (page )?scroll/i);
    expect(reference).toMatch(/corrected expectation/i);
    // Run on production before the route is written, so the agent never copies a defect in the first place.
    const defectsAt = oneRoute.indexOf("production-defects");
    expect(defectsAt, "one-route.md names production-defects").toBeGreaterThan(
      -1,
    );
    expect(defectsAt).toBeLessThan(oneRoute.indexOf("run-checks.mjs"));
  });

  it("presence is inventoried per route in a fresh context and after dismissal", () => {
    const reference = readRepo(
      "skills/bascik-refactor/references/production-parity.md",
    );
    expect(reference).toContain("presence-by-route.mjs");
    expect(reference).toMatch(/fresh (browser )?context/i);
    expect(reference).toMatch(/dismiss/i);
    expect(reference).toMatch(/cookie (banner|notice)/i);
    expect(template("one-route.md")).toMatch(/presence-by-route/);
  });

  it("the how-to runs every check with one command", () => {
    const md = readDocs(MD);
    expect(md).toMatch(/node "\$REFACTOR\/run-checks\.mjs"/);
  });

  it("the parity fixtures are generic: every link and image stays on the fixture server", () => {
    const root = path.join(DOCS_ROOT, "scripts/fixtures/refactor-parity");
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath, e.name));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g))
        expect(m[1], `${file}: ${m[1]}`).not.toMatch(/^(https?:)?\/\//);
      expect(text, file).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    }
  });
});
