/**
 * @module templates/portfolio/components
 *
 * The portfolio's components, each with the Vitest test written beside it in the generated project.
 *
 * The editorial masthead keeps the skip link first and clipped until focus. The footer shares the accessible
 * foundation; the site's name comes from `src/lib/site.ts` instead of a prop.
 */

import { SITE_FOOTER_CSS, SITE_META_HTML } from "../../scaffold.js";

/** The first lines every generated component test shares. */
const testHead = (
  name: string,
): string => `import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const source = (): Promise<string> =>
  readFile(
    join(process.cwd(), "src/components/${name}/${name}.html"),
    "utf8",
  );
`;

// ─── site-meta ────────────────────────────────────────────────────────────────

/**
 * The default template's head tags without its one description for every page: here each page writes its own
 * through `seo()`. Global CSS is injected by assets.inlineStyles, so do not ship a dangling stylesheet link.
 */
export const SITE_META_HTML_PORTFOLIO =
  SITE_META_HTML.split("<script")[0]
    .split("\n")
    .filter(
      (line) =>
        !line.includes('name="description"') &&
        !line.includes('rel="stylesheet"'),
    )
    .join("\n") +
  `<script type="text/typescript">
  try {
    const saved = localStorage.getItem("portfolio-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch { /* System theme remains usable when storage is unavailable. */ }
</script>
`;

export const SITE_META_TEST = `${testHead("site-meta")}
describe("site-meta component", () => {
  it("holds shared metadata and initializes theme before paint without a stylesheet request", async () => {
    const html = await source();
    expect(html).toContain('charset="UTF-8"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("favicon.ico");
    expect(html).toContain("favicon.svg");
    expect(html).toContain("apple-touch-icon.png");
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toContain("localStorage.getItem");
  });

  it("leaves the title and description to each page's seo() call", async () => {
    const html = await source();
    expect(html).not.toContain("<title");
    expect(html).not.toContain('name="description"');
  });
});
`;

// ─── site-header ──────────────────────────────────────────────────────────────

/** Editorial index: an inset rule, typographic signature, numbered links, and quiet icon controls. */
export const SITE_HEADER_HTML = `<style>
  .skip-link { position: absolute; left: 18px; top: 8px; padding: 10px; background: var(--accent); color: var(--on-accent); z-index: 200; }
  .skip-link:not(:focus) { width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  header { position: relative; padding-top: clamp(20px, 4vw, 48px); }
  .masthead { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: end; gap: 24px; padding: 18px 0; border-top: 1px solid var(--text); border-bottom: 1px solid var(--border); }
  .signature { min-width: 0; }
  .index-label { display: block; color: var(--text-muted); font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase; }
  .logo { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: clamp(1.8rem, 3vw, 2.8rem); line-height: 1.2; letter-spacing: -0.045em; color: var(--text); }
  .panel { display: contents; }
  .menu { display: flex; gap: clamp(16px, 3vw, 40px); margin: 0; padding: 0; list-style: none; }
  .menu a { display: grid; gap: 4px; min-height: 44px; color: var(--text); text-decoration: none; font-size: 0.95rem; }
  .number { color: var(--text-muted); font-size: 0.65rem; font-variant-numeric: tabular-nums; }
  .menu a:hover { color: var(--accent); }
  .controls { display: flex; gap: 8px; }
  .icon-button { display: grid; place-items: center; width: 44px; height: 44px; padding: 10px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
  .icon-button[hidden] { display: none; }
  .icon-button:hover { background: var(--elevated); border-color: var(--text); }
  .icon-button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; }
  .sun { display: none; }
  .theme[aria-pressed="true"] .sun { display: block; }
  .theme[aria-pressed="true"] .moon { display: none; }
  .toggle { display: none; }
  .toggle-icon,
  .toggle-icon::before,
  .toggle-icon::after {
    display: block;
    width: 20px;
    height: 2px;
    border-radius: 2px;
    background: var(--text);
  }
  .toggle-icon { position: relative; }
  .toggle-icon::before,
  .toggle-icon::after { content: ""; position: absolute; left: 0; }
  .toggle-icon::before { translate: 0 -6px; }
  .toggle-icon::after { translate: 0 6px; }
  .toggle[aria-expanded="true"] .toggle-icon { background: transparent; }
  .toggle[aria-expanded="true"] .toggle-icon::before { translate: 0 0; rotate: 45deg; }
  .toggle[aria-expanded="true"] .toggle-icon::after { translate: 0 0; rotate: -45deg; }
  @media (prefers-reduced-motion: no-preference) {
    .toggle-icon::before,
    .toggle-icon::after { transition: translate 150ms ease-out, rotate 150ms ease-out; }
  }
  .mobile { display: none; }
  .separator { margin: 16px 0 20px; border: 0; border-top: 1px solid var(--border); }
  .mobile-theme {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 8px 12px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.95rem;
    text-align: left;
    cursor: pointer;
  }
  .mobile-theme[hidden] { display: none; }
  .mobile-theme:hover { color: var(--text); background: var(--elevated); }
  .mobile-theme svg { flex: 0 0 18px; width: 18px; height: 18px; }
  .mobile-theme .sun { display: none; }
  .mobile-theme[data-dark="true"] .sun { display: block; }
  .mobile-theme[data-dark="true"] .moon { display: none; }
  @media (max-width: 640px) {
    .masthead { grid-template-columns: minmax(0, 1fr) auto; gap: 18px; align-items: center; }
    .controls { grid-column: 2; grid-row: 1; }
    .menu { grid-column: 1 / -1; flex-wrap: wrap; justify-content: space-between; }
    .masthead[data-enhanced="true"] .toggle { display: grid; }
    .masthead[data-enhanced="true"] .theme { display: none; }
    .masthead[data-enhanced="true"] .panel {
      display: none;
      position: fixed;
      top: var(--menu-top, 96px);
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 100;
      overflow-y: auto;
      flex-direction: column;
      padding: 20px 18px 40px;
      background: var(--bg);
    }
    .masthead[data-enhanced="true"]:has(.toggle[aria-expanded="true"]) .panel { display: flex; }
    .masthead[data-enhanced="true"] .panel .menu { flex-direction: column; flex-wrap: nowrap; }
    .masthead[data-enhanced="true"] .panel .menu a { min-height: 44px; padding: 8px 12px; }
    .masthead[data-enhanced="true"] .panel .mobile { display: block; }
  }
</style>
<header data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav id="masthead" class="masthead" aria-label="Main" data-testid="site-header-nav">
      <div class="signature">
      <span class="index-label">Practice / Index</span>
      <a href="/" class="logo" data-testid="site-header-logo"><script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { site } from "@/lib/site.ts";
        export default () => html\`\${site.name}\`;
      </script></a>
      </div>
      <div id="nav-menu" class="panel" data-testid="site-header-nav-menu">
        <ul class="menu">
          <li><a href="/work" data-testid="site-header-work"><span class="number" aria-hidden="true">01</span>Work</a></li>
          <li><a href="/about" data-testid="site-header-about"><span class="number" aria-hidden="true">02</span>About</a></li>
          <li><a href="/contact" data-testid="site-header-contact"><span class="number" aria-hidden="true">03</span>Contact</a></li>
        </ul>
        <div class="mobile">
          <hr class="separator" />
          <button id="mobile-theme" type="button" class="mobile-theme" aria-label="Switch to dark theme" data-testid="site-header-mobile-theme" hidden>
            <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z" /></svg>
            <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></svg>
            <span id="mobile-theme-label">Dark</span>
          </button>
        </div>
      </div>
      <div class="controls">
        <button id="theme-toggle" type="button" class="icon-button theme" aria-label="Dark theme" aria-pressed="false" data-testid="site-header-theme-toggle" hidden>
          <svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a8 8 0 0 1-11-11A8 8 0 1 0 20 15Z" /></svg>
          <svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" /></svg>
        </button>
        <button id="nav-toggle" type="button" class="icon-button toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle" hidden>
          <span class="toggle-icon"></span>
        </button>
      </div>
    </nav>
  </div>
</header>
<script type="text/typescript">
  const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
  const header = toggle.closest("header") as HTMLElement;
  const masthead = document.getElementById("masthead") as HTMLElement;
  const setOpen = (open: boolean): void => {
    if (open) {
      header.scrollIntoView();
      masthead.style.setProperty('--menu-top', masthead.getBoundingClientRect().bottom + 'px');
    }
    toggle.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  };
  toggle.hidden = false;
  masthead.dataset.enhanced = "true";
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  masthead.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
  matchMedia("(max-width: 640px)").addEventListener("change", () => setOpen(false));

  const theme = document.getElementById("theme-toggle") as HTMLButtonElement;
  const mobileTheme = document.getElementById("mobile-theme") as HTMLButtonElement;
  const mobileLabel = document.getElementById("mobile-theme-label") as HTMLSpanElement;
  const root = document.documentElement;
  const preference = matchMedia("(prefers-color-scheme: dark)");
  const isDark = (): boolean => root.dataset.theme ? root.dataset.theme === "dark" : preference.matches;
  const syncTheme = (): void => {
    const dark = isDark();
    theme.setAttribute("aria-pressed", String(dark));
    mobileTheme.dataset.dark = String(dark);
    mobileTheme.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
    mobileLabel.textContent = dark ? "Light" : "Dark";
  };
  const switchTheme = (): void => {
    const next = isDark() ? "light" : "dark";
    root.classList.add("theme-switching");
    root.dataset.theme = next;
    try { localStorage.setItem("portfolio-theme", next); } catch { /* Toggle still works. */ }
    syncTheme();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  };
  syncTheme();
  theme.hidden = false;
  mobileTheme.hidden = false;
  preference.addEventListener("change", syncTheme);
  theme.addEventListener("click", switchTheme);
  mobileTheme.addEventListener("click", switchTheme);
</script>
`;

export const SITE_HEADER_TEST = `${testHead("site-header")}
describe("site-header component", () => {
  it("puts the skip link first, pointing at the page's main element", async () => {
    const html = await source();
    const header = html.slice(html.indexOf("<header"));
    expect(header.search(/<a\\s/)).toBe(header.search(/<a\\s+href="#main"/));
    expect(html).toContain(".skip-link:not(:focus)");
  });

  it("links to each section and reads the site's name from src/lib/site.ts", async () => {
    const html = await source();
    for (const href of ["/", "/work", "/about", "/contact"])
      expect(html).toContain(\`href="\${href}"\`);
    expect(html).toContain('from "@/lib/site.ts"');
    expect(html).toContain("site.name");
  });

  it("has a menu toggle that says which menu it controls and whether it is open", async () => {
    const html = await source();
    expect(html).toContain('aria-controls="nav-menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('id="nav-menu"');
  });
});
`;

// ─── site-footer ──────────────────────────────────────────────────────────────

export const SITE_FOOTER_HTML = `<style>
${SITE_FOOTER_CSS}</style>
<footer data-testid="site-footer">
  <div class="container">
    <div class="inner">
      <span class="copy">
        &copy;
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { site } from "@/lib/site.ts";
          export default () => html\`\${String(new Date().getFullYear())} \${site.author}\`;
        </script>
      </span>
      <nav aria-label="Footer" data-testid="site-footer-nav">
        <a href="/work" data-testid="site-footer-work">Work</a>
        <a href="/about" data-testid="site-footer-about">About</a>
        <a href="/contact" data-testid="site-footer-contact">Contact</a>
      </nav>
    </div>
  </div>
</footer>
`;

export const SITE_FOOTER_TEST = `${testHead("site-footer")}
describe("site-footer component", () => {
  it("writes the year and the author's name once, at build time", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-build-once");
    expect(html).toContain("getFullYear");
    expect(html).toContain("site.author");
  });

  it("links to each section", async () => {
    const html = await source();
    for (const href of ["/work", "/about", "/contact"])
      expect(html).toContain(\`href="\${href}"\`);
  });
});
`;

// ─── page-intro ───────────────────────────────────────────────────────────────

/** The heading group that opens a page: a short label, the page's one `<h1>`, and a sentence under it. */
export const PAGE_INTRO_HTML = `<!-- @bascik
The heading group that opens a page.
@prop label - A word or two above the heading
@prop title - The page's one h1
@prop text - A sentence under the heading
-->
<style>
  header {
    margin-bottom: 40px;
  }
  .text {
    margin-bottom: 0;
  }
</style>
<header data-testid="page-intro">
  <p class="section-label" data-bascik-prop-label></p>
  <h1 data-bascik-prop-title></h1>
  <p class="page-intro text" data-bascik-prop-text></p>
</header>
`;

export const PAGE_INTRO_TEST = `${testHead("page-intro")}
describe("page-intro component", () => {
  it("takes a label, a title for the page's one h1, and a line of text", async () => {
    const html = await source();
    expect(html).toContain("data-bascik-prop-label");
    expect(html).toMatch(/<h1\\s+data-bascik-prop-title\\s*>/);
    expect(html).toContain("data-bascik-prop-text");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
`;

// ─── home-intro ───────────────────────────────────────────────────────────────

export const HOME_INTRO_HTML = `<style>
  .intro-layout {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(280px, 1.1fr);
    align-items: center;
    gap: clamp(40px, 8vw, 112px);
  }
  .intro-copy { max-width: 560px; }
  h1 {
    max-width: 10ch;
    margin-bottom: 20px;
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: clamp(3.2rem, 7.6vw, 6.6rem);
    font-weight: 500;
    letter-spacing: -0.07em;
    line-height: 0.98;
  }
  .tagline { max-width: 36ch; font-size: clamp(1.05rem, 1.6vw, 1.25rem); }
  .hero-art {
    position: relative;
    display: grid;
    place-items: center;
    min-height: clamp(300px, 38vw, 510px);
    margin: 0;
    overflow: hidden;
    background: #e8dfd1;
  }
  .shape { position: absolute; display: block; }
  .shape-large {
    width: 65%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: #d38669;
    transform: translate(-4%, 4%);
  }
  .shape-small {
    width: 36%;
    aspect-ratio: 0.78;
    right: 12%;
    bottom: 10%;
    background: #77876c;
    transform: rotate(12deg);
  }
  .shape-cutout {
    width: 28%;
    aspect-ratio: 1;
    top: 13%;
    left: 12%;
    border: 1px solid #514f46;
    border-radius: 50%;
  }
  figcaption {
    position: absolute;
    right: 18px;
    bottom: 16px;
    color: #24251f;
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: 0.9rem;
    font-style: italic;
  }
  @media (max-width: 760px) {
    .intro-layout { grid-template-columns: 1fr; gap: 34px; }
    .intro-copy { max-width: 620px; }
    .hero-art { min-height: 360px; }
  }
  @media (max-width: 480px) {
    .hero-art { min-height: 290px; }
  }
</style>
<section class="hero" data-testid="home-intro">
  <div class="container intro-layout">
    <div class="intro-copy">
      <script data-bascik-build-once type="text/typescript">
        import { html } from "@bascik/bascik/html";
        import { site } from "@/lib/site.ts";
        export default () =>
          html\`<p class="section-label">\${site.role}</p>
            <h1>A practice in color, shape, and story.</h1>
            <p class="tagline">\${site.tagline}</p>\`;
      </script>
      <div class="hero-actions">
        <a href="/work" class="btn btn-primary">Explore selected work</a>
        <a href="/contact" class="btn btn-ghost">Start a conversation</a>
      </div>
    </div>
    <figure class="hero-art" role="img" aria-label="An abstract composition of layered color and organic shapes" data-testid="home-intro-art">
      <span class="shape shape-large"></span>
      <span class="shape shape-small"></span>
      <span class="shape shape-cutout"></span>
      <figcaption>Ideas, made tangible.</figcaption>
    </figure>
  </div>
</section>
`;

export const HOME_INTRO_TEST = `${testHead("home-intro")}
describe("home-intro component", () => {
  it("introduces a creator with one editorial h1 and their own tagline", async () => {
    const html = await source();
    expect(html).toContain("<h1>A practice in color, shape, and story.</h1>");
    expect(html).toContain("site.tagline");
    expect(html).toContain('data-testid="home-intro-art"');
  });

  it("links to selected work and the contact page", async () => {
    const html = await source();
    expect(html).toContain('href="/work"');
    expect(html).toContain('href="/contact"');
  });
});
`;

// ─── contact-form ─────────────────────────────────────────────────────────────

/**
 * Contact form. The fields are checked by the browser's own rules (`required`, `type="email"`, `minlength`); the
 * script reports the first problem in the status line and moves focus to that field. The starter has no backend,
 * so a valid form shows a note in place of sending. Field names ship as written, so `new FormData(form)` has
 * the keys name, email and message.
 */
export const CONTACT_FORM_HTML = `<!-- @bascik
A contact form that checks its fields in the browser. Nothing receives it yet: send it to your own endpoint in
the script's submit handler.
-->
<style>
  form {
    max-width: 520px;
  }
  .field {
    margin-bottom: 20px;
  }
  label {
    display: block;
    margin-bottom: 6px;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
  }
  .input {
    width: 100%;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    background: var(--elevated);
    color: var(--text);
    font-family: inherit;
    font-size: 0.9rem;
    transition: border-color 0.15s;
  }
  .input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .input[aria-invalid="true"] {
    border-color: #ff9d8a;
  }
  textarea {
    min-height: 120px;
    resize: vertical;
  }
  .status {
    margin: 16px 0 0;
    color: var(--accent);
  }
  .status[data-state="error"] {
    color: #ff9d8a;
  }
</style>
<form id="form" data-testid="contact-form">
  <div class="field">
    <label for="name">Name</label>
    <input
      class="input"
      type="text"
      id="name"
      name="name"
      autocomplete="name"
      required
      data-testid="contact-form-name"
    />
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input
      class="input"
      type="email"
      id="email"
      name="email"
      autocomplete="email"
      required
      data-testid="contact-form-email"
    />
  </div>
  <div class="field">
    <label for="message">Message</label>
    <textarea
      class="input"
      id="message"
      name="message"
      required
      minlength="10"
      data-testid="contact-form-message"
    ></textarea>
  </div>
  <button
    type="submit"
    class="btn btn-primary"
    data-testid="contact-form-submit"
  >
    Send message
  </button>
  <p
    id="status"
    class="status"
    role="status"
    data-testid="contact-form-status"
  ></p>
</form>
<script type="text/typescript">
  type Field = HTMLInputElement | HTMLTextAreaElement;
  const form = document.getElementById("form") as HTMLFormElement;
  const status = document.getElementById("status") as HTMLParagraphElement;
  const fields: [label: string, field: Field][] = [
    ["Name", document.getElementById("name") as HTMLInputElement],
    ["Email", document.getElementById("email") as HTMLInputElement],
    ["Message", document.getElementById("message") as HTMLTextAreaElement],
  ];

  // With the script running, problems are reported in the status line. Without it, the browser's own messages are.
  form.noValidate = true;
  form.addEventListener("submit", (event: SubmitEvent): void => {
    event.preventDefault();
    for (const [, field] of fields)
      field.setAttribute("aria-invalid", String(!field.validity.valid));
    const problem = fields.find(([, field]) => !field.validity.valid);
    if (problem) {
      const [label, field] = problem;
      status.setAttribute("data-state", "error");
      status.textContent = label + ": " + field.validationMessage;
      field.focus();
      return;
    }
    // Nothing receives the form yet: send new FormData(form) to your own endpoint here.
    status.setAttribute("data-state", "sent");
    status.textContent = "Thanks! This starter form does not send anything yet.";
  });
</script>
`;

export const CONTACT_FORM_TEST = `${testHead("contact-form")}
describe("contact-form component", () => {
  it("labels every field, names it for the server, and requires it", async () => {
    const html = await source();
    const controls = html.match(/<(?:input|textarea)\\s[^>]*>/g) ?? [];
    expect(controls).toHaveLength(3);
    for (const id of ["name", "email", "message"]) {
      expect(html).toContain(\`<label for="\${id}">\`);
      const control = controls.find((tag) => tag.includes(\`id="\${id}"\`));
      expect(control, id).toContain(\`name="\${id}"\`);
      expect(control, id).toMatch(/\\srequired\\s/);
    }
  });

  it("states its rules in HTML, so they hold without the script", async () => {
    const html = await source();
    expect(html).toContain('type="email"');
    expect(html).toContain('minlength="10"');
  });

  it("reports problems in a status line from a TypeScript script", async () => {
    const html = await source();
    expect(html).toContain('role="status"');
    expect(html).toContain('<script type="text/typescript">');
    expect(html).toContain("preventDefault");
    expect(html).toContain("validationMessage");
  });
});
`;

export const PROJECT_CARD_HTML = `<style>
  article {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 18px;
    height: 100%;
  }
  .visual {
    position: relative;
    aspect-ratio: 1.28 / 1;
    overflow: hidden;
    background: #eee2d5;
    isolation: isolate;
  }
  .visual::before {
    content: "";
    position: absolute;
    width: 72%;
    aspect-ratio: 1;
    top: 8%;
    left: 18%;
    border-radius: 50%;
    background: rgb(255 255 255 / 28%);
  }
  .visual::after {
    content: "";
    position: absolute;
    inset: 12% 13%;
    border: 1px solid rgb(36 37 31 / 40%);
    transform: rotate(-7deg);
  }
  .visual[data-accent="clay"] { background: #e7c2ac; }
  .visual[data-accent="sage"] { background: #c4cbb6; }
  .visual[data-accent="blue"] { background: #b7c8d2; }
  .visual[data-accent="citrus"] { background: #e8d59b; }
  .visual[data-accent="lilac"] { background: #d3c7d8; }
  .visual[data-accent="ink"] { background: #afb7ab; }
  .shape {
    position: absolute;
    z-index: 1;
    display: block;
    width: 42%;
    aspect-ratio: 0.78;
    left: 16%;
    bottom: 0;
    background: #b64f3c;
    clip-path: polygon(0 10%, 100% 0, 88% 100%, 8% 86%);
  }
  .shape-alt {
    width: 28%;
    aspect-ratio: 1;
    left: auto;
    right: 12%;
    bottom: 18%;
    border-radius: 50%;
    background: #77876c;
  }
  .visual[data-accent="sage"] .shape { background: #51674b; }
  .visual[data-accent="blue"] .shape { background: #344f67; }
  .visual[data-accent="citrus"] .shape { background: #a74d38; }
  .visual[data-accent="lilac"] .shape { background: #6a587b; }
  .visual[data-accent="ink"] .shape { background: #273b37; }
  .visual[data-accent="clay"] .shape-alt { background: #eddfc9; }
  .visual[data-accent="blue"] .shape-alt { background: #e6d9c8; }
  h3 { margin: 0 0 6px; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: 1.45rem; font-weight: 500; }
  a { color: var(--text); text-decoration: none; }
  a::after { content: ""; position: absolute; inset: 0; }
  .meta { margin: 0 0 5px; font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
  .summary { max-width: 46ch; margin: 0; font-size: .9rem; }
</style>
<article data-testid="project-card">
  <div class="visual" data-bascik-attr-data-accent="accent" aria-hidden="true">
    <span class="shape"></span><span class="shape shape-alt"></span>
  </div>
  <div>
    <p class="meta" data-bascik-prop-meta></p>
    <h3><a data-bascik-attr-href="href" data-bascik-prop-title data-testid="project-card-link"></a></h3>
    <p class="summary" data-bascik-prop-summary></p>
  </div>
</article>
`;

export const PROJECT_CARD_TEST = `${testHead("project-card")}
describe("project-card component", () => {
  it("is an article linking to a project with an original art-directed visual", async () => {
    const html = await source();
    expect(html).toContain('<article data-testid="project-card">');
    expect(html).toContain('data-bascik-attr-href="href"');
    expect(html).toContain('class="visual"');
    expect(html).toContain('<span class="shape"></span>');
  });
});
`;

export const PROJECT_LIST_HTML = `<section data-testid="project-list">
  <h2>All selected work</h2>
  <script data-bascik-build-once type="text/typescript">
    import { html } from "@bascik/bascik/html";
    import { site } from "@/lib/site.ts";
    import { projectCards } from "@/lib/project-cards.ts";
    import { projects } from "@/lib/projects.ts";
    export default () => html\`<p>\${site.sampleWork}</p>\${projectCards(projects)}\`;
  </script>
</section>
`;

export const PROJECT_LIST_TEST = `${testHead("project-list")}
describe("project-list component", () => {
  it("lists every project under an h2", async () => {
    const html = await source();
    expect(html).toContain("<h2>All selected work</h2>");
    expect(html).toContain("projectCards(projects)");
  });
});
`;

export const FEATURED_PROJECTS_HTML = `<section class="section" data-testid="featured-projects">
  <div class="container">
    <p class="section-label">Selected work</p>
    <h2>Selected work</h2>
    <script data-bascik-build-once type="text/typescript">
      import { html } from "@bascik/bascik/html";
      import { site } from "@/lib/site.ts";
      import { projectCards } from "@/lib/project-cards.ts";
      import { featuredProjects } from "@/lib/projects.ts";
      export default () => html\`<p>\${site.sampleWork}</p>\${projectCards(featuredProjects())}\`;
    </script>
    <p class="more"><a href="/work">See all selected work</a></p>
  </div>
</section>
`;

export const FEATURED_PROJECTS_TEST = `${testHead("featured-projects")}
describe("featured-projects component", () => {
  it("builds featured project cards and links to the full list", async () => {
    const html = await source();
    expect(html).toContain("projectCards(featuredProjects())");
    expect(html).toContain('href="/work"');
  });
});
`;

export const PROJECT_DETAIL_HTML = `<style>
  .detail { display: grid; grid-template-columns: minmax(260px, 0.9fr) minmax(0, 1.1fr); gap: clamp(36px, 7vw, 92px); align-items: start; }
  .visual { position: relative; aspect-ratio: 0.9; overflow: hidden; background: #e7c2ac; isolation: isolate; }
  .visual::before { content: ""; position: absolute; width: 74%; aspect-ratio: 1; top: 8%; left: 18%; border-radius: 50%; background: rgb(255 255 255 / 28%); }
  .visual::after { content: ""; position: absolute; inset: 12% 13%; border: 1px solid rgb(36 37 31 / 40%); transform: rotate(-7deg); }
  .visual[data-accent="sage"] { background: #c4cbb6; }
  .visual[data-accent="blue"] { background: #b7c8d2; }
  .visual[data-accent="citrus"] { background: #e8d59b; }
  .visual[data-accent="lilac"] { background: #d3c7d8; }
  .visual[data-accent="ink"] { background: #afb7ab; }
  .shape { position: absolute; z-index: 1; display: block; width: 42%; aspect-ratio: 0.78; left: 16%; bottom: 0; background: #b64f3c; clip-path: polygon(0 10%, 100% 0, 88% 100%, 8% 86%); }
  .shape-alt { width: 28%; aspect-ratio: 1; left: auto; right: 12%; bottom: 18%; border-radius: 50%; background: #77876c; }
  .visual[data-accent="sage"] .shape { background: #51674b; }
  .visual[data-accent="blue"] .shape { background: #344f67; }
  .visual[data-accent="citrus"] .shape { background: #a74d38; }
  .visual[data-accent="lilac"] .shape { background: #6a587b; }
  .visual[data-accent="ink"] .shape { background: #273b37; }
  .text { max-width: 65ch; padding-top: 8px; }
  .text h1 { max-width: 16ch; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-weight: 500; letter-spacing: -0.06em; }
  .lead { font-size: 1.16rem; color: var(--text); }
  .facts { display: flex; flex-wrap: wrap; gap: 12px 36px; margin: 32px 0 0; padding-top: 20px; border-top: 1px solid var(--border); }
  .facts dt { margin-bottom: 4px; color: var(--text-muted); font-size: .68rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  .facts dd { margin: 0; }
  .pager { grid-column: 1 / -1; display: flex; justify-content: space-between; gap: 12px 24px; padding-top: 24px; border-top: 1px solid var(--border); }
  @media (max-width: 760px) { .detail { grid-template-columns: minmax(0, 1fr); gap: 28px; } .visual { aspect-ratio: 1.25; } }
</style>
<article class="detail" data-testid="project-detail">
  <script data-bascik-build type="text/typescript">
    import { projectDetail } from "./detail.ts";
    export default () => projectDetail(JSON.parse(process.env.BASCIK_ROUTE || "{}").data);
  </script>
</article>
`;

export const PROJECT_DETAIL_TEST = `${testHead("project-detail")}
describe("project-detail component", () => {
  it("reads a project from the dynamic route", async () => {
    const html = await source();
    expect(html).toContain('data-testid="project-detail"');
    expect(html).toContain("BASCIK_ROUTE");
  });
});
`;

export const PROJECT_DETAIL_TS = `import { html, raw, type SafeHtml } from "@bascik/bascik/html";
import { projectPath, projects, type Project } from "../../lib/projects.ts";

export function projectDetail(project: Project | undefined): SafeHtml {
  if (!project?.slug) throw new Error("<project-detail> found no project in BASCIK_ROUTE.");
  const index = projects.findIndex((other) => other.slug === project.slug);
  const previous = index > 0 ? projects[index - 1] : undefined;
  const next = index >= 0 ? projects[index + 1] : undefined;
  return html\`<div class="visual" data-accent="\${project.accent}" aria-label="\${project.title} project artwork" role="img">
      <span class="shape"></span><span class="shape shape-alt"></span>
    </div>
    <div class="text">
      <p class="section-label">\${project.category}</p>
      <h1>\${project.title}</h1>
      <p>Sample project. A fictional case study, not a client commission.</p>
      <p class="lead">\${project.summary}</p>
      \${raw(String(project.html))}
      <dl class="facts">
        <div><dt>Year</dt><dd>\${String(project.year)}</dd></div>
        <div><dt>Disciplines</dt><dd>\${project.tags.join(" / ")}</dd></div>
      </dl>
    </div>
    <nav class="pager" aria-label="More projects" data-testid="project-detail-pager">
      \${previous ? html\`<a href="\${projectPath(previous)}" data-testid="project-detail-newer">Newer: \${previous.title}</a>\` : ""}
      <a href="/work" data-testid="project-detail-all">All selected work</a>
      \${next ? html\`<a href="\${projectPath(next)}" data-testid="project-detail-older">Older: \${next.title}</a>\` : ""}
    </nav>\`;
}
`;

export const CREATOR_BIO_HTML = `<style>
  section { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(220px, 0.8fr); gap: clamp(36px, 8vw, 112px); align-items: start; }
  .prose { max-width: 62ch; }
  h2 { margin-top: 36px; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: 1.8rem; font-weight: 500; }
  h2:first-child { margin-top: 0; }
  .facts { margin: 0; padding: 0; border-top: 1px solid var(--border); }
  .fact { padding: 16px 0; border-bottom: 1px solid var(--border); }
  .fact dt { font-size: .68rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
  .fact dd { margin: 5px 0 0; }
  @media (max-width: 760px) { section { grid-template-columns: 1fr; gap: 32px; } }
</style>
<section data-testid="creator-bio">
  <div class="prose">
    <p>Sample biography. Replace this example practice with your own story and availability.</p>
    <h2>Good work begins with a good question.</h2>
    <p>This is an independent creative practice for people with something to say. The work moves between identity, editorial, and image-making, with a focus on finding the detail that makes an idea feel unmistakably its own.</p>
    <h2>Made with care, and made to be used.</h2>
    <p>From the first sketch to the final file, each project is shaped around its audience, its context, and the way it will live in the world.</p>
    <p><a href="/contact">Tell me what you are making</a></p>
  </div>
  <dl class="facts">
    <div class="fact"><dt>Practice</dt><dd>Identity, editorial, art direction</dd></div>
    <div class="fact"><dt>Approach</dt><dd>Curious, collaborative, considered</dd></div>
    <div class="fact"><dt>Availability</dt><dd>Open for select projects</dd></div>
  </dl>
</section>
`;

export const CREATOR_BIO_TEST = `${testHead("creator-bio")}
describe("creator-bio component", () => {
  it("describes a creative practice under h2 headings, with a list of working details", async () => {
    const html = await source();
    expect(html).toMatch(/<section\\s[^>]*data-testid="creator-bio"/);
    expect(html).not.toContain("<h1");
    expect(html.match(/<h2>/g)!.length).toBeGreaterThan(0);
    expect(html.match(/<dt>/g)).toHaveLength(html.match(/<dd>/g)!.length);
    expect(html).toContain("identity, editorial, and image-making");
  });

  it("links to the contact page", async () => {
    expect(await source()).toContain('href="/contact"');
  });
});
`;
