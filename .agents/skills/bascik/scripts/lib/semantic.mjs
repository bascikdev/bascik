// Semantic HTML checks for the skill scripts. Dependency-free; Node.js 22.22+.
// Heuristic by design: each check is a warning with a fix, never a rule the build enforces. Bascik ships the markup
// you wrote, so the element you pick is the element visitors and screen readers get.
// Spec: https://html.spec.whatwg.org/multipage/dom.html#kinds-of-content
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { walkElements } from "./markup.mjs";

/**
 * The element a component's root should be, from the last word of its tag name (`site-nav` -> nav,
 * `customer-review` -> article). Only the last word counts: `nav-toggle` is a button, not a nav.
 * `card` is left out on purpose: WHATWG defines <article> as a self-contained composition that is independently
 * distributable or reusable, which a post or product card can be and a stat or feature card is not, and the name
 * alone cannot tell them apart. https://html.spec.whatwg.org/multipage/sections.html#the-article-element
 */
const ROOT_BY_LAST_WORD = {
  nav: "nav",
  navbar: "nav",
  navigation: "nav",
  breadcrumb: "nav",
  breadcrumbs: "nav",
  pagination: "nav",
  header: "header",
  footer: "footer",
  form: "form",
  article: "article",
  post: "article",
  review: "article",
  testimonial: "article",
  section: "section",
  sidebar: "aside",
  aside: "aside",
  figure: "figure",
};

/** The semantic root element for a component named `tag`, or undefined when its name does not say. */
export function semanticRootFor(tag) {
  const words = String(tag).toLowerCase().split("-");
  return ROOT_BY_LAST_WORD[words[words.length - 1]];
}

/**
 * Elements that are interactive on their own: a click on them is expected and reachable by keyboard. `a` and `area`
 * count only with an href (see isInteractive): without one, an <a> is not interactive content and a keyboard skips it.
 */
const INTERACTIVE = new Set([
  "audio",
  "body",
  "button",
  "canvas",
  "details",
  "dialog",
  "embed",
  "form",
  "html",
  "iframe",
  "input",
  "label",
  "object",
  "option",
  "select",
  "summary",
  "textarea",
  "video",
]);
const LINKS = new Set(["a", "area"]);
const hasHref = (node) =>
  "href" in node.attrs || "data-bascik-attr-href" in node.attrs;
const isInteractive = (node) =>
  INTERACTIVE.has(node.tag) || (LINKS.has(node.tag) && hasHref(node));
/** Something inside a click target that a keyboard can already use: the listener is delegation or an extra. */
const CONTROL_INSIDE = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "summary",
]);
const hasControlInside = (node) => {
  let found = false;
  walkElements(node, (child) => {
    if (found) return false;
    if (child === node) return;
    if (
      CONTROL_INSIDE.has(child.tag) ||
      (LINKS.has(child.tag) && hasHref(child))
    )
      found = true;
  });
  return found;
};
const GENERIC = new Set(["div", "span"]);
const HEADING = /^h([1-6])$/;
const CONTROLS = new Set(["input", "select", "textarea"]);
const SELF_LABELLED_INPUTS = new Set([
  "hidden",
  "submit",
  "reset",
  "button",
  "image",
]);
const NODE_DIRECTIVES = [
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-routes",
  "data-bascik-server",
  "data-bascik-stream",
];

const isCustom = (tag) => tag.includes("-");
/** A script whose output replaces it in the page, so the audit cannot see the markup it prints. */
const PRINTS_MARKUP = [
  "data-bascik-build",
  "data-bascik-build-once",
  "data-bascik-server",
  "data-bascik-stream",
];
const printsMarkup = (node) =>
  node.tag === "script" && PRINTS_MARKUP.some((name) => name in node.attrs);
const withArticle = (word) => `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
const skipsContent = (node) =>
  node.tag === "head" ||
  node.tag === "script" ||
  node.tag === "style" ||
  node.tag === "template";

const describe = (node) =>
  `<${node.tag}${node.attrs.class ? ` class="${node.attrs.class}"` : node.attrs.id ? ` id="${node.attrs.id}"` : ""}>`;

/** The browser script text of a doc: inline scripts and local `src=` files beside it. */
function browserScripts(doc) {
  const scripts = [];
  walkElements(doc.tree, (node) => {
    if (node.tag !== "script") return;
    if (NODE_DIRECTIVES.some((name) => name in node.attrs)) return false;
    const src = node.attrs.src;
    if (src) {
      if (/^(?:[a-z]+:)?\/\//i.test(src) || src.startsWith("/")) return false;
      const path = join(dirname(doc.path), src);
      if (existsSync(path)) scripts.push(readFileSync(path, "utf8"));
      return false;
    }
    if (node.body) scripts.push(node.body);
    return false;
  });
  return scripts;
}

const ID_LOOKUP = String.raw`document\.getElementById\(\s*["'\x60]([^"'\x60]+)["'\x60]\s*\)`;
/**
 * The body of the handler that starts after `index` (the click registration): a braced function body, or an arrow
 * function's expression up to the closing parenthesis of the call. Undefined when it is not written inline.
 */
function handlerBody(script, index) {
  const rest = script.slice(index);
  const start = /=>\s*|function\s*[\w$]*\s*\([^)]*\)\s*/.exec(rest);
  if (!start || start.index > 200) return undefined;
  let i = start.index + start[0].length;
  if (rest[i] !== "{") {
    let depth = 0;
    for (let j = i; j < rest.length; j++) {
      const c = rest[j];
      if (c === "(") depth++;
      else if (c === ")" && depth-- === 0) return rest.slice(i, j);
      else if ((c === ";" || c === "\n") && depth === 0)
        return rest.slice(i, j);
    }
    return rest.slice(i);
  }
  let depth = 0;
  for (let j = i; j < rest.length; j++) {
    if (rest[j] === "{") depth++;
    else if (rest[j] === "}" && --depth === 0) return rest.slice(i + 1, j);
  }
  return undefined;
}
/** Statements that only hide or close something: a click-to-dismiss backdrop or a menu that closes after a choice. */
const DISMISS =
  /^[\w$.]+(?:!|\s+as\s+[\w.]+)?\s*(?:\.hidden\s*=\s*true|\.(?:hidePopover|close|remove)\(\s*\)|\.classList\.remove\([^()]*\)|\.removeAttribute\(\s*["'\x60](?:open|data-[\w-]+)["'\x60]\s*\))$/;
const onlyDismisses = (body) => {
  if (body === undefined) return false;
  const statements = body
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
    .split(/[;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return statements.length > 0 && statements.every((s) => DISMISS.test(s));
};
const CLICK = String.raw`(?:\?\.|\.)\s*(?:addEventListener\(\s*["'\x60]click["'\x60]|onclick\s*=)`;
const DELEGATION = /\.target\b|closest\(/;

/**
 * Ids a script attaches a click handler to, skipping handlers that read the event target (delegation) and handlers
 * that only hide or close the element (a dismissal, which keyboards get from Escape or a close button).
 */
export function clickedIds(script) {
  const ids = new Set();
  const handlerReadsTarget = (index) =>
    DELEGATION.test(script.slice(index, index + 400)) ||
    onlyDismisses(handlerBody(script, index));
  const variables = new Map();
  for (const m of script.matchAll(
    new RegExp(
      String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*\(?\s*${ID_LOOKUP}`,
      "g",
    ),
  ))
    variables.set(m[1], m[2]);
  for (const [name, id] of variables) {
    const escaped = name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    for (const m of script.matchAll(
      new RegExp(String.raw`(?<![\w$.])${escaped}!?\s*${CLICK}`, "g"),
    ))
      if (!handlerReadsTarget(m.index)) ids.add(id);
  }
  for (const m of script.matchAll(
    new RegExp(
      String.raw`${ID_LOOKUP}\s*(?:!|\s+as\s+[\w.]+\s*\))?\s*${CLICK}`,
      "g",
    ),
  ))
    if (!handlerReadsTarget(m.index)) ids.add(m[1]);
  return ids;
}

/** clickable-element: a non-interactive element made clickable, which a keyboard or screen reader cannot use. */
export function checkClickable(doc, findings) {
  const clicked = new Set();
  for (const script of browserScripts(doc))
    for (const id of clickedIds(script)) clicked.add(id);
  walkElements(doc.tree, (node) => {
    if (skipsContent(node)) return false;
    if (isInteractive(node) || isCustom(node.tag)) return;
    // A popover is a container the browser opens and closes; a click on it is not the control (the invoker is).
    if ("popover" in node.attrs) return;
    const role = (node.attrs.role ?? "").trim().toLowerCase();
    const noHref = LINKS.has(node.tag) ? " but no href" : "";
    const button = `Use <button type="button"> (keep the class and id, and move the listener to it): it is focusable, works with Enter and Space, and is announced as a button with no extra ARIA. Reset its look with CSS (border: 0; background: none; font: inherit).`;
    const navigates = noHref
      ? " Give it an href instead when it navigates."
      : " Use <a href> instead when it navigates.";
    let message;
    let suggestion = button + navigates;
    if (role === "button" || role === "link") {
      // The role does make a screen reader announce it; what is missing is the behavior the native element brings.
      const tabindex = "tabindex" in node.attrs ? "" : "tabindex, ";
      message =
        role === "button"
          ? `${describe(node)} has role="button": it is announced as a button, but it needs ${tabindex}Enter and Space key handling, and disabled handling written by hand, all of which <button type="button"> provides.`
          : `${describe(node)} has role="link": it is announced as a link, but it needs ${tabindex}Enter key handling written by hand, and it does not open in a new tab, show its address, or appear in the browser's history, all of which <a href> provides.`;
      if (role === "link")
        suggestion = `Use <a href="..."> for navigation: it is focusable, works with Enter, and opens in a new tab like any link.`;
    } else {
      let how;
      if ("onclick" in node.attrs) how = `has an onclick attribute${noHref}`;
      else if (
        node.attrs.id &&
        clicked.has(node.attrs.id) &&
        !hasControlInside(node)
      )
        how = `gets a click listener from its script (#${node.attrs.id})${noHref}`;
      if (!how) return;
      message = `${describe(node)} ${how}, so it acts as a button that a keyboard cannot reach and a screen reader does not announce.`;
    }
    findings.push({
      rule: "clickable-element",
      level: "warn",
      file: doc.file,
      line: node.line,
      message,
      suggestion,
    });
  });
}

/** The component's root element: its first element that is not a style, script, link, or meta tag. */
function rootElement(doc) {
  return doc.tree.children.find(
    (node) =>
      !["style", "script", "link", "meta", "template"].includes(node.tag),
  );
}

const hasHeading = (node) => {
  let found = false;
  walkElements(node, (child) => {
    if (found) return false;
    if (HEADING.test(child.tag)) found = true;
  });
  return found;
};

/** generic-root: a component whose root is a div or span when its job has an element of its own. */
export function checkGenericRoot(doc, findings) {
  const expected = semanticRootFor(doc.tag);
  const root = rootElement(doc);
  if (!expected || !root || !GENERIC.has(root.tag)) return;
  if (expected === "section" && !hasHeading(root)) return;
  let inner;
  walkElements(root, (child) => {
    if (inner) return false;
    if (child.tag === expected) inner = child;
  });
  const role = root.attrs.role ? ` with role="${root.attrs.role}"` : "";
  findings.push({
    rule: "generic-root",
    level: "warn",
    file: doc.file,
    line: root.line,
    message: inner
      ? `<${doc.tag}>'s root is a ${describe(root)} wrapper around the <${expected}> at line ${inner.line}.`
      : `<${doc.tag}>'s root is a ${describe(root)}${role}, but ${withArticle(doc.tag.split("-").pop())} has its own element, <${expected}>.`,
    suggestion: inner
      ? `Make the <${expected}> inside it the root (move the wrapper's class and data-testid onto it and delete the wrapper), so attributes from the usage tag (class, aria-label) land on the <${expected}> and the output has no extra div.`
      : `Change the root to <${expected}${expected === "nav" ? ' aria-label="..."' : ""}> and keep its class, id, and data-testid. ${ROOT_REASON[expected]} Bascik replaces <${doc.tag}> with this root, so the element you choose is the element that ships.`,
  });
}

const ROOT_REASON = {
  nav: "A <nav> is a navigation landmark screen readers list and jump to.",
  header: "A <header> at the top of the page is the banner landmark.",
  footer: "A <footer> at the end of the page is the contentinfo landmark.",
  form: "A <form> submits with Enter, groups its controls, and works without JavaScript.",
  article:
    "An <article> marks a self-contained item, such as a post, review, or testimonial, that makes sense on its own.",
  section:
    "A <section> with a heading is a region of the page that shows in the document outline.",
  aside:
    "An <aside> is a complementary landmark for content beside the main content.",
  figure:
    "A <figure> ties an image, chart, or code sample to its <figcaption>.",
};

/** missing-alt: an <img> with no alt attribute, in a page or component. */
export function checkAlt(doc, findings) {
  walkElements(doc.tree, (node) => {
    if (skipsContent(node)) return false;
    if (node.tag !== "img") return;
    if ("alt" in node.attrs || "data-bascik-attr-alt" in node.attrs) return;
    findings.push({
      rule: "missing-alt",
      level: "warn",
      file: doc.file,
      line: node.line,
      message: `<img${node.attrs.src ? ` src="${node.attrs.src}"` : ""}> has no alt attribute, so screen readers read out its file name.`,
      suggestion: `Add alt="what the image shows" when it carries meaning, or alt="" when it is decoration. In a component, take it from a prop with data-bascik-attr-alt="alt".`,
    });
  });
}

/**
 * Controls in components that every use wraps in a <label>, found in each page's composed output: a component that is
 * only an <input> is labeled by `<label>Text <my-input /></label>` on the page, which its own file cannot show.
 * A control that no page uses, or that one use leaves bare, is not in the set.
 */
export function controlsLabelledByUse(pages, componentDocs) {
  const seen = new Map();
  for (const page of pages)
    walkComposed(page, componentDocs, ({ node, doc, ancestors }) => {
      if (doc === page || !CONTROLS.has(node.tag)) return;
      let inLabel = false;
      for (let up = ancestors; up; up = up.up)
        if (up.node.tag === "label") inLabel = true;
      seen.set(node, (seen.get(node) ?? true) && inLabel);
    });
  return new Set([...seen].filter(([, wrapped]) => wrapped).map(([n]) => n));
}

/**
 * unlabeled-control: an input, select, or textarea with no label a screen reader can read. `labelledByUse` holds the
 * component controls every page wraps in a <label> (controlsLabelledByUse).
 */
export function checkLabels(doc, findings, labelledByUse = new Set()) {
  const labelled = new Set();
  walkElements(doc.tree, (node) => {
    if (node.tag === "label" && node.attrs.for) labelled.add(node.attrs.for);
  });
  walkElements(doc.tree, (node) => {
    if (skipsContent(node)) return false;
    if (!CONTROLS.has(node.tag)) return;
    const type = (node.attrs.type ?? "text").toLowerCase();
    if (node.tag === "input" && SELF_LABELLED_INPUTS.has(type)) return;
    if ("hidden" in node.attrs) return;
    const named = [
      "aria-label",
      "aria-labelledby",
      "title",
      "data-bascik-attr-aria-label",
      "data-bascik-attr-aria-labelledby",
      "data-bascik-attr-title",
      "data-bascik-attr-id",
    ].some((name) => name in node.attrs);
    if (named) return;
    if (node.attrs.id && labelled.has(node.attrs.id)) return;
    for (let p = node.parent; p; p = p.parent) if (p.tag === "label") return;
    if (labelledByUse.has(node)) return;
    const what =
      node.tag === "input" ? `<input type="${type}">` : `<${node.tag}>`;
    findings.push({
      rule: "unlabeled-control",
      level: "warn",
      file: doc.file,
      line: node.line,
      message: `${what}${node.attrs.name ? ` (name="${node.attrs.name}")` : ""} has no label${"placeholder" in node.attrs ? "; a placeholder is not one, since it disappears as soon as someone types" : ""}.`,
      suggestion: `Add <label for="${node.attrs.id ?? "an-id"}">Visible text</label> with a matching id on the control, or wrap the control in its <label>. Use aria-label only when the purpose is clear without visible text (a search box next to a search button). Group related controls in <fieldset> with a <legend>.`,
    });
  });
}

/**
 * Walk a page's composed output in document order: component tags are replaced by their templates, and slot
 * elements by the content the usage tag passes in. Visits `{ node, doc, at }`, where `at` is the line in the page
 * that the element comes from (the component tag's line for content that comes from a component), and `ancestors`
 * is its composed parent chain as a linked list ({ node, up }), the usage tags and slots already replaced. A script
 * that prints markup at build or request time is visited with `printed: true`, since what it prints is unknown here.
 */
export function walkComposed(page, componentDocs, visit) {
  const walk = (nodes, ctx) => {
    for (const node of nodes) {
      const at = ctx.doc === page ? node.line : ctx.at;
      if (printsMarkup(node))
        visit({
          node,
          doc: ctx.doc,
          at,
          ancestors: ctx.ancestors,
          printed: true,
        });
      if (skipsContent(node)) continue;
      const component = componentDocs.get(node.tag);
      if (component && !ctx.stack.has(node.tag)) {
        const slots = new Map();
        for (const child of node.children) {
          const name = child.attrs["data-bascik-slot"];
          const key = name === undefined ? "" : name;
          if (!slots.has(key)) slots.set(key, []);
          slots.get(key).push(child);
        }
        walk(component.tree.children, {
          doc: component,
          at,
          stack: new Set([...ctx.stack, node.tag]),
          ancestors: ctx.ancestors,
          slots: { map: slots, ctx: { ...ctx, at } },
        });
        continue;
      }
      if ("data-bascik-slot" in node.attrs && ctx.slots) {
        const name = node.attrs["data-bascik-slot"] || "";
        const passed = ctx.slots.map.get(name);
        if (passed?.length) {
          if (name) {
            // Bascik drops a named wrapper and keeps what is inside it. A wrapper a template passes to a child is
            // that template's content, so no named placeholder in there is filled from an outer usage, but a
            // valueless marker in there still receives the outer usage's default slot (the build forwards it).
            const outer = ctx.slots.ctx.slots;
            walk(
              passed.flatMap((wrapper) => wrapper.children),
              {
                ...ctx.slots.ctx,
                slots: outer && {
                  map: new Map([["", outer.map.get("") ?? []]]),
                  ctx: outer.ctx,
                },
                ancestors: ctx.ancestors,
              },
            );
          }
          // Default slot content keeps the outer slots, so a valueless marker forwards the outer default slot.
          else walk(passed, { ...ctx.slots.ctx, ancestors: ctx.ancestors });
          continue;
        }
      }
      visit({ node, doc: ctx.doc, at, ancestors: ctx.ancestors });
      walk(node.children, {
        ...ctx,
        ancestors: { node, up: ctx.ancestors },
      });
    }
  };
  walk(page.tree.children, { doc: page, at: 1, stack: new Set() });
}

/** skipped-heading and missing-main: checks on what a page ships, after its components are expanded. */
export function checkComposedPage(page, componentDocs, findings) {
  // The last heading seen, or "unknown" after a script that prints markup (its headings cannot be seen here, so the
  // next visible heading starts a fresh comparison instead of being checked against a guess).
  let previous;
  let printed = false;
  let hasMain = false;
  let body;
  let hasContent = false;
  let redirects = false;
  walkElements(page.tree, (node) => {
    if (
      node.tag === "meta" &&
      (node.attrs["http-equiv"] ?? "").toLowerCase() === "refresh"
    )
      redirects = true;
  });
  walkComposed(page, componentDocs, ({ node, doc, at, printed: prints }) => {
    if (prints) {
      printed = true;
      previous = "unknown";
      return;
    }
    if (node.tag === "body" && doc === page) body = node;
    if (node.tag === "main" || node.attrs.role === "main") hasMain = true;
    if (!["html", "body", "#root"].includes(node.tag)) hasContent = true;
    const level = HEADING.exec(node.tag)?.[1];
    if (!level) return;
    const n = Number(level);
    const prev = previous?.level ?? 1;
    if (previous !== "unknown" && n > prev + 1) {
      const where = `${doc.file}:${node.line}`;
      findings.push({
        rule: "skipped-heading",
        level: "warn",
        file: page.file,
        line: at,
        message: `The page's output goes from ${previous ? `<h${previous.level}> (${previous.where})` : "the top of the page"} to <h${n}> (${where}), skipping <h${prev + 1}>${previous ? ` after <h${previous.level}>` : ""}.`,
        suggestion: `Use <h${prev + 1}> there, and style it with a class if it should look smaller: heading levels give the outline screen reader users navigate by, not the font size. If the component is used under different levels, take the heading from a slot so each page picks the level.`,
      });
    }
    previous = { level: n, where: `${doc.file}:${node.line}` };
  });
  if (hasMain || redirects || printed || !hasContent) return;
  findings.push({
    rule: "missing-main",
    level: "warn",
    file: page.file,
    line: body?.line ?? 1,
    message: `${page.file} has no <main> element, in the page or in the components it uses.`,
    suggestion: `Wrap the page's own content in <main id="main"> (between the header and footer components) so screen readers and skip links can jump to it. One <main> per page.`,
  });
}
