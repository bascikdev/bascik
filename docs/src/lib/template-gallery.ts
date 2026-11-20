import { html, raw } from "@bascik/bascik/html";
import { demoImage, renderMdRange } from "./md-renderer.ts";

export const TEMPLATE_DEMOS = [
  { slug: "default", name: "Default", path: "/" },
  { slug: "blog", name: "Blog", path: "/blog/" },
  { slug: "docs", name: "Docs", path: "/" },
  { slug: "landing", name: "Landing", path: "/" },
  { slug: "portfolio", name: "Portfolio", path: "/" },
  { slug: "corporate", name: "Corporate", path: "/" },
  { slug: "shop", name: "Shop", path: "/" },
  { slug: "reports", name: "Reports", path: "/" },
  { slug: "dashboard", name: "Dashboard", path: "/" },
].map((template) => ({
  ...template,
  origin: `https://template-${template.slug}.bascik.dev`,
}));

export async function renderTemplateGallery() {
  const cards = await Promise.all(
    TEMPLATE_DEMOS.map(async ({ slug, name, origin, path }, index) => {
      const description = await renderMdRange(
        "./content/templates.md",
        {
          from: name,
          to: TEMPLATE_DEMOS[index + 1]?.name ?? "Make a template your own",
        },
        { skipFirstHeading: true },
      );
      return html`<showcase-card
        data-bascik-prop-name="${name}"
        data-bascik-prop-anchor="${slug}"
        data-bascik-prop-url="${new URL(path, origin).href}"
        data-bascik-prop-domain="${new URL(origin).hostname}"
        data-bascik-prop-site="${slug}"
      >
        <div data-bascik-slot="image">
          ${raw(
            demoImage(
              `/assets/demos/template-${slug}@2x.webp`,
              "",
              undefined,
              "(max-width: 620px) calc(100vw - 50px), 528px",
            ),
          )}
        </div>
        <div data-bascik-slot="description">${raw(description)}</div>
      </showcase-card>`;
    }),
  );
  return html`${cards}`;
}
