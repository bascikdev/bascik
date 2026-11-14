/**
 * The corporate template's components (`src/components/`): each folder holds the component's HTML, its
 * companion stylesheet or script when it has one, and the data or helper module only that component uses.
 */

import { SITE_HEADER_CSS, type TemplateFile } from "../../scaffold.js";

/**
 * The skip link's rules, taken from the default template's header so the two cannot drift: the link is clipped
 * until it has focus. They end where that stylesheet's own header rule starts.
 */
const headerRuleAt = SITE_HEADER_CSS.indexOf("\nheader {");
if (headerRuleAt < 0) {
  throw new Error(
    "SITE_HEADER_CSS no longer has a header rule after its skip link rules; update SKIP_LINK_CSS in templates/corporate/components.ts.",
  );
}
export const SKIP_LINK_CSS = SITE_HEADER_CSS.slice(0, headerRuleAt);

export const COMPONENT_FILES: TemplateFile[] = [
  [
    "src/components/bread-crumbs/bread-crumbs.html",
    `<!-- @bascik
The breadcrumb of the page it is on, such as Home / Services / Distribution. It reads the page's path at build time and takes each label from src/lib/navigation.ts. <page-intro> places it, so inner pages get it without asking.
-->
<style>
  ol { list-style: none; margin: 0 0 20px; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 8px; font-size: 0.85rem; color: var(--text-muted); }
  .trail li + li::before { content: "/"; margin-right: 8px; opacity: 0.5; }
  .trail a { color: var(--text-muted); }
  .trail a:hover { color: var(--text); opacity: 1; }
</style>
<nav aria-label="Breadcrumb" data-testid="bread-crumbs">
  <ol class="trail">
    <script data-bascik-build type="text/typescript">
      import { breadcrumb } from "./crumbs.ts";
      export default () => breadcrumb(process.env.BASCIK_PAGE_PATH);
    </script>
  </ol>
</nav>
`,
  ],
  [
    "src/components/bread-crumbs/crumbs.ts",
    `// crumbs.ts: the breadcrumb of the page being built. The trail comes from trail() in src/lib/navigation.ts, the
// same one the BreadcrumbList structured data in src/lib/seo.ts uses, so the two always agree.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { trail, type NavLink } from "../../lib/navigation.ts";

/** The list items: a link for each page above this one, then this page as text, marked as the current page. */
export function breadcrumbItems(crumbs: NavLink[]): SafeHtml {
  const last = crumbs.length - 1;
  return html\`\${crumbs.map((crumb, index) =>
    index === last
      ? html\`<li aria-current="page">\${crumb.label}</li>\`
      : html\`<li><a href="\${crumb.href}">\${crumb.label}</a></li>\`,
  )}\`;
}

/** The breadcrumb for a page path such as "/services/distribution", from BASCIK_PAGE_PATH. */
export const breadcrumb = (pagePath = "/"): SafeHtml =>
  breadcrumbItems(trail(pagePath));
`,
  ],
  [
    "src/components/call-to-action/call-to-action.html",
    `<!-- @bascik
A closing band that sends the reader to the contact page. Used at the end of the home, services and about pages.
-->
<style>
  .band { padding: 0 0 72px; }
  .panel { display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 32px; background: var(--accent-dim); border: 1px solid rgba(211, 255, 141, 0.22); border-radius: var(--r); }
  .panel h2 { margin-bottom: 4px; }
  .panel p { margin: 0; color: var(--text); }
</style>
<section class="band" aria-labelledby="heading" data-testid="call-to-action">
  <div class="container">
    <div class="panel">
      <div>
        <h2 id="heading">Have a manuscript ready?</h2>
        <p>Tell us about the book and we will reply within two working days.</p>
      </div>
      <a href="/contact" class="btn btn-primary" data-testid="call-to-action-contact">Talk to us</a>
    </div>
  </div>
</section>
`,
  ],
  [
    "src/components/client-logos/client-logos.html",
    `<!-- @bascik
A row of client names drawn as inline SVG wordmarks, from clients.ts beside this file. No image files.
-->
<style>
  .logos { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .mark { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: var(--r); fill: var(--text-muted); }
  .serif { font: italic 600 19px Georgia, 'Times New Roman', serif; }
  .wide { font: 700 15px system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; }
  .mono { font: 500 16px var(--mono); }
</style>
<ul class="logos" data-testid="client-logos">
  <script data-bascik-build-once type="text/typescript">
    import { clientLogos } from "./clients.ts";
    export default () => clientLogos();
  </script>
</ul>
`,
  ],
  [
    "src/components/client-logos/clients.ts",
    `// clients.ts: the client names on the home page, drawn as SVG wordmarks so the page loads no image files. The
// names are invented for this starter. Each wordmark is an svg element with the img role, named by aria-label, so a screen
// reader announces the client's name once.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Client {
  name: string;
  /** How the wordmark is set: a serif, a wide sans-serif, or a monospace face. */
  style: "serif" | "wide" | "mono";
}

export const CLIENTS: Client[] = [
  { name: "Velloway Press", style: "serif" },
  { name: "Tindlewood Books", style: "wide" },
  { name: "Ninth Lantern", style: "mono" },
  { name: "Saltmarrow Editions", style: "serif" },
  { name: "Quillory", style: "wide" },
  { name: "Orrery & Vane", style: "mono" },
];

// A hole cannot change a class name in part, so each style has its own tag.
function wordmark(client: Client): SafeHtml {
  const { name } = client;
  if (client.style === "serif") {
    return html\`<text class="serif" x="110" y="32" text-anchor="middle">\${name}</text>\`;
  }
  if (client.style === "wide") {
    return html\`<text class="wide" x="110" y="31" text-anchor="middle">\${name}</text>\`;
  }
  return html\`<text class="mono" x="110" y="31" text-anchor="middle">\${name}</text>\`;
}

/** One list item per client. */
export function clientLogos(clients: Client[] = CLIENTS): SafeHtml {
  return html\`\${clients.map(
    (client) =>
      html\`<li>
        <svg class="mark" viewBox="0 0 220 52" role="img" aria-label="\${client.name}">
          \${wordmark(client)}
        </svg>
      </li>\`,
  )}\`;
}
`,
  ],
  [
    "src/components/company-timeline/company-timeline.html",
    `<!-- @bascik
The company's history as an ordered list of dated milestones, from milestones.ts beside this file. Place it under an <h2>: the milestones are <h3>.
-->
<style>
  .timeline { list-style: none; margin: 0; padding: 0; max-width: 720px; border-left: 2px solid var(--border); }
  .milestone { display: flex; gap: 20px; padding: 0 0 24px 20px; }
  .milestone:last-child { padding-bottom: 0; }
  .milestone time { flex: none; width: 3.2rem; font-family: var(--mono); font-weight: 700; color: var(--accent); }
  .milestone p { margin: 0; font-size: 0.92rem; }
</style>
<ol class="timeline" data-testid="company-timeline">
  <script data-bascik-build-once type="text/typescript">
    import { timeline } from "./milestones.ts";
    export default () => timeline();
  </script>
</ol>
`,
  ],
  [
    "src/components/company-timeline/milestones.ts",
    `// milestones.ts: the company's short history on the about page, oldest first. Invented for this starter.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Milestone {
  /** A four-digit year, used as the <time> element's datetime. */
  year: string;
  title: string;
  text: string;
}

export const MILESTONES: Milestone[] = [
  {
    year: "2012",
    title: "Two editors and a kitchen table",
    text: "The company starts as an editing service for first-time novelists.",
  },
  {
    year: "2015",
    title: "Design joins editorial",
    text: "Covers and interiors move in-house, so one team sees a book through to print.",
  },
  {
    year: "2019",
    title: "Distribution to bookshops",
    text: "Wholesale terms open independent bookshops and libraries to our authors.",
  },
  {
    year: "2023",
    title: "One statement per quarter",
    text: "Royalty accounting launches and the thousandth title goes on sale.",
  },
];

/** One list item per milestone, in the order given. */
export function timeline(milestones: Milestone[] = MILESTONES): SafeHtml {
  return html\`\${milestones.map(
    (milestone) =>
      html\`<li class="milestone">
        <time datetime="\${milestone.year}">\${milestone.year}</time>
        <div>
          <h3>\${milestone.title}</h3>
          <p>\${milestone.text}</p>
        </div>
      </li>\`,
  )}\`;
}
`,
  ],
  [
    "src/components/contact-form/contact-form.css",
    `.form { max-width: 560px; }
.hint { font-size: 0.88rem; }

.field { margin-bottom: 20px; }
.field label { display: block; margin-bottom: 6px; font-size: 0.88rem; font-weight: 600; color: var(--text); }
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 10px 14px;
  background: var(--elevated);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--text);
  font: inherit;
  font-size: 0.92rem;
}
.field textarea { min-height: 140px; resize: vertical; }
.field input:focus-visible,
.field select:focus-visible,
.field textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.field input[aria-invalid="true"],
.field select[aria-invalid="true"],
.field textarea[aria-invalid="true"] { border-color: #ff9d8a; }

.error { margin: 6px 0 0; font-size: 0.85rem; color: #ff9d8a; }
.status { margin: 16px 0 0; color: var(--accent); }
.status:empty { display: none; }
`,
  ],
  [
    "src/components/contact-form/contact-form.html",
    `<!-- @bascik
The contact form: name, email, topic and message, each with a label and its own error line. Without JavaScript the browser's built-in validation checks the fields. contact-form.ts replaces that with messages beside each field and, because a new site has no backend, shows a note in place of sending: connect the form to your endpoint there. Field names ship as written, so the server receives name, email, topic and message.
-->
<form id="form" class="form" aria-labelledby="form-heading" data-testid="contact-form">
  <h2 id="form-heading">Send a message</h2>
  <p class="hint">All fields are required.</p>
  <div class="field">
    <label for="name">Name</label>
    <input type="text" id="name" name="name" autocomplete="name" required aria-describedby="name-error" data-testid="contact-form-name" />
    <p id="name-error" class="error" data-testid="contact-form-name-error" hidden></p>
  </div>
  <div class="field">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" autocomplete="email" required aria-describedby="email-error" data-testid="contact-form-email" />
    <p id="email-error" class="error" data-testid="contact-form-email-error" hidden></p>
  </div>
  <div class="field">
    <label for="topic">Topic</label>
    <select id="topic" name="topic" required aria-describedby="topic-error" data-testid="contact-form-topic">
      <option value="">Choose a topic</option>
      <option value="project">Starting a project</option>
      <option value="existing">A book we already work on</option>
      <option value="press">Press and events</option>
      <option value="other">Something else</option>
    </select>
    <p id="topic-error" class="error" data-testid="contact-form-topic-error" hidden></p>
  </div>
  <div class="field">
    <label for="message">Message</label>
    <textarea id="message" name="message" rows="6" required minlength="20" aria-describedby="message-error" data-testid="contact-form-message"></textarea>
    <p id="message-error" class="error" data-testid="contact-form-message-error" hidden></p>
  </div>
  <button type="submit" class="btn btn-primary" data-testid="contact-form-submit">Send message</button>
  <p id="status" class="status" role="status" data-testid="contact-form-status"></p>
</form>
<script src="contact-form.ts"></script>
`,
  ],
  [
    "src/components/contact-form/contact-form.ts",
    `// contact-form.ts: checks the form before it is sent and says what is wrong beside each field.
// The rules are the HTML attributes on each control (required, type="email", minlength), read through the
// browser's own validity API, so the markup stays the single place they are written.
type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface Field {
  control: Control;
  error: HTMLElement;
  /** What the field is called in a message, such as "your name". */
  noun: string;
}

const form = document.getElementById("form") as HTMLFormElement;
const status = document.getElementById("status") as HTMLElement;
const fields: Field[] = [
  {
    control: document.getElementById("name") as HTMLInputElement,
    error: document.getElementById("name-error") as HTMLElement,
    noun: "your name",
  },
  {
    control: document.getElementById("email") as HTMLInputElement,
    error: document.getElementById("email-error") as HTMLElement,
    noun: "your email address",
  },
  {
    control: document.getElementById("topic") as HTMLSelectElement,
    error: document.getElementById("topic-error") as HTMLElement,
    noun: "a topic",
  },
  {
    control: document.getElementById("message") as HTMLTextAreaElement,
    error: document.getElementById("message-error") as HTMLElement,
    noun: "a message",
  },
];

/** What is wrong with a field, or "" when it is fine. */
function problem({ control, noun }: Field): string {
  const { validity } = control;
  if (validity.valid) return "";
  if (validity.valueMissing) {
    return control instanceof HTMLSelectElement
      ? \`Choose \${noun}.\`
      : \`Enter \${noun}.\`;
  }
  if (validity.typeMismatch) {
    return "Enter an email address like name@example.com.";
  }
  if (validity.tooShort) {
    const minimum = (control as HTMLTextAreaElement).minLength;
    return \`Write at least \${minimum} characters, so we can route your message.\`;
  }
  return control.validationMessage;
}

/** Shows or clears one field's error. Returns true when the field is valid. */
function check(field: Field): boolean {
  const message = problem(field);
  field.error.textContent = message;
  field.error.hidden = message === "";
  if (message) field.control.setAttribute("aria-invalid", "true");
  else field.control.removeAttribute("aria-invalid");
  return message === "";
}

// The script takes over from the browser's validation bubbles.
form.noValidate = true;

for (const field of fields) {
  // Once a field has shown an error, re-check it as the reader fixes it.
  field.control.addEventListener("input", (): void => {
    if (field.control.hasAttribute("aria-invalid")) check(field);
  });
}

form.addEventListener("submit", (event: SubmitEvent): void => {
  event.preventDefault();
  status.textContent = "";
  const invalid = fields.filter((field) => !check(field));
  if (invalid.length > 0) {
    invalid[0].control.focus();
    return;
  }
  // Nothing receives the form yet: send new FormData(form) to your own endpoint here.
  form.reset();
  status.textContent =
    "Thanks. This starter form does not send anything yet.";
});
`,
  ],
  [
    "src/components/home-hero/home-hero.html",
    `<!-- @bascik
The home page's opening: the company's one-line promise, two ways forward, and a drawing of a bookshelf. The drawing is inline SVG, so the page loads no image.
-->
<style>
  .hero { padding: 88px 0 64px; }
  .layout { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 48px; align-items: center; }
  h1 span { color: var(--accent); }
  .lead { font-size: 1.1rem; max-width: 520px; margin-bottom: 32px; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; }
  .shelf { width: 100%; height: auto; max-width: 420px; justify-self: center; }

  @media (max-width: 760px) {
    .hero { padding: 56px 0 40px; }
    .layout { grid-template-columns: minmax(0, 1fr); gap: 32px; }
  }
</style>
<section class="hero" data-testid="home-hero">
  <div class="container layout">
    <div>
      <p class="section-label">Publishing services</p>
      <h1>Your book, <span>ready for readers</span></h1>
      <p class="lead">We edit, design, distribute and account for books by independent authors and small presses, so you can keep writing the next one.</p>
      <div class="actions">
        <a href="/contact" class="btn btn-primary" data-testid="home-hero-contact">Start a project</a>
        <a href="/services/" class="btn btn-ghost" data-testid="home-hero-services">See our services</a>
      </div>
    </div>
    <svg class="shelf" viewBox="0 0 320 220" role="img" aria-labelledby="shelf-title">
      <title id="shelf-title">Seven books of different heights standing on a shelf, one leaning against the others</title>
      <g fill="none" stroke="#d3ff8d" stroke-width="2">
        <rect x="36" y="60" width="30" height="130" rx="3" />
        <rect x="70" y="84" width="24" height="106" rx="3" />
        <rect x="98" y="44" width="36" height="146" rx="3" />
        <rect x="138" y="72" width="26" height="118" rx="3" />
        <rect x="168" y="96" width="32" height="94" rx="3" />
        <rect x="204" y="56" width="28" height="134" rx="3" />
        <rect x="238" y="74" width="26" height="118" rx="3" transform="rotate(12 251 192)" />
      </g>
      <g fill="#d3ff8d">
        <rect x="98" y="64" width="36" height="10" opacity="0.35" />
        <rect x="36" y="150" width="30" height="8" opacity="0.35" />
        <rect x="204" y="80" width="28" height="8" opacity="0.35" />
        <rect x="16" y="190" width="288" height="6" rx="3" />
      </g>
    </svg>
  </div>
</section>
`,
  ],
  [
    "src/components/key-figures/figures.ts",
    `// figures.ts: the numbers on the home page. They are sample figures: replace them with your own, and keep each
// label short enough to read at a glance.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Figure {
  value: string;
  label: string;
}

export const FIGURES: Figure[] = [
  { value: "1,240", label: "Titles published" },
  { value: "38", label: "Countries with a stocked bookshop" },
  { value: "96%", label: "Authors who return for their next book" },
  { value: "14", label: "Years in business" },
];

/** Each figure as a term and its value. The value comes first on screen; the CSS reorders them. */
export function figureList(figures: Figure[] = FIGURES): SafeHtml {
  return html\`\${figures.map(
    (figure) =>
      html\`<div class="figure">
        <dt>\${figure.label}</dt>
        <dd>\${figure.value}</dd>
      </div>\`,
  )}\`;
}
`,
  ],
  [
    "src/components/key-figures/key-figures.html",
    `<!-- @bascik
The company's key figures as a description list, from figures.ts beside this file.
-->
<style>
  .figures { margin: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; }
  .figure { display: flex; flex-direction: column-reverse; gap: 4px; padding: 20px 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
  .figure dt { font-size: 0.88rem; color: var(--text-muted); }
  .figure dd { margin: 0; font-size: 2rem; font-weight: 700; line-height: 1.1; color: var(--accent); }
</style>
<dl class="figures" data-testid="key-figures">
  <script data-bascik-build-once type="text/typescript">
    import { figureList } from "./figures.ts";
    export default () => figureList();
  </script>
</dl>
`,
  ],
  [
    "src/components/legal-text/legal-text.html",
    `<!-- @bascik
The body of a legal page, such as the privacy policy or the terms: a notice that the text is a placeholder, then the page's own headings and paragraphs in a readable column. Delete the <aside> once the page holds your own text.
@slot default - The page's text: <h2> headings and paragraphs.
-->
<style>
  .legal { padding-top: 24px; padding-bottom: 72px; }
  .notice { margin: 0 0 28px; padding: 16px 20px; background: var(--accent-dim); border: 1px solid rgba(211, 255, 141, 0.22); border-radius: var(--r); }
  .notice p { margin: 0; color: var(--text); }
</style>
<article class="container legal" data-testid="legal-text">
  <div class="prose">
    <aside class="notice" aria-label="Placeholder notice" data-testid="legal-text-notice">
      <p><strong>Placeholder.</strong> This page is sample text that came with the site. It is not a legal document. Replace it with your own text, reviewed by a lawyer, before you publish.</p>
    </aside>
    <div data-bascik-slot></div>
  </div>
</article>
`,
  ],
  [
    "src/components/news-list/news-list.html",
    `<!-- @bascik
The newsroom: a dated entry for each item in news.ts beside this file, newest first. Place it under an <h2>: the entry titles are <h3>.
-->
<style>
  .news { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; max-width: 760px; }
  .entry { padding: 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
  .entry p { margin: 0; font-size: 0.92rem; }
  .entry .meta { margin-bottom: 8px; color: var(--accent); font-size: 0.82rem; }
</style>
<ul class="news" data-testid="news-list">
  <script data-bascik-build-once type="text/typescript">
    import { newsList } from "./news.ts";
    export default () => newsList();
  </script>
</ul>
`,
  ],
  [
    "src/components/news-list/news.ts",
    `// news.ts: the newsroom entries on the news page, newest first whatever their order here. Dates stay
// YYYY-MM-DD strings and are formatted in UTC, so a build in any time zone prints the same day. The entries are
// invented for this starter.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { checked } from "../../lib/collection.ts";

export interface NewsEntry {
  /** A short id for the entry, unique in this list. */
  slug: string;
  title: string;
  /** The publication date as YYYY-MM-DD. */
  date: string;
  category: string;
  summary: string;
}

const ENTRIES: NewsEntry[] = checked<NewsEntry>(
  "news",
  "src/components/news-list/news.ts",
  [
    {
      slug: "library-distribution",
      title: "Library distribution now covers three more countries",
      date: "2026-10-06",
      category: "Company news",
      summary:
        "Titles we distribute can now be ordered by public libraries in Ireland, New Zealand and Singapore.",
    },
    {
      slug: "debut-prize-shortlist",
      title: "Two of our authors shortlisted for a debut fiction prize",
      date: "2026-08-19",
      category: "Authors",
      summary:
        "Both novels were edited and designed in-house and published within six weeks of each other.",
    },
    {
      slug: "statement-redesign",
      title: "A simpler quarterly royalty statement",
      date: "2026-05-27",
      category: "Product",
      summary:
        "The new statement puts units, returns and payments for every format on a single page.",
    },
  ],
  ["title", "date", "category", "summary"],
);

/** Throws for a date that is not a real YYYY-MM-DD day, naming the entry. */
export function assertDate(entry: Pick<NewsEntry, "slug" | "date">): void {
  const time = /^\\d{4}-\\d{2}-\\d{2}$/.test(entry.date)
    ? Date.parse(\`\${entry.date}T00:00:00Z\`)
    : NaN;
  if (
    Number.isNaN(time) ||
    new Date(time).toISOString().slice(0, 10) !== entry.date
  ) {
    throw new Error(
      \`news ("\${entry.slug}"): the date "\${entry.date}" is not a real day written as YYYY-MM-DD. Fix it in src/components/news-list/news.ts.\`,
    );
  }
}

/** The entries, newest first. */
export function sortedNews(entries: NewsEntry[] = ENTRIES): NewsEntry[] {
  entries.forEach(assertDate);
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

export const NEWS: NewsEntry[] = sortedNews();

/** "2026-10-06" gives "October 6, 2026". */
export const formatDate = (date: string): string =>
  new Date(\`\${date}T00:00:00Z\`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

/** One list item per entry. */
export function newsList(entries: NewsEntry[] = NEWS): SafeHtml {
  return html\`\${entries.map(
    (entry) =>
      html\`<li>
        <article class="entry">
          <p class="meta">
            <time datetime="\${entry.date}">\${formatDate(entry.date)}</time> · \${entry.category}
          </p>
          <h3>\${entry.title}</h3>
          <p>\${entry.summary}</p>
        </article>
      </li>\`,
  )}\`;
}
`,
  ],
  [
    "src/components/office-details/office-details.html",
    `<!-- @bascik
The office: postal address, phone and email in an <address>, and the opening hours. Every value comes from src/lib/site.ts.
-->
<style>
  .office { padding: 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
  .office address { font-style: normal; }
  .office h3 { margin-top: 8px; }
  .office p:last-child { margin-bottom: 0; }
</style>
<section class="office" aria-labelledby="office-heading" data-testid="office-details">
  <h2 id="office-heading">Our office</h2>
  <script data-bascik-build-once type="text/typescript">
    import { officeDetails } from "./office.ts";
    export default () => officeDetails();
  </script>
</section>
`,
  ],
  [
    "src/components/office-details/office.ts",
    `// office.ts: the office's address, phone, email and hours, printed from src/lib/site.ts, where each is written
// once. The <address> element is HTML's element for the contact details of the page's owner.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { SITE } from "../../lib/site.ts";

/** The postal address, phone and email inside one <address>, then the opening hours. */
export function officeDetails(site = SITE): SafeHtml {
  const { address, phone, email } = site;
  const mailto = \`mailto:\${email}\`;
  return html\`<address>
      <p>
        \${site.name}<br />
        \${address.street}<br />
        \${address.city}, \${address.region} \${address.postalCode}<br />
        \${address.country}
      </p>
      <p>
        <a href="\${phone.href}" data-testid="office-details-phone">\${phone.display}</a><br />
        <a href="\${mailto}" data-testid="office-details-email">\${email}</a>
      </p>
    </address>
    <h3>Hours</h3>
    <p>\${site.hours}</p>\`;
}
`,
  ],
  [
    "src/components/page-intro/page-intro.html",
    `<!-- @bascik
The top of an inner page: its breadcrumb, its one top-level heading, and an intro line.
@prop title - The page's heading.
@prop text - One or two sentences under the heading.
-->
<style>
  .intro { padding: 48px 0 8px; }
  .lead { max-width: 640px; margin-bottom: 0; font-size: 1.05rem; }
</style>
<header class="intro" data-testid="page-intro">
  <div class="container">
    <bread-crumbs />
    <h1 data-bascik-prop-title>Page title</h1>
    <p class="lead" data-bascik-prop-text></p>
  </div>
</header>
`,
  ],
  [
    "src/components/page-section/page-section.html",
    `<!-- @bascik
One section of a page: a label, a heading, an intro line, and whatever the page puts inside. The section is named by its heading for assistive technology.
@prop label - A word or two above the heading, such as "Services".
@prop title - The section's heading.
@prop text - One sentence under the heading.
@slot default - The section's content, usually one component.
-->
<style>
  .head { max-width: 640px; margin-bottom: 28px; }
  .head p:last-child { margin-bottom: 0; }
</style>
<section class="section" aria-labelledby="title" data-testid="page-section">
  <div class="container">
    <header class="head">
      <p class="section-label" data-bascik-prop-label>Section</p>
      <h2 id="title" data-bascik-prop-title>Heading</h2>
      <p data-bascik-prop-text></p>
    </header>
    <div data-bascik-slot></div>
  </div>
</section>
`,
  ],
  [
    "src/components/role-list/role-list.html",
    `<!-- @bascik
The open roles, from roles.ts beside this file: a title, the team, the location and the type of contract, with a link that starts an email application. Place it under an <h2>: the titles are <h3>.
-->
<style>
  .roles { list-style: none; margin: 0; padding: 0; display: grid; gap: 16px; }
  .role { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; padding: 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
  .role > div { flex: 1 1 320px; }
  .role p { margin: 0; font-size: 0.92rem; }
  .role .facts { margin-bottom: 8px; color: var(--accent); font-size: 0.82rem; }
  .empty { color: var(--text-muted); }
</style>
<ul class="roles" data-testid="role-list">
  <script data-bascik-build-once type="text/typescript">
    import { roleList } from "./roles.ts";
    export default () => roleList();
  </script>
</ul>
`,
  ],
  [
    "src/components/role-list/roles.ts",
    `// roles.ts: the open roles on the careers page. Add, edit or remove entries here. An empty list prints a line
// saying there are no openings. The roles are invented for this starter.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { checked } from "../../lib/collection.ts";
import { SITE } from "../../lib/site.ts";

export interface Role {
  /** A short id for the role, unique in this list. */
  slug: string;
  title: string;
  team: string;
  location: string;
  /** Such as "Full-time" or "Contract, 6 months". */
  type: string;
  summary: string;
}

export const ROLES: Role[] = checked<Role>(
  "roles",
  "src/components/role-list/roles.ts",
  [
    {
      slug: "senior-fiction-editor",
      title: "Senior fiction editor",
      team: "Editorial",
      location: "Portland or remote (US)",
      type: "Full-time",
      summary:
        "Lead developmental edits on eight to ten novels a year and mentor two associate editors.",
    },
    {
      slug: "production-designer",
      title: "Production designer",
      team: "Design",
      location: "Portland",
      type: "Full-time",
      summary:
        "Typeset interiors for print and e-book, and keep our templates and print specifications current.",
    },
    {
      slug: "royalties-analyst",
      title: "Royalties analyst",
      team: "Royalties and distribution",
      location: "Remote (US or Canada)",
      type: "Contract, 6 months",
      summary:
        "Reconcile quarterly sales reports and help move our statements to a new format.",
    },
  ],
  ["title", "team", "location", "type", "summary"],
);

/** A mailto: link with the role in the subject line, so applications arrive sorted. */
export const applyHref = (role: Role, email = SITE.email): string =>
  \`mailto:\${email}?subject=\${encodeURIComponent(\`Application: \${role.title}\`)}\`;

function roleItem(role: Role): SafeHtml {
  const href = applyHref(role);
  return html\`<li class="role">
    <div>
      <h3>\${role.title}</h3>
      <p class="facts">\${role.team} · \${role.location} · \${role.type}</p>
      <p>\${role.summary}</p>
    </div>
    <a class="btn btn-ghost" href="\${href}" data-testid="role-list-apply">
      Apply<span class="visually-hidden"> for \${role.title}</span>
    </a>
  </li>\`;
}

/** One list item per open role, or one line when there are none. */
export function roleList(roles: Role[] = ROLES): SafeHtml {
  if (roles.length === 0) {
    return html\`<li class="empty">
      There are no open roles right now. Send a note to
      <a href="/contact">our team</a> and we will keep it on file.
    </li>\`;
  }
  return html\`\${roles.map(roleItem)}\`;
}
`,
  ],
  [
    "src/components/service-detail/detail.ts",
    `// detail.ts: the body of one service's page. src/pages/services/[slug].html makes a page per service and hands
// each its entry as route data; <service-detail> reads it from BASCIK_ROUTE and prints it here. The returned
// markup uses <page-intro>, which Bascik renders like any tag written in a page.
import { html, type SafeHtml } from "@bascik/bascik/html";
import type { Service } from "../../lib/services.ts";

/** The service handed to the page being built, from the BASCIK_ROUTE variable. Throws when there is none. */
export function routeService(route = process.env.BASCIK_ROUTE): Service {
  const { data } = JSON.parse(route || "{}") as { data?: Service };
  if (!data?.slug) {
    throw new Error(
      "<service-detail> found no service in BASCIK_ROUTE. Use it only in src/pages/services/[slug].html, whose routes script passes each service as data.",
    );
  }
  return data;
}

/** The intro, what is included, how it works and the turnaround of one service. */
export function serviceDetail(service: Service): SafeHtml {
  return html\`<page-intro
      data-bascik-prop-title="\${service.name}"
      data-bascik-prop-text="\${service.summary}"
    ></page-intro>
    <div class="container">
      <div class="body">
        <p>\${service.description}</p>
        <h2>What is included</h2>
        <ul>
          \${service.includes.map((item) => html\`<li>\${item}</li>\`)}
        </ul>
        <h2>How it works</h2>
        <ol class="steps">
          \${service.steps.map(
            (step) => html\`<li><strong>\${step.title}.</strong> \${step.text}</li>\`,
          )}
        </ol>
        <h2>Turnaround</h2>
        <p>\${service.turnaround}</p>
      </div>
    </div>\`;
}
`,
  ],
  [
    "src/components/service-detail/service-detail.html",
    `<!-- @bascik
One service's page content: its name and summary, what is included, how it works and the turnaround. It reads the service from the route data, so it belongs only in src/pages/services/[slug].html.
-->
<style>
  .body { max-width: 720px; padding-bottom: 56px; }
  .body h2 { margin-top: 32px; }
  .body ul,
  .body ol { color: var(--text-muted); padding-left: 20px; }
  .body li { margin-bottom: 6px; }
  .steps strong { color: var(--text); }
</style>
<article data-testid="service-detail">
  <script data-bascik-build type="text/typescript">
    import { routeService, serviceDetail } from "./detail.ts";
    export default () => serviceDetail(routeService());
  </script>
</article>
`,
  ],
  [
    "src/components/service-list/cards.ts",
    `// cards.ts: one card per service, printed at build time from src/lib/services.ts. html escapes each value for
// where it lands.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { SERVICES, servicePath, type Service } from "../../lib/services.ts";

function serviceCard(service: Service): SafeHtml {
  const href = servicePath(service);
  return html\`<li class="card service">
    <h3>\${service.name}</h3>
    <p>\${service.summary}</p>
    <a class="more" href="\${href}" data-testid="service-list-link">
      Learn more<span class="visually-hidden"> about \${service.name}</span>
    </a>
  </li>\`;
}

/** The cards for every service, in the order of the data. */
export function serviceCards(services: Service[] = SERVICES): SafeHtml {
  return html\`\${services.map(serviceCard)}\`;
}
`,
  ],
  [
    "src/components/service-list/service-list.html",
    `<!-- @bascik
A grid of cards, one per service in src/lib/services.ts, each linking to that service's page. Place it under an <h2>: the cards are <h3>.
-->
<style>
  .grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; }
  .service { display: flex; flex-direction: column; gap: 8px; }
  .service p { flex: 1; font-size: 0.92rem; }
  .more { font-size: 0.9rem; font-weight: 600; }
</style>
<ul class="grid" data-testid="service-list">
  <script data-bascik-build-once type="text/typescript">
    import { serviceCards } from "./cards.ts";
    export default () => serviceCards();
  </script>
</ul>
`,
  ],
  [
    "src/components/site-footer/footer-nav.ts",
    `// footer-nav.ts: the footer's link columns and contact line, printed at build time from FOOTER_GROUPS in
// src/lib/navigation.ts and the company facts in src/lib/site.ts.
import { html, type SafeHtml } from "@bascik/bascik/html";
import { FOOTER_GROUPS, type FooterGroup } from "../../lib/navigation.ts";
import { SITE } from "../../lib/site.ts";

/** One column per group: a heading and its links. */
export function footerColumns(groups: FooterGroup[] = FOOTER_GROUPS): SafeHtml {
  return html\`\${groups.map(
    (group) =>
      html\`<div class="column">
        <h2>\${group.heading}</h2>
        <ul>
          \${group.links.map(
            (link) => html\`<li><a href="\${link.href}">\${link.label}</a></li>\`,
          )}
        </ul>
      </div>\`,
  )}\`;
}

/** The company name, what it does, and how to reach it. */
export function footerAbout(site = SITE): SafeHtml {
  const mailto = \`mailto:\${site.email}\`;
  return html\`<p class="name">\${site.name}</p>
    <p>\${site.tagline}</p>
    <p>
      <a href="\${mailto}">\${site.email}</a><br />
      <a href="\${site.phone.href}">\${site.phone.display}</a>
    </p>\`;
}

/** The copyright line. The year is the year of the build. */
export function legalLine(site = SITE, year = new Date().getFullYear()): SafeHtml {
  return html\`&copy; \${year} \${site.name}. All rights reserved.\`;
}
`,
  ],
  [
    "src/components/site-footer/site-footer.html",
    `<!-- @bascik
The site footer: the company's name and contact line, link columns grouped under headings, and a legal line with the year of the build. The links come from src/lib/navigation.ts and the company facts from src/lib/site.ts, so the footer ships no JavaScript.
-->
<style>
  .footer { margin-top: 24px; padding: 48px 0 28px; border-top: 1px solid var(--border); font-size: 0.9rem; }
  .layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 40px; }
  .about p { margin-bottom: 8px; }
  .about .name { font-weight: 700; color: var(--text); }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 24px; }
  .column h2 { font-size: 0.72rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text); margin-bottom: 10px; }
  .column ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .footer a { color: var(--text-muted); text-decoration: none; }
  .footer a:hover { color: var(--text); opacity: 1; }
  .legal { margin: 36px 0 0; padding-top: 20px; border-top: 1px solid var(--border); font-size: 0.82rem; }

  @media (max-width: 760px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
  }
</style>
<footer class="footer" data-testid="site-footer">
  <div class="container">
    <div class="layout">
      <div class="about">
        <script data-bascik-build-once type="text/typescript">
          import { footerAbout } from "./footer-nav.ts";
          export default () => footerAbout();
        </script>
      </div>
      <nav class="columns" aria-label="Footer" data-testid="site-footer-nav">
        <script data-bascik-build-once type="text/typescript">
          import { footerColumns } from "./footer-nav.ts";
          export default () => footerColumns();
        </script>
      </nav>
    </div>
    <p class="legal" data-testid="site-footer-legal">
      <script data-bascik-build-once type="text/typescript">
        import { legalLine } from "./footer-nav.ts";
        export default () => legalLine();
      </script>
    </p>
  </div>
</footer>
`,
  ],
  [
    "src/components/site-head/site-head.html",
    `<!-- @bascik
The head tags every page shares: charset, viewport, icons and the global stylesheet. Put it first in <head>, then the page's own tags, which pageHead() in src/lib/seo.ts writes.
-->
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="icon" href="/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg" />
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />
<link rel="stylesheet" href="/css/styles.css" />
`,
  ],
  [
    "src/components/site-header/primary-nav.ts",
    `// primary-nav.ts: the header's menu, printed at build time from PRIMARY_NAV in src/lib/navigation.ts. The current
// page is marked with aria-current, so no script is needed to highlight it. An entry with children gets a button
// and a nested list; site-header.ts turns that pair into a menu, and without JavaScript the list is plain links.
import { html, type SafeHtml } from "@bascik/bascik/html";
import {
  PRIMARY_NAV,
  currentState,
  type NavItem,
  type NavLink,
} from "../../lib/navigation.ts";

/** One link. A hole cannot add an attribute, so the tag is written twice and code picks one. */
function navLink(link: NavLink, pagePath: string): SafeHtml {
  const current = currentState(link.href, pagePath);
  return current
    ? html\`<a href="\${link.href}" aria-current="\${current}">\${link.label}</a>\`
    : html\`<a href="\${link.href}">\${link.label}</a>\`;
}

function navItem(item: NavItem, pagePath: string): SafeHtml {
  if (!item.children?.length) {
    return html\`<li>\${navLink(item, pagePath)}</li>\`;
  }
  const label = \`\${item.label} menu\`;
  return html\`<li class="group">
    \${navLink(item, pagePath)}
    <button
      type="button"
      class="caret"
      aria-expanded="false"
      aria-label="\${label}"
      data-testid="site-header-submenu-toggle"
      hidden
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
    </button>
    <ul class="submenu" data-testid="site-header-submenu">
      \${item.children.map((child) => html\`<li>\${navLink(child, pagePath)}</li>\`)}
    </ul>
  </li>\`;
}

/** The menu's items for the page being built. \`pagePath\` comes from BASCIK_PAGE_PATH. */
export function primaryNav(pagePath = "/", items = PRIMARY_NAV): SafeHtml {
  return html\`\${items.map((item) => navItem(item, pagePath))}\`;
}
`,
  ],
  [
    "src/components/site-header/site-header.css",
    `${SKIP_LINK_CSS}
.bar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: rgba(24, 25, 27, 0.92);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
}

nav {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-height: 60px;
  gap: 8px 24px;
}

.logo {
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.01em;
  margin-right: auto;
}

.menu {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.menu a {
  display: block;
  padding: 6px 12px;
  font-size: 0.9rem;
  color: var(--text-muted);
  text-decoration: none;
  border-radius: var(--r-sm);
}
.menu a:hover,
.menu a[aria-current] { color: var(--text); background: var(--elevated); opacity: 1; }
.menu a[aria-current="page"] { color: var(--accent); }

.group { position: relative; display: flex; align-items: center; }

.caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
.caret[hidden] { display: none; }
.caret[aria-expanded="true"] { color: var(--accent); background: var(--elevated); }
.caret[aria-expanded="true"] svg { transform: rotate(180deg); }

/* The services menu. Closed means display: none, which also takes its links out of the Tab order. */
.submenu {
  list-style: none;
  margin: 0;
  padding: 8px;
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 240px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
}
.submenu[data-state="open"] { display: block; }
/* Without JavaScript there is no button: pointing at the group or tabbing into it shows the links. */
.bar:not(.enhanced) .group:hover .submenu,
.bar:not(.enhanced) .group:focus-within .submenu { display: block; }

.toggle {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 36px;
  height: 36px;
  padding: 6px;
  border: none;
  border-radius: var(--r-sm);
  background: none;
  cursor: pointer;
}
.toggle span { display: block; height: 2px; background: var(--text); border-radius: 2px; }

@media (max-width: 760px) {
  .toggle:not([hidden]) { display: flex; }

  /* One column, full width. Without JavaScript it is always shown, services included. */
  .menu { flex-basis: 100%; flex-direction: column; align-items: stretch; gap: 0; padding-bottom: 8px; }
  .bar.enhanced .menu { display: none; }
  .bar.enhanced .menu[data-state="open"] { display: flex; }
  .menu a { padding: 10px 4px; }

  .group { flex-wrap: wrap; }
  .group > a { flex: 1; }
  .submenu,
  .bar:not(.enhanced) .submenu {
    display: block;
    position: static;
    flex-basis: 100%;
    min-width: 0;
    padding: 0 0 0 16px;
    border: none;
    box-shadow: none;
    background: none;
  }
  .bar.enhanced .submenu { display: none; }
  .bar.enhanced .submenu[data-state="open"] { display: block; }
}
`,
  ],
  [
    "src/components/site-header/site-header.html",
    `<!-- @bascik
The site header: a skip link, the company name and the main navigation, with one menu for the services. The links come from src/lib/navigation.ts. Without JavaScript every link, the services included, is a plain link; site-header.ts adds the menu button, the arrow keys and the phone-width toggle. Every page needs <main id="main"> for the skip link.
-->
<header id="site-header" class="bar" data-testid="site-header">
  <a href="#main" class="skip-link" data-testid="site-header-skip-link">Skip to content</a>
  <div class="container">
    <nav aria-label="Main" data-testid="site-header-nav">
      <a href="/" class="logo" data-testid="site-header-logo">
        <script data-bascik-build-once type="text/typescript">
          import { html } from "@bascik/bascik/html";
          import { SITE } from "@/lib/site.ts";
          export default () => html\`\${SITE.name}\`;
        </script>
      </a>
      <button id="nav-toggle" type="button" class="toggle" aria-label="Toggle menu" aria-controls="nav-menu" aria-expanded="false" data-testid="site-header-nav-toggle" hidden>
        <span></span><span></span><span></span>
      </button>
      <ul id="nav-menu" class="menu" data-testid="site-header-nav-menu">
        <script data-bascik-build type="text/typescript">
          import { primaryNav } from "./primary-nav.ts";
          export default () => primaryNav(process.env.BASCIK_PAGE_PATH);
        </script>
      </ul>
    </nav>
  </div>
</header>
<script src="site-header.ts"></script>
`,
  ],
  [
    "src/components/site-header/site-header.ts",
    `// site-header.ts: the header's behavior. The markup works as plain links without it. With it:
//   - each menu button opens and closes the list after it (click, Enter or Space);
//   - Arrow Down opens the menu and moves through its links, Arrow Up moves back, Home and End jump;
//   - Escape closes the menu and returns focus to its button; so does moving focus or clicking elsewhere;
//   - at phone width the toggle button shows and hides the whole menu.
// State lives in aria-expanded and data-state, which the CSS reads.
const header = document.getElementById("site-header") as HTMLElement;
const toggle = document.getElementById("nav-toggle") as HTMLButtonElement;
const menu = document.getElementById("nav-menu") as HTMLUListElement;
const carets: HTMLButtonElement[] = Array.from(menu.querySelectorAll("button"));

const submenuOf = (caret: HTMLButtonElement): HTMLElement =>
  caret.nextElementSibling as HTMLElement;

const isOpen = (button: HTMLButtonElement): boolean =>
  button.getAttribute("aria-expanded") === "true";

function setSubmenu(caret: HTMLButtonElement, open: boolean): void {
  caret.setAttribute("aria-expanded", String(open));
  submenuOf(caret).setAttribute("data-state", open ? "open" : "closed");
}

function setMenu(open: boolean): void {
  toggle.setAttribute("aria-expanded", String(open));
  menu.setAttribute("data-state", open ? "open" : "closed");
}

for (const caret of carets) {
  const group = caret.parentElement as HTMLElement;
  const links = (): HTMLAnchorElement[] =>
    Array.from(submenuOf(caret).querySelectorAll("a"));

  caret.addEventListener("click", (): void => setSubmenu(caret, !isOpen(caret)));

  group.addEventListener("keydown", (event: KeyboardEvent): void => {
    const items = links();
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    const onCaret = document.activeElement === caret;
    if (event.key === "Escape" && isOpen(caret)) {
      setSubmenu(caret, false);
      caret.focus();
    } else if (event.key === "ArrowDown" && (onCaret || index >= 0)) {
      event.preventDefault();
      setSubmenu(caret, true);
      items[(index + 1) % items.length].focus();
    } else if (event.key === "ArrowUp" && index >= 0) {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length].focus();
    } else if (event.key === "Home" && index >= 0) {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End" && index >= 0) {
      event.preventDefault();
      items[items.length - 1].focus();
    }
  });

  group.addEventListener("focusout", (event: FocusEvent): void => {
    if (!group.contains(event.relatedTarget as Node | null)) {
      setSubmenu(caret, false);
    }
  });

  setSubmenu(caret, false);
  caret.hidden = false;
}

document.addEventListener("click", (event: MouseEvent): void => {
  for (const caret of carets) {
    if (!caret.parentElement!.contains(event.target as Node)) {
      setSubmenu(caret, false);
    }
  }
});

toggle.addEventListener("click", (): void => setMenu(!isOpen(toggle)));
setMenu(false);
toggle.hidden = false;
// From here the CSS hides closed menus; before this line every link is visible.
header.classList.add("enhanced");
`,
  ],
  [
    "src/components/team-list/team-list.html",
    `<!-- @bascik
The leadership team: a name, a role and a short biography for each person in team.ts beside this file. Place it under an <h2>: the names are <h3>.
-->
<style>
  .team { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
  .member { display: flex; gap: 16px; padding: 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
  .avatar { flex: none; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); font-weight: 700; }
  .member h3 { margin-bottom: 0; }
  .member p { margin: 0; font-size: 0.9rem; }
  .member .role { margin-bottom: 8px; color: var(--accent); font-size: 0.82rem; }
</style>
<ul class="team" data-testid="team-list">
  <script data-bascik-build-once type="text/typescript">
    import { teamList } from "./team.ts";
    export default () => teamList();
  </script>
</ul>
`,
  ],
  [
    "src/components/team-list/team.ts",
    `// team.ts: the leadership team on the about page. The people are invented for this starter. Each card shows the
// person's initials in a circle drawn with CSS, so there are no portrait files to load.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface TeamMember {
  name: string;
  role: string;
  bio: string;
}

export const TEAM: TeamMember[] = [
  {
    name: "Margit Oyelaran",
    role: "Managing director",
    bio: "Founded the company after twelve years as an acquiring editor. Still reads every sample chapter that comes in.",
  },
  {
    name: "Desmond Achterberg",
    role: "Head of editorial",
    bio: "Leads a team of nine editors across fiction, memoir and narrative nonfiction.",
  },
  {
    name: "Lucia Ferreira-Nakamura",
    role: "Design director",
    bio: "Has designed more than three hundred covers and can name the typeface on any of them.",
  },
  {
    name: "Bram Solheim",
    role: "Head of royalties and distribution",
    bio: "A former bookshop buyer who built the statement authors now receive each quarter.",
  },
];

/** "Margit Oyelaran" gives "MO": the first letter of the first and last names. */
export function initials(name: string): string {
  const words = name.trim().split(/\\s+/).filter(Boolean);
  const letters = [words[0], words.length > 1 ? words[words.length - 1] : ""];
  return letters.map((word) => word?.[0] ?? "").join("").toUpperCase();
}

/** One list item per person. The initials are decoration: the name is right beside them. */
export function teamList(team: TeamMember[] = TEAM): SafeHtml {
  return html\`\${team.map(
    (member) =>
      html\`<li class="member">
        <span class="avatar" aria-hidden="true">\${initials(member.name)}</span>
        <div>
          <h3>\${member.name}</h3>
          <p class="role">\${member.role}</p>
          <p>\${member.bio}</p>
        </div>
      </li>\`,
  )}\`;
}
`,
  ],
  [
    "src/components/testimonial-list/testimonial-list.html",
    `<!-- @bascik
Quotes from authors, each a <figure> with a <blockquote> and a <figcaption>, from testimonials.ts beside this file.
-->
<style>
  .quotes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
  .quote { margin: 0; height: 100%; padding: 24px; display: flex; flex-direction: column; gap: 16px; background: var(--elevated); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--r); }
  .quote blockquote { margin: 0; flex: 1; }
  .quote blockquote p { margin: 0; color: var(--text); }
  .quote figcaption { font-size: 0.88rem; color: var(--text-muted); }
</style>
<ul class="quotes" data-testid="testimonial-list">
  <script data-bascik-build-once type="text/typescript">
    import { testimonialList } from "./testimonials.ts";
    export default () => testimonialList();
  </script>
</ul>
`,
  ],
  [
    "src/components/testimonial-list/testimonials.ts",
    `// testimonials.ts: what authors say, on the home page. The people and books are invented for this starter.
// Each one is a <figure>: the quote in a <blockquote>, and who said it in the <figcaption>.
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface Testimonial {
  quote: string;
  author: string;
  /** The author's book, shown in italics after the name. */
  book: string;
}

export const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      "My editor found the real opening of the novel on page forty. The book that went to print is the one I had been trying to write.",
    author: "Imogen Vale",
    book: "Nine Winters at Hollow Quay",
  },
  {
    quote:
      "I sent a manuscript and a folder of photographs. Three weeks later I was holding a proof that looked like it belonged in a shop window.",
    author: "Tomas Okafor",
    book: "A Ferry Called Tuesday",
  },
  {
    quote:
      "Four co-authors, six stores, two currencies. The quarterly statement fits on one page and nobody has argued about it since.",
    author: "Priya Raman",
    book: "The Beekeeper's Almanac of Small Hours",
  },
];

/** One list item per testimonial. */
export function testimonialList(items: Testimonial[] = TESTIMONIALS): SafeHtml {
  return html\`\${items.map(
    (item) =>
      html\`<li>
        <figure class="quote">
          <blockquote><p>\${item.quote}</p></blockquote>
          <figcaption>\${item.author}, author of <cite>\${item.book}</cite></figcaption>
        </figure>
      </li>\`,
  )}\`;
}
`,
  ],
];
