import { esc } from "@bascik/bascik/html";
import { slugFromHeadingHtml } from "./heading-slug.ts";
import { demoImage, renderMdRange } from "./md-renderer.ts";

export const SHOWCASE_SITES = [
  { slug: "rinsesoft", name: "Rinsesoft", url: "https://rinsesoft.com" },
  {
    slug: "sunridge",
    name: "Sunridge Counseling",
    url: "https://sunridgecounseling.com",
  },
  { slug: "dgco", name: "DGCO", url: "https://dgcocpa.com" },
  { slug: "lateral", name: "Lateral EMDR", url: "https://lateralemdr.com" },
  { slug: "bascik", name: "Bascik", url: "https://bascik.dev" },
  { slug: "bascik-shop", name: "Bascik Shop", url: "https://shop.bascik.dev" },
] as const;

/**
 * How wide a card's screenshot is laid out: the viewport less the page gutters on a phone (310 pixels at 360),
 * and at most 528 pixels in the home page's two-column preview (the showcase page's cards are narrower).
 */
const SHOWCASE_IMAGE_SIZES = "(max-width: 620px) calc(100vw - 50px), 528px";

export async function renderShowcase(featured = false): Promise<string> {
  // The home page shows two: the SaaS dashboard, then the shop.
  const sites = featured
    ? SHOWCASE_SITES.filter(
        (site) => site.slug === "lateral" || site.slug === "bascik-shop",
      )
    : SHOWCASE_SITES;
  return (
    await Promise.all(
      sites.map(async (site) => {
        const index = SHOWCASE_SITES.indexOf(site);
        const description = await renderMdRange(
          "./content/showcase.md",
          {
            from: site.name,
            to: SHOWCASE_SITES[index + 1]?.name ?? "Submit your site",
          },
          { skipFirstHeading: true },
        );
        return `<showcase-card
          data-bascik-prop-name="${esc(site.name)}"
          data-bascik-prop-anchor="${esc(slugFromHeadingHtml(site.name))}"
          data-bascik-prop-url="${esc(site.url)}"
          data-bascik-prop-domain="${esc(new URL(site.url).hostname)}"
          data-bascik-prop-site="${esc(site.slug)}">
          <div data-bascik-slot="image">${demoImage(
            `/assets/demos/showcase-${site.slug}@2x.webp`,
            `${site.name} website homepage`,
            undefined,
            SHOWCASE_IMAGE_SIZES,
          )}</div>
          <div data-bascik-slot="description">${description}</div>
        </showcase-card>`;
      }),
    )
  ).join("\n");
}
