#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = "bascikdev/bascik";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGES = [
  { id: "lsp", dir: "lsp", prefix: "lsp-v", stage: 0 },
  { id: "pkg", dir: "pkg", prefix: "v", stage: 0 },
  { id: "create", dir: "create", prefix: "create-v", stage: 1 },
  {
    id: "cloudflare",
    dir: "adapters/cloudflare",
    prefix: "adapter-cloudflare-v",
    stage: 1,
  },
  {
    id: "extension",
    dir: "extensions/vscode-bascik",
    prefix: "ext-v",
    stage: 2,
  },
];

/** @param {string} command @param {string[]} args */
function command(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 120_000,
  }).trim();
}

/** @param {string} name @param {string} version */
async function registryHasVersion(name, version) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return false;
  if (!response.ok)
    throw new Error(`npm registry returned ${response.status} for ${name}`);
  const manifest = await response.json();
  return manifest.version === version;
}

/**
 * @param {string[]} args
 * @param {{
 *   run?: typeof command,
 *   pause?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   registry?: typeof registryHasVersion,
 *   log?: (message: string) => void
 * }} dependencies
 */
export async function release(args, dependencies = {}) {
  const {
    run = command,
    pause = sleep,
    now = Date.now,
    registry = registryHasVersion,
    log = console.log,
  } = dependencies;
  if (args.includes("--help")) {
    log(
      "Usage: yarn release [pkg lsp create cloudflare extension] [--dry-run] [--extension-pre]\n" +
        "Default: release all five artifacts. Versions come from origin/main.\n" +
        "--extension-pre selects the Marketplace pre-release channel.",
    );
    return;
  }
  const dryRun = args.includes("--dry-run");
  const extensionPre = args.includes("--extension-pre");
  const ids = args.filter(
    (arg) => !["--dry-run", "--extension-pre"].includes(arg),
  );
  for (const id of ids)
    if (!PACKAGES.some((pkg) => pkg.id === id))
      throw new Error(`Unknown package or option: ${id}. Use --help.`);
  const selected = PACKAGES.filter(
    (pkg) => ids.length === 0 || ids.includes(pkg.id),
  );
  if (extensionPre && !selected.some((pkg) => pkg.id === "extension"))
    throw new Error("--extension-pre requires selecting extension.");

  const origin = run("git", ["remote", "get-url", "--push", "origin"]);
  if (
    !/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)bascikdev\/bascik(?:\.git)?$/.test(
      origin,
    )
  )
    throw new Error(`origin must point to ${REPO}, got ${origin}`);
  run("git", [
    "fetch",
    "--no-tags",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ]);
  const sha = run("git", ["rev-parse", "origin/main"]);
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Invalid origin/main commit.");
  const plan = selected.map((pkg) => {
    const manifest = JSON.parse(
      run("git", ["show", `${sha}:${pkg.dir}/package.json`]),
    );
    if (
      typeof manifest.name !== "string" ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
        manifest.version,
      )
    )
      throw new Error(`Invalid release manifest: ${pkg.dir}/package.json`);
    if (pkg.id === "extension" && manifest.version.includes("-"))
      throw new Error("Marketplace versions must be plain x.y.z.");
    const prefix =
      pkg.id === "extension" && extensionPre ? "ext-pre-v" : pkg.prefix;
    return {
      ...pkg,
      name: manifest.name,
      version: manifest.version,
      tag: `${prefix}${manifest.version}`,
    };
  });
  log(`${dryRun ? "Previewing" : "Releasing"} ${sha}:`);
  for (const pkg of plan) log(`  ${pkg.id}: ${pkg.tag}`);

  if (!dryRun) {
    run("gh", ["auth", "status"]);
    // Preflight every tag before pushing any stage. Never move an existing release tag.
    const existing = run("git", [
      "ls-remote",
      "--tags",
      "origin",
      ...plan.map((pkg) => `refs/tags/${pkg.tag}`),
    ]);
    if (existing)
      throw new Error(
        `Release tags already exist:\n${existing}\nSelect only unreleased packages. For failed releases, inspect Actions and retry or explicitly repair the failed tag; this script never replaces tags.`,
      );
  }

  /** @param {() => Promise<boolean>} ready @param {number} timeout @param {string} label */
  async function waitFor(ready, timeout, label) {
    const deadline = now() + timeout;
    while (!(await ready())) {
      if (now() >= deadline)
        throw new Error(
          `Timed out waiting for ${label}. Inspect Actions before retrying.`,
        );
      await pause(10_000);
    }
  }

  for (const stage of [0, 1, 2]) {
    const packages = plan.filter((pkg) => pkg.stage === stage);
    if (!packages.length) continue;
    const pushArgs = [
      "push",
      "--atomic",
      "origin",
      ...packages.map((pkg) => `${sha}:refs/tags/${pkg.tag}`),
    ];
    log(`git ${pushArgs.join(" ")}`);
    if (dryRun) {
      log(
        "  Wait for this stage's Release runs to succeed and npm versions to resolve before continuing.",
      );
      continue;
    }
    run("git", pushArgs);
    for (const pkg of packages) {
      log(`Waiting for ${pkg.tag}...`);
      await waitFor(
        async () => {
          /** @type {{databaseId: number, headSha: string, status: string, conclusion: string}[]} */
          const runs = JSON.parse(
            run("gh", [
              "run",
              "list",
              "--repo",
              REPO,
              "--workflow",
              "release.yml",
              "--event",
              "push",
              "--branch",
              pkg.tag,
              "--limit",
              "10",
              "--json",
              "databaseId,headSha,status,conclusion",
            ]),
          );
          const workflow = runs.find((item) => item.headSha === sha);
          if (!workflow || workflow.status !== "completed") return false;
          if (workflow.conclusion !== "success")
            throw new Error(
              `${pkg.tag} failed (${workflow.conclusion}): https://github.com/${REPO}/actions/runs/${workflow.databaseId}. Later stages were not pushed.`,
            );
          return true;
        },
        60 * 60_000,
        `${pkg.tag} release`,
      );
      if (pkg.id !== "extension")
        await waitFor(
          () => registry(pkg.name, pkg.version),
          5 * 60_000,
          `${pkg.name}@${pkg.version} on npm`,
        );
      log(`${pkg.tag} succeeded.`);
    }
  }
}

if (import.meta.main) {
  release(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
