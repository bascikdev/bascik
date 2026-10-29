#!/usr/bin/env node
// Review page: one static HTML page per route (artifacts/review/<route>.html) with production and the target side by
// side at every matrix case, a diff overlay toggle, the open states, the parity findings beside the images, production's
// own defects listed apart, the seven-point checklist, and a sign-off form. The sign-off is a file,
// docs/migration/review/<route>.json ({ route, reviewer, verdict, notes, date }), and --verify is the gate the driver
// runs before it marks a route PASS. Dependency-free; Node.js 22.18+; reads the reports, needs no browser.
//
// Why: a human looking at production and the target side by side caught what every automated check passed. No route
// passes without a human pass verdict.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { routeSlug, validateRoute } from "./lib/checks.mjs";
import { reportDirName } from "./compare-route.mjs";
import { LEDGER_NOTE } from "./production-defects.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export { routeSlug };

const HELP = `Usage: node review-page.mjs --route <path>... [options]            build the review pages
       node review-page.mjs --sign --route <path> --reviewer <name> --verdict pass|issues [--notes <text>]
       node review-page.mjs --verify --route <path>...                    the PASS gate: exit 1 without a pass

Build: reads <compare>/<route>/report.json (compare-route.mjs) and <checks>/<route>/report.json (run-checks.mjs) and
writes <out>/<route>.html: production and the target side by side per matrix case with a diff overlay, the open
states, the findings, production's defects, the checklist and a sign-off form. The form downloads <route>.json; save it
in docs/migration/review/, or sign from the terminal with --sign.

Run compare-route.mjs and run-checks.mjs for the route first: the page shows their screenshots and findings.

Sign: writes <dir>/<route>.json for one route. Only a person who looked at the page signs. The sign-off records which
run it reviewed ("reviewed": a hash of the target screenshots and the findings), from the page or, with --sign, from
the same reports.
Verify: exits 1 unless every route has a valid sign-off with verdict "pass" for the run in the reports now, and its
run-checks report passes, naming each missing or failing file. A fix after the review changes the target's
screenshots, so the route needs a new review.

Options:
  --route <path>       Route (repeatable; one with --sign)
  --compare <dir>      compare-route.mjs output (default artifacts/compare)
  --checks <dir>       run-checks.mjs output (default artifacts/checks)
  --out <dir>          Where the pages go (default artifacts/review)
  --dir <dir>          Sign-off folder (default docs/migration/review)
  --reviewer <name>    With --sign: who reviewed
  --verdict <v>        With --sign: pass or issues
  --notes <text>       With --sign: what differs (required for issues)
  --date <yyyy-mm-dd>  With --sign: the review date (default today)
  --help               Show this message`;

/** The seven issue types a human caught after the automated loop passed, in order. */
export const CHECKLIST = Object.freeze([
  "Missing interactions: every button, link and control does what production does, such as a hero button that scrolls to its section",
  "Dropdown menus, opened: the same style and the same icons as production",
  "Repeated sections: a section on several pages is one component, and every copy looks the same",
  "Link color and font weight: links and text match at rest, on hover and on keyboard focus",
  "Vertical spacing between elements matches inside every section",
  "Alignment at every breakpoint: text and buttons line up the same at each width",
  "Overlapping elements: an icon over a dot or a badge over an image sits exactly where production puts it",
]);

const SIGN_OFF_KEYS = [
  "route",
  "reviewer",
  "verdict",
  "notes",
  "date",
  "reviewed",
];

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** An image path relative to the page's folder, so the page opens from disk. */
const imgSrc = (base, file) =>
  file ? encodeURI(relative(base, resolve(file)).split(sep).join("/")) : "";

const today = () => new Date().toISOString().slice(0, 10);

function findingItem(f) {
  const where = [f.width !== undefined ? `${f.width} px` : "", f.state ?? ""]
    .filter(Boolean)
    .join(", ");
  return `<li data-testid="review-finding"><strong>${esc(f.check)}</strong> <code>${esc(f.kind)}</code>${where ? ` <span class="where">${esc(where)}</span>` : ""}<br />${esc(f.message)}</li>`;
}

/**
 * The review page for one route. data: { route, cases: [{ width, height, prod, target }] (screenshot files),
 * states: [{ anchor, width, prod: { crop }, target: { crop } }], findings, productionDefects, base } where base is the
 * folder the page is written to. Everything is escaped; nothing loads from the network.
 */
export function renderReviewPage({
  route,
  cases = [],
  states = [],
  findings = [],
  productionDefects = [],
  base = ".",
  reviewed,
  checksOk,
}) {
  const slug = routeSlug(route);
  const byWidth = (w) => findings.filter((f) => f.width === w);
  const widths = new Set(cases.map((c) => c.width));
  const general = findings.filter((f) => !widths.has(f.width));
  const caseHtml = cases
    .map((c) => {
      const label = `${c.width}x${c.height}`;
      const own = byWidth(c.width);
      return `<section class="case" data-testid="review-case">
  <div class="case-head"><h2>${esc(label)}</h2><button type="button" class="toggle" data-testid="diff-toggle" aria-pressed="false">Show difference on the target</button></div>
  <div class="row">
    <figure><figcaption>Production</figcaption><img src="${esc(imgSrc(base, c.prod))}" alt="Production at ${esc(label)}" /></figure>
    <figure><figcaption>Target</figcaption>
      <div class="stack"><img src="${esc(imgSrc(base, c.target))}" alt="Target at ${esc(label)}" /><img class="overlay" data-testid="diff-overlay" src="${esc(imgSrc(base, c.prod))}" alt="Difference at ${esc(label)}" hidden /></div>
    </figure>
    <aside><h3>Findings at ${esc(c.width)} px</h3>${own.length ? `<ul>${own.map(findingItem).join("")}</ul>` : "<p>None from the checks. Look anyway.</p>"}</aside>
  </div>
</section>`;
    })
    .join("\n");
  const stateHtml = states
    .map(
      (s) => `<section class="case" data-testid="review-state">
  <h2>Open: ${esc(s.anchor)}${s.width !== undefined ? ` at ${esc(s.width)} px` : ""}</h2>
  <div class="row">
    <figure><figcaption>Production</figcaption><img src="${esc(imgSrc(base, s.prod?.crop))}" alt="Production, ${esc(s.anchor)} open" /></figure>
    <figure><figcaption>Target</figcaption><img src="${esc(imgSrc(base, s.target?.crop))}" alt="Target, ${esc(s.anchor)} open" /></figure>
  </div>
</section>`,
    )
    .join("\n");
  const defectsHtml = productionDefects.length
    ? `<section data-testid="review-production-defects">
  <h2>Production defects the target fixes on purpose</h2>
  <p>Each is a decisions ledger row, "${esc(LEDGER_NOTE)}". At these cases the target is compared with the corrected expectation, not with production.</p>
  <ul>${productionDefects
    .map(
      (d) =>
        `<li data-testid="review-production-defect"><code>${esc(d.kind)}</code> ${esc(d.route)} at ${esc(d.width)} px, <code>${esc(d.selector)}</code>: ${esc(d.message)} (${esc(LEDGER_NOTE)})</li>`,
    )
    .join("")}</ul>
</section>`
    : "";
  const file = `docs/migration/review/${slug}.json`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review ${esc(route)}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #1d2433; --muted: #5b6475; --line: #d5dbe7; --accent: #2457d6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14171f; --fg: #e8ebf2; --muted: #a3abbd; --line: #343b4c; --accent: #7aa2ff; } }
  body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 1600px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  .case { border-top: 1px solid var(--line); padding: 16px 0; }
  .row { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start; }
  figure { margin: 0; }
  figcaption { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; color: var(--muted); }
  img { display: block; box-sizing: border-box; max-width: 100%; border: 1px solid var(--line); }
  .case-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
  .case-head h2 { margin: 0; }
  /* The stack is exactly the target image's box: the overlay is scaled like it and clipped to it, never wider. */
  .stack { position: relative; display: inline-block; max-width: 100%; overflow: hidden; vertical-align: top; }
  .overlay { position: absolute; top: 0; left: 0; width: 100%; height: auto; max-width: none; mix-blend-mode: difference; pointer-events: none; }
  .warning { border: 1px solid var(--accent); padding: 8px 12px; }
  .overlay[hidden] { display: none; }
  .where { color: var(--muted); }
  ul { padding-left: 20px; }
  form { display: grid; gap: 8px; max-width: 520px; }
  input, select, textarea, button { font: inherit; }
  code { overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<h1>Review ${esc(route)}</h1>
<p>Production first and the target second at every matrix case (side by side on a wide screen, one above the other on a narrow one). Your job is to find differences. The checks below passed or flagged what they could; you catch the rest.</p>
<section data-testid="review-checklist">
  <h2>Checklist</h2>
  <ol>${CHECKLIST.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>
</section>
${defectsHtml}
${general.length ? `<section data-testid="review-findings"><h2>Findings for the route</h2><ul>${general.map(findingItem).join("")}</ul></section>` : ""}
${caseHtml}
${stateHtml}
<section data-testid="review-sign-off">
  <h2>Sign off</h2>
  ${checksOk === false ? `<p class="warning" data-testid="review-checks-failing">run-checks.mjs still reports findings for this route. A pass sign-off does not pass the gate until they are fixed and the route is reviewed again.</p>` : ""}
  <p>The form downloads <code>${esc(slug)}.json</code>. Save it as <code>${esc(file)}</code>, or run <code>node "$REFACTOR/review-page.mjs" --sign --route "${esc(route)}" --reviewer "Your name" --verdict pass</code>.</p>
  <form id="sign-off">
    <label>Reviewer <input data-testid="review-reviewer" name="reviewer" required /></label>
    <label>Verdict <select data-testid="review-verdict" name="verdict" required>
      <option value="">Choose</option><option value="pass">pass: no differences</option><option value="issues">issues: differences found</option>
    </select></label>
    <label>Notes <textarea data-testid="review-notes" name="notes" rows="4"></textarea></label>
    <p id="sign-off-error" role="alert"></p>
    <button type="submit" data-testid="review-submit">Download sign-off</button>
  </form>
</section>
</main>
<script>
  for (const button of document.querySelectorAll("[data-testid=diff-toggle]")) {
    button.addEventListener("click", () => {
      const overlay = button.closest(".case").querySelector("[data-testid=diff-overlay]");
      overlay.hidden = !overlay.hidden;
      button.setAttribute("aria-pressed", String(!overlay.hidden));
    });
  }
  document.getElementById("sign-off").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = document.getElementById("sign-off-error");
    const reviewer = form.reviewer.value.trim();
    const verdict = form.verdict.value;
    const notes = form.notes.value.trim();
    if (!reviewer || !verdict) { error.textContent = "Name the reviewer and choose a verdict."; return; }
    if (verdict === "issues" && !notes) { error.textContent = "Describe the differences in the notes."; return; }
    error.textContent = "";
    const data = { route: ${JSON.stringify(String(route)).replace(/</g, "\\u003c")}, reviewer, verdict, notes, date: new Date().toISOString().slice(0, 10)${reviewed ? `, reviewed: ${JSON.stringify(String(reviewed))}` : ""} };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\\n"], { type: "application/json" }));
    link.download = ${JSON.stringify(`${slug}.json`)};
    document.body.append(link);
    link.click();
    link.remove();
  });
</script>
</body>
</html>
`;
}

/** Throws a located error for a sign-off that is not { route, reviewer, verdict: pass|issues, notes, date }. */
export function validateSignOff(data) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("a sign-off is a JSON object");
  for (const key of Object.keys(data))
    if (!SIGN_OFF_KEYS.includes(key))
      throw new Error(
        `unknown key "${key}"; a sign-off has ${SIGN_OFF_KEYS.join(", ")}`,
      );
  if (typeof data.route !== "string" || !data.route.startsWith("/"))
    throw new Error(
      `route must be the path it reviews, starting with "/" (got ${JSON.stringify(data.route)})`,
    );
  if (typeof data.reviewer !== "string" || !data.reviewer.trim())
    throw new Error("reviewer must name the person who reviewed the page");
  if (data.verdict !== "pass" && data.verdict !== "issues")
    throw new Error(
      `verdict must be "pass" or "issues" (got ${JSON.stringify(data.verdict)})`,
    );
  if (data.notes !== undefined && typeof data.notes !== "string")
    throw new Error("notes must be text");
  if (
    data.reviewed !== undefined &&
    (typeof data.reviewed !== "string" ||
      !/^[0-9a-f]{16,64}$/.test(data.reviewed))
  )
    throw new Error(
      `reviewed must be the run the page showed, as the page or --sign writes it (got ${JSON.stringify(data.reviewed)})`,
    );
  if (data.verdict === "issues" && !String(data.notes ?? "").trim())
    throw new Error(
      "notes must describe the differences when the verdict is issues",
    );
  if (
    typeof data.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}/.test(data.date) ||
    Number.isNaN(Date.parse(data.date))
  )
    throw new Error(
      `date must be the review date as yyyy-mm-dd (got ${JSON.stringify(data.date)})`,
    );
}

/** Writes <dir>/<slug>.json for one route after validating it, and returns the file path. */
export function writeSignOff({
  dir,
  route,
  reviewer,
  verdict,
  notes = "",
  date = today(),
  reviewed,
}) {
  const data = { route, reviewer, verdict, notes, date };
  if (reviewed !== undefined) data.reviewed = reviewed;
  validateSignOff(data);
  const file = join(dir, `${routeSlug(route)}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return file;
}

/** The compare-route.mjs report for a route: <compare>/<slug>/report.json or the hashed folder it writes. */
function compareReport(compare, route) {
  const plain = join(compare, routeSlug(route), "report.json");
  const hashed = join(compare, reportDirName(route), "report.json");
  const file = [plain, hashed].find((f) => existsSync(f));
  if (!file)
    throw new Error(
      `${plain} not found (nor ${hashed}): run compare-route.mjs for ${route} first`,
    );
  return JSON.parse(readFileSync(file, "utf8"));
}

/** The run-checks.mjs report for a route, or null. */
function checksReport(checks, route) {
  const file = join(checks, routeSlug(route), "report.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/**
 * The run a review covers, as a hash: the bytes of the target's screenshot at every matrix case (compare-route.mjs)
 * and the findings of run-checks.mjs for the route. Any fix to the target after the review changes it, so a sign-off
 * holds only for the pixels the reviewer saw. Options: compare and checks, the two report folders.
 */
export function reviewFingerprint(route, { compare, checks }) {
  const hash = createHash("sha256");
  const report = compareReport(compare, route);
  const cases = [...(report.cases ?? [])].sort(
    (a, b) => a.width - b.width || a.height - b.height,
  );
  for (const c of cases) {
    hash.update(`${c.width}x${c.height}\n`);
    const file = c.screenshots?.target;
    hash.update(file && existsSync(file) ? readFileSync(file) : "(none)");
  }
  const checked = checksReport(checks, route);
  hash.update(
    JSON.stringify({
      ok: checked?.ok ?? null,
      findings: (checked?.findings ?? [])
        .map((f) => `${f.check} ${f.kind} ${f.message}`)
        .sort(),
    }),
  );
  return hash.digest("hex").slice(0, 32);
}

/**
 * The PASS gate: every route needs a valid sign-off for that route with verdict pass. With `options` ({ compare,
 * checks }, the report folders) it also needs the route's run-checks report to pass, and the sign-off to name the run
 * the reports hold now (reviewFingerprint), so a review of older pixels does not pass a changed target.
 */
export function verifySignOffs(dir, routes, options) {
  const problems = [];
  for (const route of routes) {
    const file = join(dir, `${routeSlug(route)}.json`);
    if (options?.checks) {
      const checked = checksReport(options.checks, route);
      if (!checked)
        problems.push(
          `${join(options.checks, routeSlug(route), "report.json")}: no run-checks report for ${route}; run run-checks.mjs for it`,
        );
      else if (!checked.ok)
        problems.push(
          `${join(options.checks, routeSlug(route), "report.json")}: run-checks reports ${checked.findings?.length ?? 0} finding(s) for ${route}; fix them, run it again and review the route again`,
        );
    }
    if (!existsSync(file)) {
      problems.push(
        `${file}: no sign-off for ${route}; a person reviews its page and signs it`,
      );
      continue;
    }
    let data;
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      problems.push(`${file}: not valid JSON (${error.message})`);
      continue;
    }
    try {
      validateSignOff(data);
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
      continue;
    }
    if (data.route !== route) {
      problems.push(
        `${file}: signs route ${data.route}, not ${route}; each route has its own file`,
      );
      continue;
    }
    if (data.verdict !== "pass") {
      problems.push(
        `${file}: verdict is issues (${data.notes}); fix them and review again`,
      );
      continue;
    }
    if (options?.compare) {
      if (!data.reviewed) {
        problems.push(
          `${file}: does not say which run it reviewed; sign from the review page or with --sign`,
        );
        continue;
      }
      let now;
      try {
        now = reviewFingerprint(route, options);
      } catch (error) {
        problems.push(`${file}: ${error.message}`);
        continue;
      }
      if (now !== data.reviewed)
        problems.push(
          `${file}: the target's screenshots or findings changed since this review on ${data.date}; build the review page again, review it and sign`,
        );
    }
  }
  return { ok: problems.length === 0, problems };
}

export function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      route: { type: "string", multiple: true },
      sign: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      compare: { type: "string" },
      checks: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      reviewer: { type: "string" },
      verdict: { type: "string" },
      notes: { type: "string" },
      date: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (values.sign && values.verify)
    throw new Error("--sign and --verify are separate steps; pass one");
  if (!values.route?.length)
    throw new Error("--route <path> is required (repeatable)");
  for (const route of values.route) validateRoute(route);
  const mode = values.sign ? "sign" : values.verify ? "verify" : "build";
  if (mode === "sign" && values.route.length !== 1)
    throw new Error("--sign takes one --route: each route gets its own review");
  return {
    mode,
    route: values.route,
    compare: values.compare ?? "artifacts/compare",
    checks: values.checks ?? "artifacts/checks",
    out: values.out ?? "artifacts/review",
    dir: values.dir ?? "docs/migration/review",
    reviewer: values.reviewer,
    verdict: values.verdict,
    notes: values.notes ?? "",
    date: values.date,
  };
}

function build(args) {
  for (const route of args.route) {
    const compare = compareReport(args.compare, route);
    const checksFile = join(args.checks, routeSlug(route), "report.json");
    const checks = checksReport(args.checks, route);
    if (!checks)
      process.stderr.write(
        `review-page: ${checksFile} not found; the page shows no findings until run-checks.mjs runs for ${route}\n`,
      );
    const base = resolve(args.out);
    mkdirSync(base, { recursive: true });
    const html = renderReviewPage({
      route,
      cases: (compare.cases ?? []).map((c) => ({
        width: c.width,
        height: c.height,
        prod: c.screenshots?.prod,
        target: c.screenshots?.target,
      })),
      states: checks?.states ?? [],
      findings: checks?.findings ?? [],
      productionDefects: checks?.productionDefects ?? [],
      base,
      reviewed: reviewFingerprint(route, args),
      checksOk: checks ? checks.ok : false,
    });
    const file = join(args.out, `${routeSlug(route)}.html`);
    writeFileSync(file, html);
    console.log(`wrote ${file}`);
  }
}

function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) return console.log(HELP);
  if (args.mode === "sign") {
    const file = writeSignOff({
      dir: args.dir,
      route: args.route[0],
      reviewer: args.reviewer,
      verdict: args.verdict,
      notes: args.notes,
      date: args.date ?? today(),
      reviewed: reviewFingerprint(args.route[0], args),
    });
    return console.log(`wrote ${file}`);
  }
  if (args.mode === "verify") {
    const { ok, problems } = verifySignOffs(args.dir, args.route, {
      compare: args.compare,
      checks: args.checks,
    });
    for (const p of problems) console.log(`FAIL  ${p}`);
    if (ok)
      console.log(`ok    ${args.route.length} route(s) signed off as pass`);
    else process.exitCode = 1;
    return;
  }
  build(args);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    fail(`review-page: ${error.message}`);
  }
}
