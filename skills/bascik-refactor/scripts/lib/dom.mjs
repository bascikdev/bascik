// In-page helpers for the parity checks. Dependency-free; Node.js 22.22+.
//
// Each function below runs inside the browser, never in Node. inPage() sends them with the check's own function as
// one expression through Playwright's page.evaluate, which goes over the DevTools protocol, so a production site's
// Content-Security-Policy (no unsafe-eval) cannot block it. Keep them plain function declarations that use only
// browser globals and each other.

/** Collapses whitespace and trims. */
function norm(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Rendered with a size: not display none, not visibility hidden, not opacity 0 (also through an ancestor). */
function isRendered(el) {
  if (!el?.isConnected) return false;
  if (typeof el.checkVisibility === "function") {
    if (
      !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
      return false;
  } else {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility !== "visible") return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** The upper-case tag name, also for SVG elements. */
function tagOf(el) {
  return String(el.tagName).toUpperCase();
}

/** The accessible name, simplified: aria-labelledby, aria-label, alt, a label, title, then the text. */
function accName(el) {
  const ids = el.getAttribute("aria-labelledby");
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (norm(text)) return norm(text);
  }
  const label = el.getAttribute("aria-label");
  if (label && norm(label)) return norm(label);
  if (tagOf(el) === "IMG") return norm(el.getAttribute("alt"));
  if (el.labels?.length)
    return norm([...el.labels].map((l) => l.textContent).join(" "));
  const own = keyText(el, Infinity);
  if (own) return own;
  return norm(el.getAttribute("title"));
}

/** The explicit role, or the implicit role of the common interactive elements and landmarks. */
function roleOf(el) {
  const explicit = norm(el.getAttribute("role")).split(" ")[0];
  if (explicit) return explicit;
  const tag = tagOf(el);
  const type = String(el.getAttribute("type") ?? "").toLowerCase();
  if (tag === "A") return el.hasAttribute("href") ? "link" : null;
  if (tag === "BUTTON" || tag === "SUMMARY") return "button";
  if (tag === "INPUT") {
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox" || type === "radio") return type;
    return "textbox";
  }
  const map = {
    SELECT: "combobox",
    TEXTAREA: "textbox",
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    FORM: "form",
    DIALOG: "dialog",
    IMG: "img",
  };
  if (map[tag]) return map[tag];
  if (/^H[1-6]$/.test(tag)) return "heading";
  return null;
}

/**
 * Cuts `text` after `max` characters that are not whitespace (default 80, the most a text key keeps), so two texts
 * that differ only in whitespace are cut at the same place and still match once whitespace is removed (matchKeyInPage).
 */
function capText(text, max) {
  const limit = max ?? 80;
  if (limit === Infinity) return text;
  let kept = 0;
  let i = 0;
  for (; i < text.length && kept < limit; i++) if (!/\s/.test(text[i])) kept++;
  return text.slice(0, i).trim();
}

/**
 * The text a reader sees in `el`, for a key: the text of its rendered descendants only (a closed menu kept in the
 * markup as a hidden list, visibility hidden or opacity 0 text, scripts and styles add nothing), with each
 * <time datetime> read as its datetime (a relative date that ticks over between the two loads is still the same text),
 * whitespace collapsed for display and cut after `max` visible characters (default 80; Infinity keeps all). When `el`
 * itself is not rendered (a closed panel), all its text counts, so it has the key it has once open. Text inside a
 * display: contents wrapper (no box of its own) counts when the wrapper's nearest ancestor with a box is rendered.
 * collectNodes in geometry-diff.mjs reads text the same way (it must be self-contained); keep the two in step.
 *
 * Markup formatting still shows in the result: React writes no whitespace between elements, formatted HTML has
 * newlines there, so "MILK<br>FROTHER" reads "MILKFROTHER" on one side and "MILK FROTHER" on the other. Compare keys
 * with keyMatch (lib/checks.mjs; matchKeyInPage in the page), which removes all whitespace; keep this text for messages.
 */
function keyText(el, max) {
  const limit = max ?? 80;
  // A display: contents element has no box, so checkVisibility() is false for it although its text is rendered: its
  // nearest ancestor with a box decides (visibility still applies, since the text inherits it).
  const shown = (node) => {
    const cs = getComputedStyle(node);
    if (cs.display === "contents")
      return (
        cs.visibility === "visible" &&
        (!node.parentElement || shown(node.parentElement))
      );
    return typeof node.checkVisibility === "function"
      ? node.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
      : cs.display !== "none" && cs.visibility === "visible";
  };
  const every = !shown(el);
  const seen = new Map();
  const visible = (node) => {
    if (every || node === el) return true;
    if (!seen.has(node)) seen.set(node, shown(node));
    return seen.get(node);
  };
  let out = "";
  // Visible characters read so far: the walk stops once the cut is reached, so a long subtree is not read in full.
  let kept = 0;
  const add = (text) => {
    out += text;
    kept += text.replace(/\s+/g, "").length;
  };
  const walk = (node) => {
    if (kept >= limit) return;
    if (node.nodeType === 3) {
      if (visible(node.parentElement ?? el)) add(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(tagOf(node)))
      return;
    if (node.localName === "time" && node.hasAttribute("datetime")) {
      if (visible(node)) add(` ${node.getAttribute("datetime")} `);
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(el);
  return capText(norm(out), limit);
}

/**
 * A key as the checks compare it: all whitespace removed, so markup formatting never makes two keys of one. The same
 * as keyMatch in lib/checks.mjs, under another name: a check module that imports keyMatch would have that import
 * rewritten inside its in-page functions by a bundler or test runner (Vite), so in-page code calls this one.
 */
function matchKeyInPage(key) {
  return String(key ?? "").replace(/\s+/g, "");
}

/** The element's text as a reader sees it (keyText, uncut). */
function textOf(el) {
  return keyText(el, Infinity);
}

/**
 * "TAG:text": the text a reader sees (keyText), cut after 80 visible characters; the accessible name stands in for
 * elements without text, such as an image. Compare keys with keyMatch.
 */
function textKey(el) {
  const text = keyText(el) || capText(accName(el));
  return `${tagOf(el)}:${text}`;
}

/**
 * The fixed, sticky or dialog layer `el` sits in (itself or an ancestor), as a selector, or null. Such a layer covers
 * the page by design, so the checks that compare page content with what sits under it leave it to presence-by-route.
 */
function layerOf(el) {
  for (
    let n = el;
    n && n.nodeType === 1 && n !== document.body;
    n = n.parentElement
  ) {
    const role = n.getAttribute("role");
    if (
      tagOf(n) === "DIALOG" ||
      role === "dialog" ||
      role === "alertdialog" ||
      n.getAttribute("aria-modal") === "true"
    )
      return selectorOf(n);
    const position = getComputedStyle(n).position;
    if (position === "fixed" || position === "sticky") return selectorOf(n);
  }
  return null;
}

/**
 * A selector that finds the element again on a reload of the same page: an id where there is one, otherwise the
 * tag path with :nth-of-type only where siblings share the tag. Class names are left out: they are hashed.
 */
function selectorOf(el) {
  const parts = [];
  for (
    let node = el;
    node && node.nodeType === 1 && node !== document.documentElement;
    node = node.parentElement
  ) {
    if (
      node.id &&
      document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1
    ) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    const tag = String(node.localName);
    const parent = node.parentElement;
    const same = parent
      ? [...parent.children].filter((c) => c.localName === node.localName)
      : [];
    parts.unshift(
      same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag,
    );
  }
  return parts.length ? `html > ${parts.join(" > ")}` : "html";
}

/** The element's position in the tree as "0.2.1" (child indexes from <html>), so ancestry is a prefix test. */
function pathOf(el) {
  const parts = [];
  for (let node = el; node && node.parentElement; node = node.parentElement)
    parts.unshift([...node.parentElement.children].indexOf(node));
  return parts.join(".");
}

/** A rect as plain rounded numbers in page coordinates. */
function boxOf(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round((r.x + scrollX) * 10) / 10,
    y: Math.round((r.y + scrollY) * 10) / 10,
    width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10,
  };
}

/** True when the element sits inside an element matching one of the mask selectors (a documented dynamic region). */
function isMasked(el, masks) {
  for (const selector of masks ?? []) {
    try {
      if (el.closest(selector)) return true;
    } catch {
      // An invalid selector is reported by the check's argument parsing.
    }
  }
  return false;
}

/** Waits for the finite animations and transitions running now, capped. */
async function animationsDone(limit) {
  const running = document
    .getAnimations()
    .filter((a) => a.effect?.getTiming().iterations !== Infinity)
    .map((a) => a.finished.catch(() => {}));
  await Promise.race([
    Promise.all(running),
    new Promise((r) => setTimeout(r, limit ?? 3000)),
  ]);
}

/** Waits until the scroll position stops changing (smooth scrolling), capped. */
async function scrollSettled(limit) {
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const end = performance.now() + (limit ?? 3000);
  let last = `${scrollX},${scrollY}`;
  let still = 0;
  while (performance.now() < end && still < 6) {
    await frame();
    const now = `${scrollX},${scrollY}`;
    still = now === last ? still + 1 : 0;
    last = now;
  }
}

const HELPERS = [
  norm,
  isRendered,
  tagOf,
  accName,
  roleOf,
  capText,
  keyText,
  matchKeyInPage,
  textOf,
  textKey,
  selectorOf,
  pathOf,
  boxOf,
  layerOf,
  isMasked,
  animationsDone,
  scrollSettled,
]
  .map(String)
  .join("\n");

/**
 * A function declaration for CDP Runtime.callFunctionOn: runs `fn(this, arg)` on a remote object (an element found
 * through the DevTools protocol) with the helpers in scope.
 */
export function onElementSource(fn, arg) {
  return `function () {\n${HELPERS}\nreturn (${fn})(this, ${JSON.stringify(arg ?? null)});\n}`;
}

/**
 * Runs `fn(arg)` in the page with the helpers above in scope and resolves to its JSON-serializable result.
 * `fn` must be a plain function that uses only browser globals, the helpers and its argument.
 */
export function inPage(page, fn, arg) {
  return page.evaluate(
    `(async () => {\n${HELPERS}\nreturn await (${fn})(${JSON.stringify(arg ?? null)});\n})()`,
  );
}
