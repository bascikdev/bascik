#!/usr/bin/env node
// Repeated sections: fingerprint every section's structure (tag tree with its landmarks and heading shape, no text)
// on every production route. A fingerprint on two or more routes must be ONE Bascik component in the target source,
// and every rendered instance of it must have the same computed-style signature.
// Dependency-free; Node.js 22.22+; needs playwright (or @playwright/test) in your project.
//
// Why: a section repeated on several pages, which any human would make a component, was pasted per page by the agent,
// and one copy was styled wrong.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { inPage } from "./lib/dom.mjs";
import {
  casesOf,
  finding,
  parseArgsFor,
  result,
  routesOf,
  settleOf,
  runCli,
  withPage,
} from "./lib/checks.mjs";
import { fail, isMain } from "./lib/cli.mjs";

export const CHECK = "repeated-sections";

const HELP = `Usage: node repeated-sections.mjs --prod <url> --target <url> --route <path> --route <path>... [options]

Fingerprints the structure of every section, header, footer, nav, aside and article on each production route, and
of every div that holds a heading (a block a page builder marked up without landmarks): the tag tree with landmarks
and heading levels, runs of identical siblings collapsed, no text and no class names. A fingerprint found on two or
more routes must render from one component in the target: the page sources of those routes (src/pages) must all use
it, and its heading text must not be pasted into a page source. Every instance on the target must match production's
computed-style signature (box, spacing, colors and type of the root and of every part, the third card as much as the
first) at every matrix case. Exits 1 on any finding.

Options:
  --prod <url>         Live production origin
  --target <url>       Bascik origin, such as http://localhost:8080 (a production build: bascik --server)
  --route <path>       Route to fingerprint (repeatable; two or more)
  --target-src <dir>   The Bascik project, holding src/pages and src/components (default .)
  --settle-ms <ms>     Least time after navigation before measuring (default 5000)
  --matrix <file>      Breakpoint matrix JSON (default docs/migration/breakpoints.json)
  --out <dir>          Report folder (default artifacts/checks)
  --json               Print the report as JSON
  --help               Show this message`;

/**
 * Elements that can be a section: landmarks, and blocks marked up as plain elements that hold a heading (a page
 * builder's <div class="features">). Only the outermost repeat is reported, so a wrapper and the block in it are one.
 */
const SECTION_SELECTOR =
  'section, header, footer, nav, aside, article, [role="region"], [role="banner"], [role="contentinfo"], div:has(> h1, > h2, > h3, > h4, > h5, > h6), div:has(> * > h1, > * > h2, > * > h3)';

/**
 * A fingerprint smaller than this (nodes after collapsing, depth) is too generic to call a repeat, unless it is a band
 * with a heading and a link or button (a call to action, a testimonial): such a band of SMALL_MIN_NODES or more counts
 * when its heading text repeats too, so two different bands with the same three tags are not one section.
 */
const MIN_NODES = 5;
const MIN_DEPTH = 3;
const SMALL_MIN_NODES = 3;

/** Computed styles in a section's signature: the root, and each part found by its structural path. */
const SIGNATURE_PROPS = [
  "display",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin-top",
  "margin-bottom",
  "background-color",
  "background-image",
  "color",
  "border-top-width",
  "border-top-color",
  "border-radius",
  "box-shadow",
  "gap",
  "grid-template-columns",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
];

/** A tree's canonical string: tags in order, runs of identical siblings collapsed to one. */
function shape(tree) {
  const kids = [];
  for (const child of tree.children ?? []) {
    const s = shape(child);
    if (kids[kids.length - 1] !== s) kids.push(s);
  }
  return kids.length ? `${tree.tag}(${kids.join(",")})` : tree.tag;
}

/**
 * The structural fingerprint of a section tree ({ tag, children }): the same for the same structure whatever its text
 * and classes, three cards or four. Heading levels and landmarks are tags, so they count.
 */
export function fingerprint(tree) {
  return createHash("sha256").update(shape(tree)).digest("hex").slice(0, 16);
}

/** The tree with runs of identical siblings collapsed to one, as fingerprint() sees it. */
function collapse(tree) {
  const children = [];
  let last;
  for (const child of tree.children ?? []) {
    const c = collapse(child);
    const s = shape(c);
    if (s !== last) children.push(c);
    last = s;
  }
  return { tag: tree.tag, children };
}

/** Node count and depth of a tree after collapsing repeats, to skip shapes too generic to matter. */
function size(tree) {
  const walk = (node, depth) =>
    node.children.reduce(
      (acc, child) => {
        const r = walk(child, depth + 1);
        return {
          nodes: acc.nodes + r.nodes,
          depth: Math.max(acc.depth, r.depth),
        };
      },
      { nodes: 1, depth },
    );
  return walk(collapse(tree), 1);
}

/** Whether a tree is a band: a heading and a link or button somewhere in it. */
function isBand(tree) {
  const tags = new Set();
  const walk = (node) => {
    tags.add(node.tag);
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return (
    [...tags].some((t) => /^H[1-6]$/.test(t)) &&
    (tags.has("A") || tags.has("BUTTON"))
  );
}

/**
 * The fingerprint of a section if it is specific enough to call a repeat, or null. A small band (see MIN_NODES) is
 * fingerprinted with its heading text, so only the same band on two routes repeats.
 */
export function sectionFingerprint(section) {
  const { nodes, depth } = size(section.tree);
  if (nodes >= MIN_NODES && depth >= MIN_DEPTH)
    return fingerprint(section.tree);
  if (nodes >= SMALL_MIN_NODES && section.label && isBand(section.tree))
    return createHash("sha256")
      .update(`${shape(section.tree)}\n${section.label}`)
      .digest("hex")
      .slice(0, 16);
  return null;
}

/**
 * The fingerprints present on two or more routes: [{ fingerprint, routes, keys }] in route order. `byRoute` maps a
 * route to its sections, [{ fingerprint, key }]. A section repeated on one route only is not a cross-route repeat.
 */
export function findRepeated(byRoute) {
  const seen = new Map();
  for (const [route, sections] of Object.entries(byRoute))
    for (const s of sections) {
      const entry = seen.get(s.fingerprint) ?? { routes: [], keys: [] };
      if (!entry.routes.includes(route)) {
        entry.routes.push(route);
        entry.keys.push(s.key);
      }
      seen.set(s.fingerprint, entry);
    }
  return [...seen]
    .filter(([, e]) => e.routes.length >= 2)
    .map(([fp, e]) => ({ fingerprint: fp, routes: e.routes, keys: e.keys }));
}

const posix = (p) => p.split(sep).join("/");

function htmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** Custom element tags used in an HTML text, for the names in `known`. */
function tagsUsed(text, known) {
  const used = new Set();
  for (const m of text.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]*)\b/g))
    if (known.has(m[1])) used.add(m[1]);
  return [...used].sort();
}

/**
 * The target's components and which ones each page uses: { components: [name], pages: { "src/pages/x.html": [name] },
 * uses: { name: [name] }, files: { name: "src/components/x.html" } }. Paths are relative to `root` with forward slashes.
 */
export function componentUsage(root) {
  const pagesDir = join(root, "src", "pages");
  if (!existsSync(pagesDir) || !statSync(pagesDir).isDirectory())
    throw new Error(
      `${posix(join(root, "src/pages"))} not found: pass the Bascik project with --target-src (it holds src/pages and src/components)`,
    );
  const componentsDir = join(root, "src", "components");
  const componentFiles = existsSync(componentsDir)
    ? htmlFiles(componentsDir)
    : [];
  // Bascik names a component by its filename only, in any folder: marketing/promo-card.html is <promo-card>.
  const byName = new Map();
  for (const file of componentFiles) {
    const name = file
      .split(sep)
      .at(-1)
      .replace(/\.html$/, "");
    if (name.includes("-")) byName.set(name, file);
  }
  const known = new Set(byName.keys());
  const pages = {};
  for (const file of htmlFiles(pagesDir))
    pages[posix(relative(root, file))] = tagsUsed(
      readFileSync(file, "utf8"),
      known,
    );
  const files = Object.fromEntries(
    [...byName].map(([name, file]) => [name, posix(relative(root, file))]),
  );
  const uses = {};
  for (const [name, file] of byName)
    uses[name] = tagsUsed(readFileSync(file, "utf8"), known).filter(
      (n) => n !== name,
    );
  return { components: [...known], pages, uses, files };
}

/** The page source for a route: src/pages/<path>.html or src/pages/<path>/index.html, or undefined. */
export function pageFor(usage, route) {
  const path = String(route)
    .split(/[?#]/, 1)[0]
    .replace(/^\/+|\/+$/g, "");
  const candidates = path
    ? [`src/pages/${path}.html`, `src/pages/${path}/index.html`]
    : ["src/pages/index.html"];
  return candidates.find((c) => c in usage.pages);
}

/** Components a page renders, directly or through other components. */
function transitive(usage, page) {
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    out.add(name);
    for (const n of usage.uses[name] ?? []) visit(n);
  };
  for (const name of usage.pages[page] ?? []) visit(name);
  return out;
}

/**
 * Compares the signatures of the instances of one repeated section ([{ route, width, signature, reference? }]), where
 * `reference` is production's signature on that route. When instances differ, each property is held against
 * production's value (the most common target value when there is no reference), so the wrong copy is blamed, even on
 * the first route. A diverging-instance finding names its route, width and property, with production's value as
 * `prod`. Properties in `ignore` (production's own instances differ there) are skipped.
 */
export function diffInstances(key, instances, ignore = new Set()) {
  const findings = [];
  const byWidth = new Map();
  for (const inst of instances) {
    const list = byWidth.get(inst.width) ?? [];
    list.push(inst);
    byWidth.set(inst.width, list);
  }
  for (const [width, list] of byWidth) {
    if (list.length < 2) continue;
    const props = new Set(list.flatMap((i) => Object.keys(i.signature)));
    for (const property of props) {
      if (ignore.has(`${width} ${property}`)) continue;
      const counts = new Map();
      for (const inst of list) {
        const v = inst.signature[property];
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      if (counts.size < 2) continue;
      let majority = list[0].signature[property];
      for (const [v, n] of counts)
        if (n > (counts.get(majority) ?? 0)) majority = v;
      for (const inst of list) {
        const v = inst.signature[property];
        const reference =
          inst.reference && property in inst.reference
            ? inst.reference[property]
            : majority;
        if (v === reference) continue;
        const matching = list
          .filter((i) => i.signature[property] === reference)
          .map((i) => i.route);
        const others = matching.length
          ? ` and on ${matching.join(", ")} of the target`
          : "";
        findings.push(
          finding(
            CHECK,
            "diverging-instance",
            inst.reference
              ? `${key} on ${inst.route} at ${width} px: ${property} is "${v}" on the target, but "${reference}" in production${others}; every instance of one component must match`
              : `${key} on ${inst.route} at ${width} px: ${property} is "${v}", but "${reference}"${matching.length ? ` on ${matching.join(", ")}` : ""}; every instance of one component must match`,
            {
              key,
              route: inst.route,
              width,
              property,
              prod: reference,
              target: v,
            },
          ),
        );
      }
    }
  }
  return findings;
}

/** In the page: every section with its tree, key, signature and component hints. */
function collectSections(arg) {
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "TEMPLATE",
    "NOSCRIPT",
    "LINK",
    "META",
  ]);
  const tree = (el) => ({
    tag: tagOf(el),
    children: [...el.children]
      .filter((c) => !SKIP.has(tagOf(c)))
      .map((c) => tree(c)),
  });
  const pick = (el) => {
    const cs = getComputedStyle(el);
    return Object.fromEntries(
      arg.props.map((p) => [p, cs.getPropertyValue(p)]),
    );
  };
  const out = [];
  for (const el of document.querySelectorAll(arg.selector)) {
    if (!isRendered(el)) continue;
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6");
    const label = norm(heading?.textContent) || accName(el);
    const signature = {};
    for (const [p, v] of Object.entries(pick(el))) signature[p] = v;
    // Every part, numbered among the siblings with its tag ("DIV:3 H3"), so the third card counts as much as the first.
    const visit = (node, path) => {
      const seen = new Map();
      for (const child of node.children) {
        if (SKIP.has(tagOf(child)) || !isRendered(child)) continue;
        const n = (seen.get(tagOf(child)) ?? 0) + 1;
        seen.set(tagOf(child), n);
        const sub = `${path}${path ? " " : ""}${tagOf(child)}${n > 1 ? `:${n}` : ""}`;
        for (const [p, v] of Object.entries(pick(child)))
          signature[`${sub} ${p}`] = v;
        visit(child, sub);
      }
    };
    visit(el, "");
    const classes = new Set();
    for (const node of [el, ...el.querySelectorAll("*")])
      for (const c of node.classList ?? []) {
        const m = /^bascik__([a-z][a-z0-9-]*)__/.exec(c);
        if (m) classes.add(m[1]);
      }
    // The component that renders the section: one whose scoped class is on the section itself, on a wrapper around
    // nothing but the section (a component root), or on the one element inside it that holds all its content. A
    // layout component around a page's slot holds more than the section, so it is not the section's owner.
    const scoped = (n) =>
      [...(n.classList ?? [])]
        .map((c) => /^bascik__([a-z][a-z0-9-]*)__/.exec(c)?.[1])
        .find(Boolean);
    const text = norm(el.textContent);
    let owner = null;
    const within = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const own = scoped(n);
      if (!own) continue;
      if (!owner && norm(n.textContent) === text) owner = own;
      else if (n !== el) within.push(own);
    }
    if (!owner)
      for (const inner of el.querySelectorAll("*")) {
        if (norm(inner.textContent) !== text) break;
        const own = scoped(inner);
        if (own) {
          owner = own;
          break;
        }
      }
    out.push({
      tree: tree(el),
      key: `${tagOf(el)}:${label.slice(0, 70).trim()}`,
      label: label.slice(0, 70).trim(),
      tag: tagOf(el),
      path: pathOf(el),
      signature,
      owner,
      within,
      testId: el.getAttribute("data-testid"),
      classes: [...classes],
    });
  }
  return out;
}

async function sections(browser, origin, route, c, options) {
  return withPage(
    browser,
    origin,
    route,
    c,
    (page) =>
      inPage(page, collectSections, {
        selector: SECTION_SELECTOR,
        props: SIGNATURE_PROPS,
      }),
    [],
    settleOf(options),
  );
}

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  middot: "\u00b7",
  eacute: "\u00e9",
};

/** Decodes the character references an author writes in HTML text (&amp;, &rsquo;, &#39;, &#x2014;). */
export function decodeEntities(text) {
  return String(text).replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
    (all, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return ENTITIES[name.toLowerCase()] ?? all;
    },
  );
}

/**
 * The text of every page and component source with tags removed, character references decoded and whitespace
 * collapsed, so a heading written "Froth &amp; pour" in the source matches the rendered "Froth & pour".
 */
function sourceTexts(root, usage) {
  const read = (rel) =>
    decodeEntities(
      readFileSync(join(root, rel), "utf8").replace(/<[^>]*>/g, " "),
    ).replace(/\s+/g, " ");
  const pages = Object.fromEntries(
    Object.keys(usage.pages).map((p) => [p, read(p)]),
  );
  const components = Object.fromEntries(
    Object.entries(usage.files ?? {}).map(([name, rel]) => [name, read(rel)]),
  );
  return { pages, components };
}

/**
 * The component that renders a target instance, or null when its page pastes the markup. In order: its scoped class
 * name (bascik__<name>__), its data-testid, then the source: a page whose own source holds the section's heading text
 * pastes it; a component the page renders that holds the text renders it. Only when the text is in no source (it
 * comes from data or props) does the one component every page shares get the credit, and only if the section sits
 * inside it or nothing says which component it sits in.
 */
function componentOf(instance, usage, pages, page, sources) {
  const known = new Set(usage.components);
  if (instance.owner && known.has(instance.owner)) return instance.owner;
  if (instance.testId && known.has(instance.testId)) return instance.testId;
  const label = String(instance.label ?? "").trim();
  if (label && sources) {
    if (sources.pages[page]?.includes(label)) return null;
    const rendered = transitive(usage, page);
    const holders = [...rendered].filter((name) =>
      sources.components[name]?.includes(label),
    );
    if (holders.length === 1) return holders[0];
    if (holders.length > 1) return null;
  }
  const shared = pages
    .map((p) => transitive(usage, p))
    .reduce((a, b) => new Set([...a].filter((n) => b.has(n))));
  if (shared.size !== 1) return null;
  const [only] = shared;
  const within = instance.within ?? [];
  return within.length && !within.includes(only) ? null : only;
}

/**
 * Resolves to { check, ok, findings, repeated }. Options: prod, target, routes (two or more), cases, targetSrc.
 */
export async function runCheck(browser, options) {
  const routes = routesOf(options);
  const cases = casesOf(options);
  const usage = componentUsage(options.targetSrc ?? ".");
  const sources = sourceTexts(options.targetSrc ?? ".", usage);
  const findings = [];
  const prod = {};
  const target = {};
  for (const c of cases)
    for (const route of routes) {
      prod[`${c.width} ${route}`] = await sections(
        browser,
        options.prod,
        route,
        c,
        options,
      );
      target[`${c.width} ${route}`] = await sections(
        browser,
        options.target,
        route,
        c,
        options,
      );
    }
  // Fingerprints come from the first case; the signatures are compared at every case.
  const first = cases[0].width;
  const byRoute = {};
  for (const route of routes)
    byRoute[route] = prod[`${first} ${route}`]
      .map((s) => ({ ...s, fingerprint: sectionFingerprint(s) }))
      .filter((s) => s.fingerprint);
  let repeated = findRepeated(byRoute);
  // Report the outermost repeat only: a nav inside a repeated header is part of the header's component.
  const instancesOf = (r) =>
    r.routes.map((route) =>
      byRoute[route].find((s) => s.fingerprint === r.fingerprint),
    );
  repeated = repeated.filter(
    (r) =>
      !repeated.some(
        (o) =>
          o !== r &&
          r.routes.every((route) => o.routes.includes(route)) &&
          instancesOf(r).every((inst, i) =>
            inst.path.startsWith(
              `${byRoute[r.routes[i]].find((s) => s.fingerprint === o.fingerprint).path}.`,
            ),
          ),
      ),
  );
  for (const r of repeated) {
    const label = r.keys[0];
    const pages = r.routes.map((route) => pageFor(usage, route));
    const missingPage = r.routes.filter((_, i) => !pages[i]);
    if (missingPage.length) {
      findings.push(
        finding(
          CHECK,
          "missing-page",
          `${label} repeats on ${r.routes.join(", ")}, but ${missingPage.join(", ")} has no page in src/pages`,
          { key: label, routes: r.routes },
        ),
      );
      continue;
    }
    // The same section on the target: by key, by structure, or by its heading text on any element (a Bascik build
    // may drop the wrapper production put around it).
    const matchTarget = (route, key, width) => {
      const list = target[`${width} ${route}`];
      const label = key.slice(key.indexOf(":") + 1);
      return (
        list.find((s) => s.key === key) ??
        list.find((s) => sectionFingerprint(s) === r.fingerprint) ??
        (label ? list.find((s) => s.label === label) : undefined)
      );
    };
    const found = r.routes.map((route, i) =>
      matchTarget(route, r.keys[i], first),
    );
    const owners = found.map((inst, i) =>
      inst ? componentOf(inst, usage, pages, pages[i], sources) : null,
    );
    const name = owners[0];
    const sameComponent =
      name &&
      owners.every((o) => o === name) &&
      pages.every((p) => transitive(usage, p).has(name));
    if (!sameComponent)
      findings.push(
        finding(
          CHECK,
          "duplicated-markup",
          `${label} has the same structure on ${r.routes.join(", ")} (${r.keys.join("; ")}), but the target does not render it from one component: ${r.routes
            .map(
              (route, i) =>
                `${route} in ${pages[i]}${owners[i] ? ` uses ${owners[i]}` : " pastes the markup"}`,
            )
            .join(
              ", ",
            )}. Make it one component in src/components and use it on every page`,
          { key: label, routes: r.routes, pages },
        ),
      );
    for (const c of cases) {
      const instances = [];
      const ignore = new Set();
      const prodInst = r.routes.map((route, i) =>
        prod[`${c.width} ${route}`].find(
          (s) => s.key === r.keys[i] || sectionFingerprint(s) === r.fingerprint,
        ),
      );
      for (const property of new Set(
        prodInst.flatMap((s) => Object.keys(s?.signature ?? {})),
      ))
        if (new Set(prodInst.map((s) => s?.signature[property])).size > 1)
          ignore.add(`${c.width} ${property}`);
      r.routes.forEach((route, i) => {
        const inst = matchTarget(route, r.keys[i], c.width);
        if (inst)
          instances.push({
            route,
            width: c.width,
            signature: inst.signature,
            reference: prodInst[i]?.signature,
          });
      });
      findings.push(...diffInstances(label, instances, ignore));
    }
  }
  return result(CHECK, findings, { repeated });
}

export function parseCliArgs(argv) {
  const args = parseArgsFor(argv, {
    extra: { "target-src": { type: "string" } },
  });
  if (args.help) return args;
  if (args.route.length < 2)
    throw new Error(
      "--route: pass two or more routes; a section can only repeat across routes",
    );
  const { "target-src": targetSrc, ...rest } = args;
  return { ...rest, targetSrc: targetSrc ?? "." };
}

if (isMain(import.meta.url)) {
  try {
    await runCli({ check: CHECK, help: HELP, parseCliArgs, runCheck });
  } catch (error) {
    fail(`${CHECK}: ${error.message}`);
  }
}
