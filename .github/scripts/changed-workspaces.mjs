import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_SUITES = [
  "pkg",
  "create",
  "lsp",
  "docs",
  "skills",
  "extension",
  "adapter-cloudflare",
  "adapter-netlify",
];

const allSuites = () =>
  Object.fromEntries(ROOT_SUITES.map((suite) => [suite, true]));

export function changedWorkspaces(paths, { all = false } = {}) {
  const suites = Object.fromEntries(ROOT_SUITES.map((suite) => [suite, false]));
  const shop = { unit: false, integration: false, e2e: false };

  if (all || paths.length === 0) {
    Object.assign(suites, allSuites());
    Object.assign(shop, { unit: true, integration: true, e2e: true });
  } else {
    for (const rawPath of paths) {
      const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
      if (path.startsWith("pkg/") || isSharedBuildFile(path)) {
        Object.assign(suites, allSuites());
        Object.assign(shop, { unit: true, integration: true, e2e: true });
        break;
      }

      if (path.startsWith("create/")) suites.create = true;
      else if (path.startsWith("lsp/")) {
        suites.lsp = true;
        suites.extension = true;
        suites.skills = true;
      } else if (path.startsWith("docs/")) suites.docs = true;
      else if (
        path.startsWith("skills/") ||
        path.startsWith("skills-tests/") ||
        path.startsWith(".github/skills/")
      )
        suites.skills = true;
      else if (path.startsWith("extensions/vscode-bascik/"))
        suites.extension = true;
      else if (
        path.startsWith("adapters/e2e/") ||
        path.startsWith("adapters/cloudflare/")
      ) {
        suites["adapter-cloudflare"] = true;
        if (path.startsWith("adapters/e2e/")) suites["adapter-netlify"] = true;
        if (path.startsWith("adapters/cloudflare/")) {
          shop.integration = true;
          shop.e2e = true;
        }
      } else if (path.startsWith("adapters/netlify/"))
        suites["adapter-netlify"] = true;
      else if (path.startsWith("examples/")) {
        suites.pkg = true;
        suites.create = true;
        suites.docs = true;
      } else if (path.startsWith("shop/")) {
        markShopSuites(path, shop);
      } else if (path === ".github/workflows/shop.yml") {
        shop.unit = true;
      } else if (!isDocumentationOrWorkflow(path)) {
        Object.assign(suites, allSuites());
        Object.assign(shop, { unit: true, integration: true, e2e: true });
        break;
      }
    }
  }

  const rootAny = Object.values(suites).some(Boolean);
  return {
    ...Object.fromEntries(
      Object.entries(suites).map(([suite, changed]) => [
        `run-${suite}`,
        String(changed),
      ]),
    ),
    "run-shop-unit": String(shop.unit),
    "run-shop-integration": String(shop.integration),
    "run-shop-e2e": String(shop.e2e),
    "run-node-floor": String(
      suites.pkg ||
        suites.create ||
        suites.lsp ||
        suites.skills ||
        suites.extension ||
        suites["adapter-cloudflare"] ||
        suites["adapter-netlify"],
    ),
    "run-linear-time": String(suites.pkg || suites.lsp || suites.skills),
    "docs-only": String(
      paths.length > 0 &&
        paths.every((path) => path.startsWith("docs/content/")),
    ),
    "run-any": String(rootAny),
  };
}

function isSharedBuildFile(path) {
  return (
    path === "package.json" ||
    path === "yarn.lock" ||
    path === ".yarnrc.yml" ||
    path.startsWith(".yarn/") ||
    (path.startsWith(".github/workflows/") &&
      path !== ".github/workflows/shop.yml") ||
    path.startsWith(".github/scripts/") ||
    path.startsWith(".github/instructions/") ||
    path === "tsconfig.json" ||
    path === "vite.config.ts" ||
    path === "vite.config.js"
  );
}

function isDocumentationOrWorkflow(path) {
  return (
    path.endsWith(".md") ||
    path === ".github/workflows/shop.yml" ||
    path.startsWith("bascik-prompts/")
  );
}

function markShopSuites(path, shop) {
  if (path.startsWith("shop/src/")) {
    Object.assign(shop, { unit: true, integration: true, e2e: true });
  } else if (path.startsWith("shop/tests/")) {
    if (path.endsWith(".integration.test.ts")) shop.integration = true;
    else if (path.endsWith(".test.ts")) shop.unit = true;
    else Object.assign(shop, { unit: true, integration: true, e2e: true });
  } else if (path.startsWith("shop/e2e/")) shop.e2e = true;
  else if (path.startsWith("shop/scripts/")) {
    shop.integration = true;
    if (
      /(?:build-assets|checkout-notice|production-config|product-description|image-cache|template-fingerprint|deploy-preview)\.ts$/.test(
        path,
      )
    )
      shop.unit = true;
    if (
      /^(?:shop\/scripts\/(?:build-assets|package-worker|serve-tests)\.ts)$/.test(
        path,
      )
    )
      shop.e2e = true;
  } else if (
    path === "shop/bascik.config.ts" ||
    path === "shop/vite.config.ts" ||
    path === "shop/playwright.config.ts" ||
    path === "shop/package.json" ||
    path.startsWith("shop/catalog/")
  )
    Object.assign(shop, { unit: true, integration: true, e2e: true });
  else if (!path.endsWith(".md"))
    Object.assign(shop, { unit: true, integration: true, e2e: true });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const forceAll = process.argv.includes("--all");
  const file = process.argv[2];
  const paths = forceAll
    ? []
    : readFileSync(file, "utf8").split("\0").filter(Boolean);
  const outputs = changedWorkspaces(paths, { all: forceAll });
  for (const [name, value] of Object.entries(outputs))
    process.stdout.write(`${name}=${value}\n`);
}
