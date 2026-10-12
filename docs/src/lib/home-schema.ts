/**
 * home-schema.ts
 *
 * JSON-LD for the home page: the SoftwareApplication and Organization entities.
 * `softwareVersion` is read from pkg/package.json at build time (release candidate suffixes
 * dropped, see package-version.ts), so the structured data always matches the release being
 * published (1.0.0 at launch) with nothing to remember to bump.
 *
 * Usage inside a <script data-bascik-build> block in <head>:
 *
 *   import { homeSchema } from '@/lib/home-schema.ts';
 *   export default async () => await homeSchema();
 */
import { BRAND_SAME_AS } from './article-schema.ts';
import { readStableVersion } from './package-version.ts';

const SITE_URL = 'https://bascik.dev';
const DESCRIPTION =
  'Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote.';

function jsonLdScript(schema: object): string {
  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}

export async function homeSchema(packageJsonPath?: string): Promise<string> {
  const softwareVersion = await readStableVersion(packageJsonPath);

  const software = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Bascik',
    url: SITE_URL,
    description: DESCRIPTION,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    creator: { '@type': 'Person', name: 'Collin Thomas', url: 'https://github.com/collin-thomas' },
    downloadUrl: 'https://www.npmjs.com/package/@bascik/bascik',
    ...(softwareVersion ? { softwareVersion } : {}),
    license: `${SITE_URL}/license`,
    codeRepository: 'https://github.com/bascikdev/bascik',
    sameAs: [...BRAND_SAME_AS],
  };

  const organization = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Bascik',
    url: SITE_URL,
    logo: `${SITE_URL}/assets/apple-touch-icon.png`,
    sameAs: [...BRAND_SAME_AS],
  };

  return `${jsonLdScript(software)}\n${jsonLdScript(organization)}`;
}
