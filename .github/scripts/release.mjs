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
    id: "netlify",
    dir: "adapters/netlify",
    prefix: "adapter-netlify-v",
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
      "Usage: yarn release [pkg lsp create cloudflare netlify extension] [--dry-run] [--extension-pre] [--latest]\n" +
        "Default: release all six artifacts. Versions come from origin/main.\n" +
        "--extension-pre selects the Marketplace pre-release channel.\n" +
        "--latest prints npm dist-tag commands for selected packages without releasing.",
    );
    return;
  }
  const dryRun = args.includes("--dry-run");
  const extensionPre = args.includes("--extension-pre");
  const latest = args.includes("--latest");
  const options = ["--dry-run", "--extension-pre", "--latest"];
  const ids = args.filter((arg) => !options.includes(arg));
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
  if (latest) {
    const npmPackages = plan.filter((pkg) => pkg.id !== "extension");
    if (!npmPackages.length)
      throw new Error("--latest requires selecting at least one npm package.");
    log(
      "Run these commands to set the selected npm package versions to latest:",
    );
    for (const pkg of npmPackages)
      log(
        `npm dist-tag add ${pkg.name}@${pkg.version} latest --registry https://registry.npmjs.org`,
      );
    return;
  }

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

  // One extension version ships to one Marketplace channel. The stable and
  // pre-release uploads must use distinct versions, so a plan for one channel
  // is refused when the other channel's tag for the same version is on origin.
  const extension = plan.find((pkg) => pkg.id === "extension");
  if (extension) {
    const other = extensionPre ? "ext-v" : "ext-pre-v";
    const otherTag = `${other}${extension.version}`;
    if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/${otherTag}`]))
      throw new Error(
        `${otherTag} already exists on origin, so ${extension.tag} would upload ${extension.version} to the other Marketplace channel. Bump the extension version (an even minor is stable, an odd minor is pre-release) instead.`,
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
