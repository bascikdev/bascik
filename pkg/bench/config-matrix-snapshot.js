// Runs in the browser, not in Node: config-matrix.ts reads this file and
// passes its text to Playwright's page.evaluate(). It is JavaScript so it
// needs no DOM types in the package's Node-only TypeScript program. The
// value of the expression below is the snapshot of the page.
//
// Every element with data-probe="<name>" is described: rendered text, a set
// of computed styles, its box, and which probe each ID reference resolves
// to. Scoped names and hashed IDs never appear in the result, so builds with
// different identifier settings compare equal when they render the same.
(() => {
  const probes = Array.from(document.querySelectorAll("[data-probe]"));
  const seen = new Map();
  const keys = new Map();
  for (const el of probes) {
    const name = el.getAttribute("data-probe") ?? "";
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    keys.set(el, `${name}#${count}`);
  }
  const keyOf = (el) =>
    el ? (keys.get(el) ?? `<unprobed ${el.tagName.toLowerCase()}>`) : "<none>";
  const byId = (id) =>
    id === null ? "<absent>" : keyOf(document.getElementById(id));
  const idList = (value) =>
    value === null
      ? null
      : value
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => byId(id));
  const urlRef = (value) =>
    value.replace(
      /url\(["']?#([^"')]+)["']?\)/g,
      (_match, id) => `url(->${byId(id)})`,
    );
  const STYLE_PROPS = [
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "fontFamily",
    "display",
    "paddingTop",
    "paddingLeft",
    "marginTop",
    "marginBottom",
    "borderTopWidth",
    "borderTopColor",
    "outlineWidth",
    "outlineColor",
    "textDecorationLine",
    "textDecorationStyle",
    "gridTemplateAreas",
    "gridTemplateColumns",
    "columnGap",
    "whiteSpace",
    "stroke",
  ];
  const ARIA_ID_ATTRIBUTES = [
    "aria-describedby",
    "aria-labelledby",
    "aria-controls",
    "aria-errormessage",
    "aria-owns",
    "aria-details",
    "aria-activedescendant",
  ];
  const ID_ATTRIBUTES = ["for", "list", "form", "popovertarget", "headers"];
  const URL_ATTRIBUTES = ["fill", "clip-path", "mask", "filter", "stroke"];

  // Where a link lands, without the origin (ports differ between variants)
  // and without the base path the variant mounted the site under.
  const landing = (el, href) => {
    const resolved =
      typeof el.href === "string" ? el.href : new URL(href, location.href).href;
    const url = new URL(resolved);
    const base = window.__matrixBase ?? "/";
    const sameOrigin = url.origin === location.origin;
    const path =
      sameOrigin && url.pathname.startsWith(base)
        ? `/${url.pathname.slice(base.length)}`
        : url.pathname;
    return `${sameOrigin ? "" : url.origin}${path}${url.search}${url.hash}`;
  };

  const describe = (el) => {
    const style = getComputedStyle(el);
    const styles = {};
    for (const prop of STYLE_PROPS) styles[prop] = style[prop];
    styles.fill = urlRef(style.fill);
    styles.clipPath = urlRef(style.clipPath);
    // Names are scoped, so record that one applies, not what it is called.
    styles.animations = el.getAnimations().length;
    styles.hasContainerName =
      style.getPropertyValue("container-name") !== "none";
    const before = getComputedStyle(el, "::before");
    styles.before = `${before.content} / ${before.color}`;
    styles.placeholder = getComputedStyle(el, "::placeholder").color;

    const refs = {};
    for (const attr of [...ARIA_ID_ATTRIBUTES, ...ID_ATTRIBUTES]) {
      if (el.hasAttribute(attr)) refs[attr] = idList(el.getAttribute(attr));
    }
    for (const attr of URL_ATTRIBUTES) {
      const value = el.getAttribute(attr);
      if (value?.includes("url(")) refs[attr] = urlRef(value);
    }
    const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
    if (href !== null) {
      refs.href = href.startsWith("#")
        ? `#->${byId(href.slice(1))}`
        : landing(el, href);
    }
    if (el.tagName === "LABEL") refs.control = keyOf(el.control);
    if (el.hasAttribute("popovertarget"))
      refs.popoverTarget = keyOf(el.popoverTargetElement);
    if (el.tagName === "IMG")
      refs.imgLoaded = el.complete && el.naturalWidth > 0;

    const data = {};
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-") && attr.name !== "data-probe")
        data[attr.name] = attr.value;
    }
    const verbatim = ["PRE", "TEXTAREA", "CODE"].includes(el.tagName);
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: verbatim
        ? (el.value ?? el.textContent)
        : (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim(),
      styles,
      rect: [rect.x, rect.y, rect.width, rect.height].map(
        (n) => Math.round(n * 10) / 10,
      ),
      refs,
      data,
      name: el.getAttribute("name"),
      // Production moves body scripts to the end of <body>, so scripts and
      // styles are not counted.
      children: Array.from(el.children).filter(
        (child) => child.tagName !== "SCRIPT" && child.tagName !== "STYLE",
      ).length,
    };
  };

  const result = {};
  for (const el of probes) result[keys.get(el)] = describe(el);

  // Client script effects: click every data-probe="toggle", then record what
  // changed and whether each popover opened.
  for (const el of probes) {
    if (el.getAttribute("data-probe") === "toggle") el.click();
  }
  const afterToggle = {};
  for (const el of probes) {
    const key = keys.get(el);
    const next = describe(el);
    if (JSON.stringify(next) !== JSON.stringify(result[key]))
      afterToggle[key] = next;
    if (el.hasAttribute("popover"))
      afterToggle[`${key}:open`] = el.matches(":popover-open");
  }

  const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
  return {
    title: document.title,
    probes: result,
    afterToggle,
    fonts: Array.from(document.fonts).map(
      (font) => `${font.family}:${font.status}`,
    ),
    duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index).length,
  };
})();
