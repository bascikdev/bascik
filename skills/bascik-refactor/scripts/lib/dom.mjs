// In-page helpers for the parity checks. Dependency-free; Node.js 22.18+.
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
  const own = norm(el.textContent);
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

/** "TAG:normalized text", cut at 70 characters; the name stands in for elements without text, such as an image. */
function textKey(el) {
  const text = norm(el.textContent) || accName(el);
  return `${tagOf(el)}:${text.slice(0, 70).trim()}`;
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
