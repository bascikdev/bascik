/**
 * Generates docs/lighthouse/lighthouserc.all.json and docs/lighthouse/lighthouserc.all-light.json
 * dynamically from docs/src/lib/nav.ts.
 *
 * Run with:
 *   node docs/lighthouse/generate-config.ts
 */
import { writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NAV, type NavSection } from "../src/lib/nav.ts";
import {
  LIGHTHOUSE_ORIGIN,
  LIGHTHOUSE_SERVER_COMMAND,
  SEO_URL_PATTERN,
} from "./site.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const lighthouseDir = resolve(__dirname);

/** An lhci assertion: a level (`off`, `warn`, `error`), or a level and its options. */
export type LighthouseAssertion = string | [string, Record<string, number>];

/**
 * An lhci `assert` block: flat `assertions` for every URL, or `assertMatrix` entries, each checked for every URL its
 * `matchingUrlPattern` matches (every URL without one).
 */
export interface LighthouseAssertOptions {
  assertions?: Record<string, LighthouseAssertion>;
  assertMatrix?: {
    matchingUrlPattern?: string;
    assertions: Record<string, LighthouseAssertion>;
  }[];
}

/** The two sweep configs for every page in `nav`, as generateLighthouseAllConfig writes them. */
export function lighthouseAllConfigs(
  nav: NavSection[] = NAV,
  baseUrl = LIGHTHOUSE_ORIGIN,
) {
  // Collect all page hrefs from the nav. External nav entries (e.g. Merch) are
  // off-site and can't be audited against the local server, so they are skipped.
  const navHrefs = nav.flatMap((section) =>
    section.pages.filter((page) => !page.external).map((page) => page.href),
  );

  // Standalone pages not listed in main nav hierarchy
  const extraPages = ["/", "/license", "/sponsor"];

  // Combine and deduplicate
  const allRoutes = Array.from(new Set([...extraPages, ...navHrefs])).sort();
  const allUrls = allRoutes.map(
    (route) => `${baseUrl}${route === "/" ? "/" : route}`,
  );
  const lightUrls = allRoutes.map(
    (route) =>
      `${baseUrl}${route === "/" ? "/?theme=light" : `${route}?theme=light`}`,
  );

  const sweepAssert: LighthouseAssertOptions = {
    // The gates' shape (lighthouserc.json): lhci checks every entry whose pattern matches a URL, so SEO sits in
    // its own entry, which skips the noindex /search page, and /search keeps the other categories.
    assertMatrix: [
      {
        matchingUrlPattern: ".*",
        assertions: {
          "is-crawlable": "off",
          // Every page, one run each: a warning, since one noisy run should not fail the sweep. The gate
          // that fails is lighthouserc.json and lighthouserc.desktop.json.
          "categories:performance": ["warn", { minScore: 0.95 }],
          "categories:accessibility": ["error", { minScore: 1.0 }],
          "categories:best-practices": ["error", { minScore: 1.0 }],
        },
      },
      {
        matchingUrlPattern: SEO_URL_PATTERN,
        assertions: {
          "categories:seo": ["error", { minScore: 1.0 }],
        },
      },
    ],
  };
  const lightAssert: LighthouseAssertOptions = {
    assertions: {
      "categories:accessibility": ["error", { minScore: 1.0 }],
    },
  };

  const config = {
    ci: {
      collect: {
        startServerCommand: LIGHTHOUSE_SERVER_COMMAND,
        startServerReadyPattern: `Server running at ${baseUrl}`,
        url: allUrls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: "--no-sandbox --headless",
        },
      },
      assert: sweepAssert,
      upload: {
        target: "filesystem",
        outputDir: "./.lighthouseci",
      },
    },
  };

  const lightConfig = {
    ci: {
      collect: {
        startServerCommand: LIGHTHOUSE_SERVER_COMMAND,
        startServerReadyPattern: `Server running at ${baseUrl}`,
        url: lightUrls,
        numberOfRuns: 1,
        settings: {
          chromeFlags: "--no-sandbox --headless",
          onlyCategories: ["accessibility"],
        },
      },
      assert: lightAssert,
      upload: {
        target: "filesystem",
        outputDir: "./.lighthouseci-light",
      },
    },
  };

  return { urls: allUrls, config, lightConfig };
}

export async function generateLighthouseAllConfig(
  baseUrl = LIGHTHOUSE_ORIGIN,
): Promise<string[]> {
  const { urls, config, lightConfig } = lighthouseAllConfigs(NAV, baseUrl);
  const outPath = join(lighthouseDir, "lighthouserc.all.json");
  await writeFile(outPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const lightOutPath = join(lighthouseDir, "lighthouserc.all-light.json");
  await writeFile(
    lightOutPath,
    JSON.stringify(lightConfig, null, 2) + "\n",
    "utf8",
  );

  return urls;
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("generate-config.ts") ||
    process.argv[1].endsWith("generate-config.js"));

if (isMain) {
  const urls = await generateLighthouseAllConfig();
  console.log(
    `[generate-lighthouse-config] Generated lighthouserc.all.json and lighthouserc.all-light.json with ${urls.length} URLs from nav.ts`,
  );
}
