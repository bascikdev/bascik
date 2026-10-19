#!/usr/bin/env node
// One verification loop for a Bascik project: bascik --check (which includes the language server's per-file checks
// when it is installed), the linter on component folders outside the project, and optionally a build.
import { parseArgs } from "node:util";
import { isAbsolute, relative, sep } from "node:path";
import {
  componentRoots,
  fail,
  findPackageBin,
  findProjectRoot,
  installedVersion,
  isMain,
  loadProjectConfig,
  run,
} from "./lib/project.mjs";

const HELP = `Usage: node verify.mjs [--build] [--strict] [--npx]

Runs, from the project root:
  1. bascik --check                       the project checks (config, routes, components) and, when
                                          @bascik/language-server is installed, the per-file checks too
                                          (scoping patterns, unclosed tags, misplaced directives)
  2. bascik-language-server --check       each directory.components root outside the project, such as a
                                          monorepo's shared components, which bascik --check does not
                                          reach. Also the project itself, when step 1 had to skip its
                                          per-file checks
  3. bascik --build (with --build)        a full production build

Uses the project's installed packages. Exits nonzero when any step fails.

Options:
  --build    Also run a production build (needs a site URL unless sitemap and robots are disabled)
  --strict   Pass --strict to bascik --check so warnings fail
  --npx      Run the language server through npx when it is not installed locally
  --help     Show this message`;

const SITE_URL_HINT =
  "Hint: a production build needs a site URL for sitemap.xml and robots.txt. Set BASCIK_SITE_URL=https://example.com, pass --site-url, or add it to .env. Never put siteUrl in bascik.config.ts.";

/**
 * Component roots outside the project directory. The linter only scans below the directory it runs in, so shared
 * roots such as ../../shared/components need their own pass. Exported for tests.
 */
export function externalComponentRoots(root, roots) {
  return roots.filter((dir) => {
    const rel = relative(root, dir);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  });
}

function report(title, result) {
  const status = result.skipped ? "SKIP" : result.code === 0 ? "PASS" : "FAIL";
  console.log(
    `\n== ${status}  ${title}${result.skipped ? `  (${result.skipped})` : ""}`,
  );
  const output = (result.output ?? "").trim();
  if (output) console.log(output);
  if (status === "FAIL" && /site ?url/i.test(output))
    console.log(`\n${SITE_URL_HINT}`);
  return status;
}

export function integratedPerFileChecksCompleted(output) {
  return /\b\d+ files? checked by @bascik\/language-server\b/.test(output);
}

async function main() {
  const { values } = parseArgs({
    options: {
      build: { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      npx: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = findProjectRoot();
  const bascik = findPackageBin(root, "@bascik/bascik", "bascik");
  if (!bascik)
    fail(
      `verify: @bascik/bascik is not installed in ${root}. Run npm install first.`,
    );
  console.log(
    `Project: ${root}\n@bascik/bascik ${installedVersion(root, "@bascik/bascik") ?? "(unknown version)"}`,
  );

  const options = { cwd: root, env: { ...process.env } };
  const statuses = [];

  const checkArgs = [bascik, "--check", ...(values.strict ? ["--strict"] : [])];
  const checked = await run(process.execPath, checkArgs, options);
  statuses.push(
    report(`bascik --check${values.strict ? " --strict" : ""}`, checked),
  );

  const lsp = findPackageBin(
    root,
    "@bascik/language-server",
    "bascik-language-server",
  );
  const config = await loadProjectConfig(root);
  const external = externalComponentRoots(
    root,
    componentRoots(root, config?.module),
  );
  // Only skip the project linter when the output confirms its per-file checks ran; older Bascik releases do not
  // report whether they ran them.
  const perFileChecksCompleted = integratedPerFileChecksCompleted(
    checked.output ?? "",
  );
  const lintTargets = [
    ...(!perFileChecksCompleted ? [undefined] : []),
    ...external,
  ];
  const label = (target) =>
    `bascik-language-server --check${target ? ` ${relative(root, target)}` : ""}`;
  // --project makes the linter read this project's config for a folder outside it, so shared components are
  // checked as components. The target stays last so an older linter that ignores --project still checks it.
  const lintArgs = (target) => [
    "--check",
    ...(target ? ["--project", root, target] : []),
  ];
  if (lintTargets.length === 0) {
    // Nothing for the linter to add: bascik --check covered the project, and no component root lies outside it.
  } else if (lsp) {
    for (const target of lintTargets) {
      statuses.push(
        report(
          label(target),
          await run(process.execPath, [lsp, ...lintArgs(target)], options),
        ),
      );
    }
  } else if (values.npx) {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    for (const target of lintTargets) {
      const args = ["--yes", "@bascik/language-server", ...lintArgs(target)];
      statuses.push(
        report(
          `npx ${label(target).replace("bascik-language-server", "@bascik/language-server")}`,
          await run(npx, args, {
            ...options,
            shell: process.platform === "win32",
          }),
        ),
      );
    }
  } else {
    statuses.push(
      report("bascik-language-server --check", {
        skipped:
          "not installed; npm install -D @bascik/language-server, or rerun with --npx",
      }),
    );
  }

  if (values.build) {
    statuses.push(
      report(
        "bascik --build",
        await run(process.execPath, [bascik, "--build"], options),
      ),
    );
  }

  const failed = statuses.filter((s) => s === "FAIL").length;
  console.log(
    `\n${failed === 0 ? "All checks passed." : `${failed} check${failed === 1 ? "" : "s"} failed.`}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) await main();
