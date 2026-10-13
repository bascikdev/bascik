import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { parseFragment } from "parse5";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import { runScopingPipeline } from "./scoping-template.ts";
import type { BascikComponent } from "./types.ts";

interface SimElement {
  tagName: string;
  id: string;
  classes: Set<string>;
  attrs: Map<string, string>;
  parent: SimElement | null;
  children: SimElement[];
}

function buildSimTree(html: string): SimElement {
  const fragment = parseFragment(html);
  const root: SimElement = {
    tagName: "#root",
    id: "",
    classes: new Set(),
    attrs: new Map(),
    parent: null,
    children: [],
  };

  const walk = (node: any, parent: SimElement) => {
    if (!node || !node.childNodes) return;
    for (const child of node.childNodes) {
      if (typeof child.tagName === "string") {
        const attrs = new Map<string, string>();
        let id = "";
        const classes = new Set<string>();
        for (const attr of child.attrs ?? []) {
          attrs.set(attr.name, attr.value);
          if (attr.name === "id") id = attr.value;
          if (attr.name === "class") {
            for (const token of attr.value.trim().split(/\s+/)) {
              if (token) classes.add(token);
            }
          }
        }
        const el: SimElement = {
          tagName: child.tagName.toLowerCase(),
          id,
          classes,
          attrs,
          parent,
          children: [],
        };
        parent.children.push(el);
        walk(child, el);
      }
    }
  };

  walk(fragment, root);
  return root;
}

function collectElements(root: SimElement): SimElement[] {
  const out: SimElement[] = [];
  const visit = (el: SimElement) => {
    if (el.tagName !== "#root") out.push(el);
    for (const c of el.children) visit(c);
  };
  visit(root);
  return out;
}

function matchesCompound(el: SimElement, compound: string): boolean {
  const trimmed = compound.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return el.tagName !== "#root";

  let rest = trimmed;
  // Optional leading tag or *
  const tagMatch = /^([a-z][a-z1-6]*|\*)/i.exec(rest);
  if (tagMatch) {
    const tag = tagMatch[1].toLowerCase();
    if (tag !== "*" && el.tagName !== tag) return false;
    rest = rest.slice(tagMatch[0].length);
  }

  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const m = /^\.([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return false;
      if (!el.classes.has(m[1])) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("#")) {
      const m = /^#([a-zA-Z0-9_-]+)/.exec(rest);
      if (!m) return false;
      if (el.id !== m[1]) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[")) {
      const m = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/.exec(rest);
      if (!m) return false;
      const attrName = m[1];
      const attrVal = m[2];
      if (!el.attrs.has(attrName)) return false;
      if (attrVal !== undefined && el.attrs.get(attrName) !== attrVal) return false;
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith(":first-child")) {
      if (!el.parent || el.parent.children[0] !== el) return false;
      rest = rest.slice(":first-child".length);
    } else if (rest.startsWith(":not(")) {
      const closeIdx = rest.indexOf(")");
      if (closeIdx === -1) return false;
      const inner = rest.slice(5, closeIdx);
      if (matchesCompound(el, inner)) return false;
      rest = rest.slice(closeIdx + 1);
    } else {
      return false;
    }
  }

  return true;
}

interface SelectorStep {
  combinator: "" | " " | ">" | "+" | "~";
  compound: string;
}

function parseComplexSelector(selector: string): SelectorStep[] {
  const steps: SelectorStep[] = [];
  let i = 0;
  const s = selector.trim();
  let current = "";
  let pendingCombinator: "" | " " | ">" | "+" | "~" = "";
  let depth = 0;

  while (i < s.length) {
    const ch = s[i];
    if (ch === "(" || ch === "[") {
      depth++;
      current += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
      current += ch;
      i++;
      continue;
    }
    if (depth === 0 && (ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch))) {
      if (current) {
        steps.push({ combinator: pendingCombinator, compound: current });
        current = "";
        pendingCombinator = " ";
      }
      while (i < s.length && (s[i] === ">" || s[i] === "+" || s[i] === "~" || /\s/.test(s[i]))) {
        if (s[i] === ">" || s[i] === "+" || s[i] === "~") {
          pendingCombinator = s[i] as ">" | "+" | "~";
        }
        i++;
      }
      continue;
    }
    current += ch;
    i++;
  }
  if (current) {
    steps.push({ combinator: pendingCombinator, compound: current });
  }
  return steps;
}

function matchesStepChain(el: SimElement, steps: SelectorStep[], stepIdx: number): boolean {
  const step = steps[stepIdx];
  if (!matchesCompound(el, step.compound)) return false;
  if (stepIdx === 0) return true;

  const comb = step.combinator;
  if (comb === ">") {
    return Boolean(el.parent && el.parent.tagName !== "#root" && matchesStepChain(el.parent, steps, stepIdx - 1));
  }
  if (comb === " ") {
    let curr = el.parent;
    while (curr && curr.tagName !== "#root") {
      if (matchesStepChain(curr, steps, stepIdx - 1)) return true;
      curr = curr.parent;
    }
    return false;
  }
  if (comb === "+") {
    if (!el.parent) return false;
    const idx = el.parent.children.indexOf(el);
    if (idx <= 0) return false;
    return matchesStepChain(el.parent.children[idx - 1], steps, stepIdx - 1);
  }
  if (comb === "~") {
    if (!el.parent) return false;
    const idx = el.parent.children.indexOf(el);
    for (let k = 0; k < idx; k++) {
      if (matchesStepChain(el.parent.children[k], steps, stepIdx - 1)) return true;
    }
    return false;
  }
  return false;
}

function querySelectorAllSim(root: SimElement, selectorList: string): Set<string> {
  const selectors = selectorList.split(",").map((s) => s.trim()).filter(Boolean);
  const allElements = collectElements(root);
  const matchedMarkers = new Set<string>();

  for (const el of allElements) {
    for (const sel of selectors) {
      const steps = parseComplexSelector(sel);
      if (steps.length > 0 && matchesStepChain(el, steps, steps.length - 1)) {
        const marker = el.attrs.get("data-node-id");
        if (marker) matchedMarkers.add(marker);
      }
    }
  }
  return matchedMarkers;
}

describe("Semantic differential CSS scoping vs. isolated component DOM", () => {
  const tagArb = fc.constantFrom("div", "section", "header", "p", "span", "ul", "li", "h3", "button");
  const clsArb = fc.constantFrom("card", "box", "item", "active", "title");
  const idArb = fc.constantFrom("panel", "hero", "nav", "cta");

  const buildComponentHtml = (
    t1: string,
    t2: string,
    t3: string,
    t4: string,
    c1: string,
    c2: string,
    id1: string,
    prefix: string,
  ): string =>
    `<${t1} data-node-id="${prefix}-1" id="${id1}" class="${c1}">` +
      `<${t2} data-node-id="${prefix}-2" class="${c2}">` +
        `<${t3} data-node-id="${prefix}-3">inner</${t3}>` +
        `<${t4} data-node-id="${prefix}-4" class="${c1}">sibling</${t4}>` +
      `</${t2}>` +
    `</${t1}>`;

  const selectorArb = fc.tuple(tagArb, tagArb, tagArb, clsArb, clsArb, idArb).chain(
    ([t1, t2, t3, c1, c2, id1]) =>
      fc.constantFrom(
        `.${c1}`,
        `.${c1} .${c2}`,
        `.${c1} > .${c2}`,
        `#${id1}`,
        `#${id1} ${t2}`,
        `#${id1} > ${t2} > ${t3}`,
        `#${id1} ${t3} + ${t2}`,
        `#${id1} ${t3} ~ ${t2}`,
        `${t1} ${t2} ${t3}`,
        `${t1} > ${t2}`,
        `.${c2} > ${t3}`,
        `.${c2} * ${t3}`,
        `${t3}:first-child`,
        `.${c1}:not(.${c2})`,
        `${t1}, ${t3}`,
        `${t1}, ${t2} > ${t3}`,
        `#${id1}, .${c2} ${t3}`,
      ),
  );

  it.each([false, true])(
    "matches the exact same component elements in a multi-instance flat page as in an isolated Shadow DOM (minify.identifiers=%s)",
    (minifyIdentifiers) => {
      (BascikConfig.minify as { identifiers: boolean }).identifiers = minifyIdentifiers;
      try {
        fc.assert(
          fc.property(
            tagArb,
            tagArb,
            tagArb,
            tagArb,
            clsArb,
            clsArb,
            idArb,
            selectorArb,
            (t1, t2, t3, t4, c1, c2, id1, rawSelector) => {
              const rawCss = `${rawSelector} { color: red; }`;

              // Ground truth: isolated component tree for instance 1 and instance 2
              const rawInst1Html = buildComponentHtml(t1, t2, t3, t4, c1, c2, id1, "inst1");
              const rawInst2Html = buildComponentHtml(t1, t2, t3, t4, c1, c2, id1, "inst2");
              const expectedInst1 = querySelectorAllSim(buildSimTree(rawInst1Html), rawSelector);
              const expectedInst2 = querySelectorAllSim(buildSimTree(rawInst2Html), rawSelector);
              const expectedUnion = new Set([...expectedInst1, ...expectedInst2]);

              // Scoped compilation of instance 1 and instance 2
              const comp1 = runScopingPipeline(
                {
                  name: "my-widget",
                  fileContent: rawInst1Html,
                  cssFileContent: rawCss,
                } satisfies BascikComponent,
                "a1b2c3d4",
              );
              const comp2 = runScopingPipeline(
                {
                  name: "my-widget",
                  fileContent: rawInst2Html,
                  cssFileContent: rawCss,
                } satisfies BascikComponent,
                "e5f60718",
              );

              // Surrounding page markup + each component instance inside its own container
              const pageHtml =
                `<section><div data-node-id="page-1" id="${id1}" class="${c1}">` +
                  `<${t1} data-node-id="page-2" class="${c2}"><${t3} data-node-id="page-3">page</${t3}></${t1}>` +
                `</div></section>` +
                `<section>${comp1.fileContent}</section>` +
                `<section>${comp2.fileContent}</section>`;

              const scopedSelector = (comp1.cssFileContent ?? "")
                .replace(/\{\s*color:\s*red;\s*\}\s*$/, "")
                .trim();

              const actualMatched = querySelectorAllSim(buildSimTree(pageHtml), scopedSelector);

              // 1. Zero style leakage to surrounding page elements
              for (const id of actualMatched) {
                expect(id.startsWith("page-")).toBe(false);
              }
              // 2. Exact 1:1 match parity with the isolated ground-truth trees
              expect(actualMatched).toEqual(expectedUnion);
            },
          ),
          { numRuns: 250 },
        );
      } finally {
        (BascikConfig.minify as { identifiers: boolean }).identifiers = false;
      }
    },
  );
});
