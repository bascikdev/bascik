/**
 * home-schema.ts
 *
 * JSON-LD for the home page: the SoftwareApplication and Organization entities.
 * `softwareVersion` is read from pkg/package.json at build time (a prerelease suffix is
 * dropped, see package-version.ts), so the structured data always matches the release being
 * published (1.0.0 at launch) with nothing to remember to bump.
 *
 * Usage inside a <script data-bascik-build> block in <head>:
 *
 *   import { homeSchema } from '@/lib/home-schema.ts';
 *   export default async () => await homeSchema();
 */
import type { SafeHtml } from "@bascik/bascik/html";
import { BRAND_SAME_AS } from "./article-schema.ts";
import { renderJsonLd } from "./json-ld.ts";
import { readStableVersion } from "./package-version.ts";

const SITE_URL = "https://bascik.dev";
const SITE_HOME_URL = `${SITE_URL}/`;
const DESCRIPTION =
  "Bascik is a zero-runtime HTML component builder with automatically scoped CSS and JavaScript. Build reusable components without a client-side framework.";

export async function homeSchema(packageJsonPath?: string): Promise<SafeHtml> {
  const softwareVersion = await readStableVersion(packageJsonPath);

  const software = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Bascik",
    url: SITE_HOME_URL,
    description: DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows, Linux",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    creator: {
      "@type": "Person",
      name: "Collin Thomas",
      url: "https://github.com/collin-thomas",
    },
    downloadUrl: "https://www.npmjs.com/package/@bascik/bascik",
    ...(softwareVersion ? { softwareVersion } : {}),
    license: `${SITE_URL}/license`,
    codeRepository: "https://github.com/bascikdev/bascik",
    sameAs: [...BRAND_SAME_AS],
  };

  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Bascik",
    alternateName: "Bascik.dev",
    url: SITE_HOME_URL,
    description: DESCRIPTION,
    logo: `${SITE_URL}/assets/apple-touch-icon.png`,
    sameAs: [...BRAND_SAME_AS],
  };

  return renderJsonLd(software, organization);
}
