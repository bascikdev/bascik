#!/usr/bin/env node
// Map every Bascik site in a repository and the shared component and helper folders they read, then report the
// problems that only show up across sites. Dependency-free; Node.js 22.18+. Run from the repository root.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const HELP = `Usage: node check-workspace.mjs [dir] [--json]

Finds every Bascik site below dir (default: the current directory): a folder with bascik.config.{js,ts,mjs}, or a
package.json that depends on @bascik/bascik next to a pages folder. For each site it resolves directory.components,
scripts.importRoot, pipeline.watchPaths, and base, then reports:

  error  two components with the same tag across one site's component roots
  error  nested or repeated component roots
  error  a component build or server script imports @/... and the file does not exist under that site's importRoot
  warn   a helper folder outside the site (importRoot) that pipeline.watchPaths does not cover, so dev edits do not
         rebuild pages
  warn   sites resolving different @bascik/bascik versions
  info   the first component root is shared, so bascik add and new-component.mjs write into the shared folder

Exit code 1 when there are errors.

Options:
  --json   Print JSON
  --help   Show this message`;

const CONFIG_FILES = ['bascik.config.js', 'bascik.config.ts', 'bascik.config.mjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor']);
const MAX_DEPTH = 6;

const toPosix = (path) => path.split(sep).join('/');
const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const dependsOnBascik = (pkg) =>
  ['dependencies', 'devDependencies'].some((field) => pkg?.[field] && Object.hasOwn(pkg[field], '@bascik/bascik'));

/** Directories below `root` that are Bascik sites. Exported for tests. */
export function discoverSites(root) {
  const sites = [];
  const walk = (dir, depth) => {
    const hasConfig = CONFIG_FILES.some((file) => existsSync(join(dir, file)));
    const pkg = readJson(join(dir, 'package.json'));
    if (hasConfig || (dependsOnBascik(pkg) && existsSync(join(dir, 'src/pages')))) {
      sites.push(dir);
      return; // A site does not contain other sites.
    }
    if (depth >= MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(resolve(root), 0);
  return sites.sort();
}

function htmlFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDirectory) htmlFiles(full, out);
    else if (entry.name.toLowerCase().endsWith('.html')) out.push(full);
  }
  return out;
}

/** `@/...` specifiers imported by build, server, stream, and routes scripts in an HTML file. Exported for tests. */
export function aliasImports(html) {
  const specifiers = [];
  for (const script of html.matchAll(/<script\b[^>]*\bdata-bascik-(?:build|server|stream|routes)\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of script[1].matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](@\/[^"']+)["']/g)) specifiers.push(m[1]);
  }
  return [...new Set(specifiers)];
}

function findInstalledVersion(dir) {
  let current = dir;
  while (true) {
    const pkg = readJson(join(current, 'node_modules/@bascik/bascik/package.json'));
    if (pkg?.version) return pkg.version;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Load one site's config and file inventory. */
async function describeSite(dir) {
  let config = {};
  let configError;
  const configFile = CONFIG_FILES.map((file) => join(dir, file)).find((path) => existsSync(path));
  if (configFile) {
    try {
      config = (await import(pathToFileURL(configFile).href)).default ?? {};
    } catch (error) {
      configError = error.message;
    }
  }
  const list = (value, fallback) => (value === undefined ? fallback : Array.isArray(value) ? value : [value]);
  const componentRoots = list(config.directory?.components, ['src/components']).map((path) => resolve(dir, path));
  const importRoot = resolve(dir, config.scripts?.importRoot ?? 'src');
  return {
    dir,
    configFile,
    configError,
    base: typeof config.base === 'string' ? config.base : '/',
    pagesDir: resolve(dir, config.directory?.pages ?? 'src/pages'),
    componentRoots,
    importRoot,
    watchPaths: list(config.pipeline?.watchPaths, []).map((path) => resolve(dir, path)),
    version: findInstalledVersion(dir),
    components: componentRoots.flatMap((root) =>
      htmlFiles(root).map((file) => ({ root, file, tag: basename(file).replace(/\.html$/i, '').toLowerCase(), imports: aliasImports(readFileSync(file, 'utf8')) })),
    ),
  };
}

/** Cross-site findings for described sites. `exists` is injectable for tests. Exported for tests. */
export function analyzeSites(sites, { repoRoot, exists = existsSync } = {}) {
  const findings = [];
  const show = (path) => toPosix(relative(repoRoot ?? process.cwd(), path)) || '.';
  const add = (level, site, message) => findings.push({ level, site: show(site.dir), message });

  for (const site of sites) {
    if (site.configError) add('error', site, `could not load ${basename(site.configFile)}: ${site.configError}`);

    site.componentRoots.forEach((root, index) => {
      site.componentRoots.forEach((other, otherIndex) => {
        if (index === otherIndex) return;
        if (root === other && index < otherIndex) add('error', site, `component root ${show(root)} is listed twice`);
        else if (root !== other && isInside(other, root)) add('error', site, `component root ${show(other)} is inside ${show(root)}; list only one of them`);
      });
    });

    const byTag = new Map();
    for (const component of site.components) byTag.set(component.tag, [...(byTag.get(component.tag) ?? []), component.file]);
    for (const [tag, files] of byTag) {
      if (files.length > 1) add('error', site, `<${tag}> is defined ${files.length} times: ${files.map(show).join(', ')}. Tag names come from file names, so rename one`);
    }

    for (const component of site.components) {
      for (const specifier of component.imports) {
        const target = join(site.importRoot, specifier.slice(2));
        if (!exists(target)) {
          add('error', site, `${show(component.file)} imports ${specifier}, which resolves to ${show(target)} for this site and does not exist. Use a relative import (./ or ../) in shared components, or point scripts.importRoot at the shared folder`);
        }
      }
    }

    if (!isInside(site.importRoot, site.dir)) {
      const watched = site.watchPaths.some((path) => isInside(site.importRoot, path) || isInside(path, site.importRoot));
      if (!watched) add('warn', site, `scripts.importRoot ${show(site.importRoot)} is outside the site and not in pipeline.watchPaths, so editing a shared helper does not rebuild pages in dev`);
    }

    const [first] = site.componentRoots;
    if (first && !isInside(first, site.dir) && site.componentRoots.length > 1) {
      add('info', site, `the first component root is shared (${show(first)}), so bascik add, new-component.mjs, and add-example.mjs write there. List the site's own root first to keep new components local`);
    }
  }

  const versions = new Map();
  for (const site of sites) if (site.version) versions.set(site.version, [...(versions.get(site.version) ?? []), show(site.dir)]);
  if (versions.size > 1) {
    findings.push({ level: 'warn', site: '(repository)', message: `sites resolve different @bascik/bascik versions: ${[...versions].map(([v, s]) => `${v} (${s.join(', ')})`).join('; ')}` });
  }

  const sharedRoots = new Map();
  for (const site of sites) {
    for (const root of site.componentRoots) {
      if (!isInside(root, site.dir)) sharedRoots.set(root, [...(sharedRoots.get(root) ?? []), show(site.dir)]);
    }
  }
  return { findings, sharedRoots: [...sharedRoots].map(([root, users]) => ({ root: show(root), sites: users })) };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false } },
  });
  if (values.help) return console.log(HELP);

  const repoRoot = resolve(positionals[0] ?? '.');
  const sites = await Promise.all(discoverSites(repoRoot).map(describeSite));
  if (sites.length === 0) {
    process.stderr.write(`check-workspace: no Bascik sites found below ${repoRoot}.\n`);
    process.exit(1);
  }
  const { findings, sharedRoots } = analyzeSites(sites, { repoRoot });
  const show = (path) => toPosix(relative(repoRoot, path)) || '.';

  if (values.json) {
    const summary = sites.map((site) => ({
      dir: show(site.dir),
      base: site.base,
      version: site.version ?? null,
      componentRoots: site.componentRoots.map(show),
      importRoot: show(site.importRoot),
      components: site.components.length,
    }));
    console.log(JSON.stringify({ sites: summary, sharedRoots, findings }, null, 2));
  } else {
    console.log(`${sites.length} Bascik site${sites.length === 1 ? '' : 's'} in ${repoRoot}\n`);
    for (const site of sites) {
      console.log(`${show(site.dir)}  (base ${site.base}${site.version ? `, @bascik/bascik ${site.version}` : ''})`);
      console.log(`  components  ${site.componentRoots.map(show).join(', ')}  [${site.components.length}]`);
      console.log(`  @/ imports  ${show(site.importRoot)}`);
    }
    if (sharedRoots.length) {
      console.log('\nShared component roots');
      for (const shared of sharedRoots) console.log(`  ${shared.root}  used by ${shared.sites.join(', ')}`);
    }
    console.log('');
    for (const level of ['error', 'warn', 'info']) {
      for (const f of findings.filter((x) => x.level === level)) console.log(`  ${level.padEnd(5)}  ${f.site}  ${f.message}`);
    }
    console.log(findings.length ? '' : 'No workspace problems found.');
  }
  process.exitCode = findings.some((f) => f.level === 'error') ? 1 : 0;
}

const invokedDirectly = Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();
