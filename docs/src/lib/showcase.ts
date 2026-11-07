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

export async function renderShowcase(featured = false): Promise<string> {
  const sites = featured
    ? SHOWCASE_SITES.filter(
        (site) => site.slug === "lateral" || site.slug === "rinsesoft",
      ).toReversed()
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
          )}</div>
          <div data-bascik-slot="description">${description}</div>
        </showcase-card>`;
      }),
    )
  ).join("\n");
}
