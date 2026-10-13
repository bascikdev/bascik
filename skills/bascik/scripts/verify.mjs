#!/usr/bin/env node
// One verification loop for a Bascik project: bascik --check, the language server linter, and optionally a build.
import { parseArgs } from 'node:util';
import { fail, findPackageBin, findProjectRoot, installedVersion, isMain, run } from './lib/project.mjs';

const HELP = `Usage: node verify.mjs [--build] [--strict] [--npx]

Runs, from the project root:
  1. bascik --check                       pages, components, config, and API routes
  2. bascik-language-server --check       scoping patterns, unclosed tags, misplaced directives
  3. bascik --build (with --build)        a full production build

Uses the project's installed packages. Exits nonzero when any step fails.

Options:
  --build    Also run a production build (needs a site URL unless sitemap and robots are disabled)
  --strict   Pass --strict to bascik --check so warnings fail
  --npx      Run the language server through npx when it is not installed locally
  --help     Show this message`;

const SITE_URL_HINT =
  'Hint: a production build needs a site URL for sitemap.xml and robots.txt. Set BASCIK_SITE_URL=https://example.com, pass --site-url, or add it to .env. Never put siteUrl in bascik.config.ts.';

function report(title, result) {
  const status = result.skipped ? 'SKIP' : result.code === 0 ? 'PASS' : 'FAIL';
  console.log(`\n== ${status}  ${title}${result.skipped ? `  (${result.skipped})` : ''}`);
  const output = (result.output ?? '').trim();
  if (output) console.log(output);
  if (status === 'FAIL' && /site ?url/i.test(output)) console.log(`\n${SITE_URL_HINT}`);
  return status;
}

async function main() {
  const { values } = parseArgs({
    options: {
      build: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      npx: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) return console.log(HELP);

  const root = findProjectRoot();
  const bascik = findPackageBin(root, '@bascik/bascik', 'bascik');
  if (!bascik) fail(`verify: @bascik/bascik is not installed in ${root}. Run npm install first.`);
  console.log(`Project: ${root}\n@bascik/bascik ${installedVersion(root, '@bascik/bascik') ?? '(unknown version)'}`);

  const options = { cwd: root, env: { ...process.env } };
  const statuses = [];

  const checkArgs = [bascik, '--check', ...(values.strict ? ['--strict'] : [])];
  statuses.push(report(`bascik --check${values.strict ? ' --strict' : ''}`, await run(process.execPath, checkArgs, options)));

  const lsp = findPackageBin(root, '@bascik/language-server', 'bascik-language-server');
  if (lsp) {
    statuses.push(report('bascik-language-server --check', await run(process.execPath, [lsp, '--check'], options)));
  } else if (values.npx) {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    statuses.push(report('npx @bascik/language-server --check', await run(npx, ['--yes', '@bascik/language-server', '--check'], { ...options, shell: process.platform === 'win32' })));
  } else {
    statuses.push(report('bascik-language-server --check', { skipped: 'not installed; npm install -D @bascik/language-server, or rerun with --npx' }));
  }

  if (values.build) {
    statuses.push(report('bascik --build', await run(process.execPath, [bascik, '--build'], options)));
  }

  const failed = statuses.filter((s) => s === 'FAIL').length;
  console.log(`\n${failed === 0 ? 'All checks passed.' : `${failed} check${failed === 1 ? '' : 's'} failed.`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) await main();
