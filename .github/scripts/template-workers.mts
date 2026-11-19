import { execFileSync, spawn } from "node:child_process";
import { resolve4, resolve6, resolveCname } from "node:dns/promises";
import { existsSync } from "node:fs";
import {
  appendFile,
  cp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { mergedPullRequest } from "./merged-pull-request.mjs";
import { parseChecks, smokeTest } from "./smoke-test.mjs";

export const TEMPLATE_SLUGS = [
  "default",
  "blog",
  "docs",
  "landing",
  "portfolio",
  "corporate",
  "shop",
  "reports",
  "dashboard",
] as const;

const repo = resolve(import.meta.dirname, "../..");
const wrangler = join(repo, "node_modules/wrangler/bin/wrangler.js");
const localDbId = "00000000-0000-4000-8000-000000000001";

export function templateWorker(slug: string, lane: string) {
  if (!TEMPLATE_SLUGS.some((allowed) => allowed === slug))
    throw new Error(`Unknown hosted template: ${slug}`);
  if (lane !== "preview" && lane !== "production")
    throw new Error(`Unknown deployment lane: ${lane}`);
  const preview = lane === "preview";
  const hostname = `template-${slug}.bascik.dev`;
  return {
    name: `bascik-template-${slug}${preview ? "-preview" : ""}`,
    compatibility_date: "2026-08-01",
    compatibility_flags: ["nodejs_compat"],
    routes: preview ? [] : [{ pattern: hostname, custom_domain: true }],
    workers_dev: preview,
    preview_urls: false,
  };
}

type Worker = ReturnType<typeof templateWorker>;
const routes: Record<(typeof TEMPLATE_SLUGS)[number], string> = {
  default: "/edge",
  blog: "/blog/",
  docs: "/docs/getting-started",
  landing: "/privacy",
  portfolio: "/work",
  corporate: "/contact",
  shop: "/checkout",
  reports: "/compare",
  dashboard: "/orders",
};

export function reportsDatabase(lane: string, id: string) {
  if (lane !== "preview" && lane !== "production")
    throw new Error("Expected the Reports preview or production lane");
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id))
    throw new Error(`Missing or invalid Reports ${lane} D1 ID`);
  return {
    binding: "DB",
    database_name: templateWorker("reports", lane).name + "-db",
    database_id: id,
  };
}

function configName(lane: string) {
  return lane === "preview" ? "wrangler.preview.json" : "wrangler.jsonc";
}

async function seedReports(directory: string, lane: string, local = false) {
  const project = join(directory, "reports");
  const out = join(project, "dist/.bascik/cloudflare");
  const config = configName(lane);
  const id = local ? localDbId : (process.env.REPORTS_D1_ID ?? "");
  const database = reportsDatabase(lane, id);
  if (!local) {
    if (
      id === localDbId ||
      !process.env.CLOUDFLARE_API_TOKEN ||
      !process.env.CLOUDFLARE_ACCOUNT_ID
    )
      throw new Error(
        "Reports remote seed requires an isolated database and CI credentials",
      );
    const info = JSON.parse(
      execFileSync(
        process.execPath,
        [wrangler, "d1", "info", database.database_name, "--json"],
        { cwd: out, encoding: "utf8" },
      ),
    );
    if (info.uuid !== id || info.name !== database.database_name)
      throw new Error(
        "D1 ID does not match the dedicated Reports database name",
      );
  }
  const payload = JSON.parse(await readFile(join(out, config), "utf8"));
  await writeFile(
    join(out, config),
    JSON.stringify({ ...payload, d1_databases: [database] }),
  );
  const sql = execFileSync(
    process.execPath,
    ["scripts/seed-database.ts", "--sql"],
    {
      cwd: project,
    },
  );
  await writeFile(join(out, "reports-seed.sql"), sql);
  execFileSync(
    process.execPath,
    [
      wrangler,
      "d1",
      "execute",
      "DB",
      "--config",
      config,
      "--file",
      "reports-seed.sql",
      ...(local
        ? ["--local", "--persist-to", join(out, "local-state")]
        : ["--remote", "--yes"]),
    ],
    { cwd: out, stdio: "inherit" },
  );
}

export function assertDomainOwner(records: unknown, worker: Worker) {
  if (!Array.isArray(records))
    throw new Error("Cloudflare did not return a custom domain list");
  if (
    records.some(
      (record) =>
        record?.service !== worker.name || record.environment !== "production",
    )
  )
    throw new Error(
      "Custom domain is already attached elsewhere; refusing to deploy",
    );
}

async function checkDomain(worker: Worker) {
  const [route] = worker.routes;
  if (!route) throw new Error("Expected a production custom domain");
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } =
    process.env;
  if (!token || !account || !/^[a-f0-9]{32}$/i.test(account))
    throw new Error("Cloudflare CI credentials are missing or invalid");
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`,
  );
  url.searchParams.set("hostname", route.pattern);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(
      `Could not check Cloudflare custom domain ownership (${response.status})`,
    );
  const { success, result } = await response.json();
  if (success !== true)
    throw new Error("Cloudflare custom domain lookup failed");
  const records = Array.isArray(result)
    ? result.filter((record) => record?.hostname === route.pattern)
    : result;
  assertDomainOwner(records, worker);
  if (records.length) return;
  await Promise.all(
    [resolve4, resolve6, resolveCname].map(async (lookup) => {
      const records = await lookup(route.pattern).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOTFOUND" || error.code === "ENODATA") return [];
          throw error;
        },
      );
      if (records.length)
        throw new Error(
          `${route.pattern} already resolves in DNS; refusing to deploy`,
        );
    }),
  );
}

export function previewUrl(ndjson: string, worker: Worker) {
  if (!worker.workers_dev) throw new Error("Expected a preview Worker");
  for (const line of ndjson.split("\n").filter((line) => line.trim())) {
    const result = JSON.parse(line);
    if (result.type !== "deploy" || result.worker_name !== worker.name)
      continue;
    for (const target of result.targets ?? []) {
      const url = URL.parse(target);
      if (
        url &&
        url.origin === target &&
        url.protocol === "https:" &&
        url.hostname.startsWith(`${worker.name}.`) &&
        url.hostname.split(".").length === 4 &&
        url.hostname.endsWith(".workers.dev")
      )
        return url.origin;
    }
  }
  throw new Error(
    `Wrangler did not report a workers.dev URL for ${worker.name}`,
  );
}

async function build(slug: string, directory: string) {
  const production = templateWorker(slug, "production");
  const preview = templateWorker(slug, "preview");
  const scaffoldUrl = pathToFileURL(join(repo, "create/dist/scaffold.js")).href;
  const { scaffold } = await import(scaffoldUrl);
  const registry = join(repo, "create/dist/templates.js");
  if (existsSync(registry)) {
    const { templateNamed } = await import(pathToFileURL(registry).href);
    const template = templateNamed(slug);
    if (!template)
      throw new Error(`Template '${slug}' is not registered at this commit`);
    await scaffold(slug, directory, { template, adapter: "cloudflare" });
  } else {
    if (slug !== "default")
      throw new Error(`Template '${slug}' is not registered at this commit`);
    await scaffold(slug, directory, { template: "cloudflare" });
  }
  const project = join(directory, slug);
  const manifest = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
  const modules = join(project, "node_modules");
  // Use only lockfile-backed workspace packages; do not download released
  // compiler packages or run the scaffolder's install/agent setup CLI.
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    "@bascik/adapter-cloudflare": "",
  })) {
    const installed = join(repo, "node_modules", dependency);
    if (!existsSync(installed))
      throw new Error(`No locked workspace package for ${dependency}`);
    const parent = dependency.startsWith("@")
      ? join(modules, dependency.split("/")[0])
      : modules;
    await mkdir(parent, { recursive: true });
    await symlink(installed, join(modules, dependency), "dir");
  }
  await mkdir(join(modules, ".bin"));
  await symlink(join(repo, "pkg/bin/bascik.js"), join(modules, ".bin/bascik"));
  await writeFile(join(project, "wrangler.jsonc"), JSON.stringify(production));
  execFileSync("npm", ["run", "build"], {
    cwd: project,
    env: {
      ...process.env,
      BASCIK_SITE_URL: `https://${production.routes[0].pattern}`,
    },
    stdio: "inherit",
  });
  const out = join(project, "dist/.bascik/cloudflare");
  const generated = JSON.parse(
    await readFile(join(out, "wrangler.jsonc"), "utf8"),
  );
  const sha = buildSha();
  await writeFile(join(out, "public", `build-${sha}.txt`), `${slug}\n`);
  await cp(join(out, "public"), join(out, "preview-public"), {
    recursive: true,
  });
  await writeFile(
    join(out, "preview-public/robots.txt"),
    "User-agent: *\nDisallow: /\n",
  );
  await writeFile(
    join(out, "wrangler.preview.json"),
    JSON.stringify({
      ...generated,
      ...preview,
      assets: { ...generated.assets, directory: "./preview-public" },
    }),
  );
  console.log(`Built ${production.name} in ${out}`);
}

function buildSha() {
  const sha = process.env.GITHUB_SHA ?? "local";
  if (sha !== "local" && !/^[a-f0-9]{40}$/i.test(sha))
    throw new Error("Invalid build SHA");
  return sha;
}

async function smoke(slug: string, url: string, local = false) {
  templateWorker(slug, "production");
  const checks = new Set([
    "/=200",
    `${routes[slug as keyof typeof routes]}=200`,
    "/api/hello=200",
    `/build-${buildSha()}.txt=200`,
    "/not-a-template-page=404",
  ]);
  const failures = await smokeTest(
    url,
    parseChecks([...checks]),
    local ? { attempts: 15, delayMs: 1_000 } : {},
  );
  if (failures.length) throw new Error(failures.join("\n"));
}

async function localSmoke(slug: string, directory: string) {
  const worker = templateWorker(slug, "preview");
  const out = join(directory, slug, "dist/.bascik/cloudflare");
  if (slug === "reports") await seedReports(directory, "preview", true);
  const port = "18794";
  const dev = spawn(
    process.execPath,
    [
      wrangler,
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      port,
      "--config",
      "wrangler.preview.json",
      "--persist-to",
      join(out, "local-state"),
    ],
    {
      cwd: out,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: "inherit",
    },
  );
  const closed = new Promise((resolve) => dev.once("close", resolve));
  try {
    await Promise.race([
      smoke(slug, `http://127.0.0.1:${port}`, true),
      closed.then((code) => {
        throw new Error(`${worker.name} local runtime exited (${code})`);
      }),
    ]);
  } finally {
    dev.kill("SIGTERM");
    await closed;
  }
}

async function checkMerged() {
  const {
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: sha,
    GITHUB_REF: ref,
  } = process.env;
  if (repository !== "bascikdev/bascik" || ref !== "refs/heads/main" || !sha)
    throw new Error("Template deploys must use main of bascikdev/bascik");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pulls = JSON.parse(
      execFileSync("gh", ["api", `repos/${repository}/commits/${sha}/pulls`], {
        encoding: "utf8",
      }),
    );
    if (Array.isArray(pulls) && pulls.length === 0 && attempt < 3) {
      await delay(10_000);
      continue;
    }
    console.log(
      `Template deploy is from merged PR #${mergedPullRequest(pulls, sha)}`,
    );
    return;
  }
}

if (import.meta.main) {
  const [command, slug, argument] = process.argv.slice(2);
  try {
    if (command === "build" && argument) await build(slug, resolve(argument));
    else if (command === "local-smoke" && argument)
      await localSmoke(slug, resolve(argument));
    else if (command === "smoke" && argument) await smoke(slug, argument);
    else if (command === "check-merged") await checkMerged();
    else if (command === "seed-reports" && slug && argument)
      await seedReports(resolve(argument), slug);
    else if (command === "check-domain")
      await checkDomain(templateWorker(slug, "production"));
    else if (command === "list") {
      const registry = join(repo, "create/dist/templates.js");
      const templates = existsSync(registry)
        ? (await import(pathToFileURL(registry).href)).TEMPLATES
        : [{ name: "default" }];
      console.log(
        TEMPLATE_SLUGS.filter((slug) =>
          templates.some(({ name }: { name: string }) => slug === name),
        ).join("\n"),
      );
    } else if (command === "preview-url" && argument) {
      const url = previewUrl(
        await readFile(argument, "utf8"),
        templateWorker(slug, "preview"),
      );
      if (process.env.GITHUB_OUTPUT)
        await appendFile(process.env.GITHUB_OUTPUT, `url=${url}\n`);
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `Template ${slug} preview at ${buildSha()}: ${url}\n`,
        );
      console.log(url);
    } else throw new Error("Unknown or incomplete template-workers command");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
