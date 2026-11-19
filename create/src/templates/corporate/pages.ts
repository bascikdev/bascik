/**
 * The corporate template's pages (`src/pages/`). Each reads as a list of component tags; the head tags come from
 * `pageHead()` in `src/lib/seo.ts`, and `services/[slug].html` makes one page per service in `src/lib/services.ts`.
 */

import type { TemplateFile } from "../../scaffold.js";

export const PAGE_FILES: TemplateFile[] = [
  [
    "src/pages/404.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <!-- Served with status 404 for unknown URLs by bascik --server, the dev server, and most static hosts.
       Bascik leaves 404 pages out of sitemap.xml. -->
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Page not found",
        description: "The page you asked for does not exist or has moved. Start again from the home page or the services.",
        noindex: true,
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="not-found-main">
    <div class="container">
      <section class="section not-found">
        <p class="not-found-code" aria-hidden="true">404</p>
        <h1>Page not found</h1>
        <p class="not-found-text">The page you asked for does not exist or has moved.</p>
        <div class="actions">
          <a href="/" class="btn btn-primary" data-testid="not-found-home">Go to the home page</a>
          <a href="/services/" class="btn btn-ghost" data-testid="not-found-services">See our services</a>
        </div>
      </section>
    </div>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/about.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "About",
        description:
          "Why we started a publishing services company for independent authors, who leads it, and how it grew from two editors to four teams.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="about-main">
    <page-intro data-bascik-prop-title="About us" data-bascik-prop-text="We are editors, designers and bookkeepers who think an independent author deserves the same care as one with a large publisher behind them." />
    <page-section data-testid="about-mission" data-bascik-prop-label="Mission" data-bascik-prop-title="Good books, well made, fairly paid" data-bascik-prop-text="Three promises we make to every author.">
      <ul class="prose">
        <li><strong>The book stays yours.</strong> You keep every right, every file and every store account.</li>
        <li><strong>One team, one schedule.</strong> Your editor, designer and distribution lead plan the book together.</li>
        <li><strong>Numbers you can check.</strong> Every statement shows the units and payments it was built from.</li>
      </ul>
    </page-section>
    <page-section data-testid="about-team" data-bascik-prop-label="Leadership" data-bascik-prop-title="The people in charge" data-bascik-prop-text="Each of our four teams is led by someone who still does the work.">
      <team-list />
    </page-section>
    <page-section data-testid="about-history" data-bascik-prop-label="History" data-bascik-prop-title="How we got here" data-bascik-prop-text="A short history of the company.">
      <company-timeline />
    </page-section>
    <call-to-action />
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/careers.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Careers",
        description:
          "Open roles in editorial, design, and royalties and distribution, with how to apply for each one.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="careers-main">
    <page-intro data-bascik-prop-title="Careers" data-bascik-prop-text="We hire people who love books and like getting the details right. Most roles can be done from our office or from home." />
    <page-section data-testid="careers-roles" data-bascik-prop-label="Open roles" data-bascik-prop-title="Join the team" data-bascik-prop-text="Apply by email with a short note and your résumé. We answer every application.">
      <role-list />
    </page-section>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/contact.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Contact",
        description:
          "Send us a message about your book, or find our office address, phone number, email address and opening hours.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="contact-main">
    <page-intro data-bascik-prop-title="Contact" data-bascik-prop-text="Tell us about your book or ask a question. We reply within two working days." />
    <div class="container contact-layout">
      <contact-form />
      <office-details />
    </div>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/index.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { organization, pageHead } from "@/lib/seo.ts";
    import { SITE } from "@/lib/site.ts";
    export default () =>
      pageHead({
        title: "Home",
        fullTitle: \`\${SITE.name} - \${SITE.tagline}\`,
        description: SITE.description,
        schema: [organization()],
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="home-main">
    <home-hero />
    <page-section data-testid="home-services" data-bascik-prop-label="Services" data-bascik-prop-title="Everything between the manuscript and the reader" data-bascik-prop-text="Take one service or all four. Each has its own lead, and they share one schedule.">
      <service-list />
    </page-section>
    <page-section data-testid="home-figures" data-bascik-prop-label="Key figures" data-bascik-prop-title="A small team with a long backlist" data-bascik-prop-text="Sample figures for this starter. Replace them with your own.">
      <key-figures />
    </page-section>
    <page-section data-testid="home-clients" data-bascik-prop-label="Clients" data-bascik-prop-title="Presses and bookshops we work with" data-bascik-prop-text="Independent publishers, author collectives and the shops that stock them.">
      <client-logos />
    </page-section>
    <page-section data-testid="home-testimonials" data-bascik-prop-label="Testimonials" data-bascik-prop-title="What authors say" data-bascik-prop-text="Three of the authors who published with us last year.">
      <testimonial-list />
    </page-section>
    <call-to-action />
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/news.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "News",
        description:
          "Company news, author milestones and product updates from our editorial, design and distribution teams.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="news-main">
    <page-intro data-bascik-prop-title="News" data-bascik-prop-text="What is new with the company, our authors and the services we offer." />
    <page-section data-testid="news-latest" data-bascik-prop-label="Newsroom" data-bascik-prop-title="Latest updates" data-bascik-prop-text="The most recent entry comes first.">
      <news-list />
    </page-section>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/privacy.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Privacy",
        description:
          "Placeholder privacy policy: what a real policy should cover, to be replaced with your own text before the site is published.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="privacy-main">
    <page-intro data-bascik-prop-title="Privacy policy" data-bascik-prop-text="How this site handles personal information." />
    <legal-text>
      <h2>What we collect</h2>
      <p>Describe the information the site collects, such as the name, email address and message a visitor sends through the contact form.</p>
      <h2>How we use it</h2>
      <p>Say what the information is used for, how long it is kept, and who it is shared with, if anyone.</p>
      <h2>Your choices</h2>
      <p>Explain how a visitor can ask to see, correct or delete their information, and give a way to <a href="/contact">contact you</a> about it.</p>
    </legal-text>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/services/[slug].html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <!-- One page per service at /services/<slug>. The routes script hands each page its entry from
       src/lib/services.ts; the head script below and <service-detail> read it from BASCIK_ROUTE. -->
  <script data-bascik-routes type="text/typescript">
    import { SERVICES } from "@/lib/services.ts";
    export default () =>
      SERVICES.map((service) => ({ params: { slug: service.slug }, data: service }));
  </script>
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    import type { Service } from "@/lib/services.ts";
    export default () => {
      const { data: service }: { data: Service } = JSON.parse(process.env.BASCIK_ROUTE || "{}");
      return pageHead({ title: service.name, description: service.summary });
    };
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="service-main">
    <service-detail />
    <call-to-action />
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/services/index.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Services",
        description:
          "Manuscript editing, cover and interior design, distribution and royalty accounting for independent authors and small presses.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="services-main">
    <page-intro data-bascik-prop-title="Services" data-bascik-prop-text="Four services that cover a book's whole journey. Take one, or let one team carry the book from first draft to quarterly statement." />
    <page-section data-testid="services-all" data-bascik-prop-label="What we do" data-bascik-prop-title="Choose where to start" data-bascik-prop-text="Each service has its own page with what is included, how it works and how long it takes.">
      <service-list />
    </page-section>
    <call-to-action />
  </main>
  <site-footer />
</body>
</html>
`,
  ],
  [
    "src/pages/terms.html",
    `<!doctype html>
<html lang="en">
<head>
  <site-head />
  <script data-bascik-build type="text/typescript">
    import { pageHead } from "@/lib/seo.ts";
    export default () =>
      pageHead({
        title: "Terms",
        description:
          "Placeholder terms of use: what real terms should cover, to be replaced with your own text before the site is published.",
      });
  </script>
</head>
<body>
  <site-header />
  <main id="main" data-testid="terms-main">
    <page-intro data-bascik-prop-title="Terms of use" data-bascik-prop-text="The rules for using this site." />
    <legal-text>
      <h2>Using this site</h2>
      <p>State who may use the site and what they may do with its text and pictures.</p>
      <h2>Our services</h2>
      <p>Point out that work for clients is governed by a separate agreement, not by this page.</p>
      <h2>Changes and contact</h2>
      <p>Say how these terms can change and how to <a href="/contact">reach you</a> with a question about them.</p>
    </legal-text>
  </main>
  <site-footer />
</body>
</html>
`,
  ],
];

/**
 * `src/pages/css/styles.css`: the template's own global stylesheet. Light by default, with a dark variant under
 * `prefers-color-scheme: dark`. Every color is a token on `:root` that the components read.
 */
export const CORPORATE_CSS = `/* styles.css: the site's global stylesheet. The design tokens are declared once, on :root, and every component
   reads them with var(). To rebrand the site, change --brand and its three companions in both blocks below. */

/* ── Design tokens ── */
:root {
  color-scheme: light dark;

  /* Surfaces and lines */
  --bg:            #e9edf3;
  --surface:       #f8fafd;
  --surface-top:   #ffffff;
  --border:        #d6deea;
  --border-strong: #616c80;

  /* Text */
  --text:          #293247;
  --text-muted:    #616c80;

  /* The brand color, a darker shade for hover, a tint for panels, and the text color that sits on the brand color */
  --brand:         #475cbd;
  --brand-strong:  #394da9;
  --brand-soft:    #edf0fc;
  --on-brand:      #ffffff;

  --danger:        #a32e42;
  --shadow:        0 24px 48px -16px rgba(36, 53, 89, 0.24), 0 6px 12px -4px rgba(36, 53, 89, 0.12);
  --panel:         linear-gradient(155deg, var(--surface-top), var(--surface) 72%);
  --sheen:         inset 0 1px 0 rgba(255, 255, 255, 0.9);

  /* Type */
  --sans:  system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --serif: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif;
  --mono:  ui-monospace, 'SF Mono', Menlo, Consolas, monospace;

  /* Shape */
  --r:    22px;
  --r-sm: 10px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg:            #11151c;
    --surface:       #222833;
    --surface-top:   #363e4c;
    --border:        #404957;
    --border-strong: #b3bbcb;
    --text:          #edf0f7;
    --text-muted:    #b3bbcb;
    --brand:         #b1bfff;
    --brand-strong:  #c8d2ff;
    --brand-soft:    #30394f;
    --on-brand:      #202b4a;
    --danger:        #ffabb7;
    --shadow:        0 24px 48px -16px rgba(0, 0, 0, 0.55), 0 6px 12px -4px rgba(0, 0, 0, 0.3);
    --sheen:         inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }
}

/* ── Base ── */
*, *::before, *::after { box-sizing: border-box; }

/* The header is sticky: keep a focused field or a #fragment target clear of it. */
html { scroll-padding-top: 80px; }

body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 1.0625rem;
  line-height: 1.65;
}

main { flex: 1; }

:focus-visible { outline: 3px solid var(--brand); outline-offset: 2px; }

/* ── Layout ── */
.container { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.section { padding: 80px 0; }
.section + .section { border-top: 1px solid var(--border); }

/* ── Typography ── */
h1, h2, h3 { margin-top: 0; color: var(--text); line-height: 1.2; }
h1, h2 { font-family: var(--serif); font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: clamp(2.25rem, 5vw, 3.5rem); margin-bottom: 16px; }
h2 { font-size: clamp(1.6rem, 3vw, 2.125rem); margin-bottom: 12px; }
h3 { font-size: 1.125rem; font-weight: 650; margin-bottom: 6px; }
p  { margin-top: 0; color: var(--text-muted); }

a { color: var(--brand); text-decoration: underline; text-underline-offset: 3px; }
a:hover { color: var(--brand-strong); }

.section-label {
  margin-bottom: 8px; color: var(--brand);
  font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em;
}

/* ── Buttons ── */
.btn {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 12px 22px; border: 1px solid transparent; border-radius: var(--r-sm);
  font: inherit; font-size: 0.95rem; font-weight: 600; line-height: 1.2;
  text-decoration: none; cursor: pointer;
}
.btn-primary { background: var(--brand); color: var(--on-brand); }
.btn-primary:hover { background: var(--brand-strong); color: var(--on-brand); }
.btn-ghost { background: var(--surface) var(--panel); color: var(--text); border-color: var(--border-strong); }
.btn-ghost:hover { color: var(--brand); border-color: var(--brand); }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }

/* ── Cards ── */
.card { padding: 28px; background: var(--surface) var(--panel); border: 1px solid var(--border); border-radius: var(--r); box-shadow: var(--sheen), var(--shadow); }
.card p { margin-bottom: 0; }

/* For text a screen reader should read and the eye does not need, such as the end of a "Learn more" link. */
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}

/* Long-form text: the legal pages and the promises on the about page. */
.prose { max-width: 720px; }
.prose h2 { margin-top: 36px; }
ul.prose { margin: 0; padding-left: 20px; color: var(--text-muted); }
ul.prose li { margin-bottom: 8px; }
ul.prose strong { color: var(--text); }

/* The contact page: the form beside the office details, stacked at phone width. */
.contact-layout {
  display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  gap: 48px; align-items: start; padding-top: 40px; padding-bottom: 88px;
}

/* ── 404 ── */
.not-found { text-align: center; }
.not-found-code {
  margin-bottom: 8px; color: var(--brand);
  font-family: var(--serif); font-size: clamp(4rem, 12vw, 8rem); font-weight: 600; line-height: 1;
}
.not-found-text { margin-bottom: 32px; }
.not-found .actions { justify-content: center; }

/* ── Phone width ── */
@media (max-width: 760px) {
  .section { padding: 56px 0; }
  .contact-layout { grid-template-columns: minmax(0, 1fr); }
}
`;
