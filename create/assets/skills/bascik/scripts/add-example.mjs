#!/usr/bin/env node
// Copy an example component or site from https://bascik.dev/example-components into the current Bascik project.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { componentRoots, docsBaseUrl, fail, findProjectRoot, isMain, loadProjectConfig, pagesDirectory } from './lib/project.mjs';
import { listComponents } from './lib/components.mjs';

const HELP = `Usage: node add-example.mjs --list
       node add-example.mjs <example>[/<path>] [...more] [--dry-run] [--force]

Copies examples from https://bascik.dev/example-components into this project. Every example is tested with the real compiler
and in a browser before it is published.

References:
  tab-group                          a component, into your first component folder
  starter-site                       a whole example site
  starter-site/src/lib/seo.ts        one file of a site
  starter-site/src/pages/blog        a folder of a site

Copying site files also copies the components they use, from the site or from the example components.
Site files map to your config's folders:
src/components -> first directory.components root, src/pages -> directory.pages, src/lib -> <scripts.importRoot>/lib,
src/api -> directory.api, and anything else (scripts/, content/) to the same path under the project root.
bascik.config.ts, package.json, and README.md are printed, never copied: merge them by hand.

Nothing is written when any file would overwrite a different existing file, unless you pass --force.

Options:
  --list            List every example
  --dry-run         Show what would be copied without writing
  --force           Overwrite files that exist and differ
  --source <where>  Read the examples from a URL or a local examples.json (default: <docs>/assets/examples.json)
  --help            Show this message

Environment:
  BASCIK_DOCS_URL   Docs origin (default https://bascik.dev)`;

const REFERENCE_ONLY = new Set(['bascik.config.ts', 'bascik.config.js', 'package.json', 'README.md']);

/** Load the examples bundle from a URL or a local file. Exported for tests. */
export async function loadBundle(source = `${docsBaseUrl()}/assets/examples.json`) {
  let text;
  if (/^https?:\/\//i.test(source)) {
    let response;
    try {
      response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new Error(`could not reach ${source}: ${error.message}. Check the network, or pass --source <examples.json>.`);
    }
    if (!response.ok) throw new Error(`${source} returned HTTP ${response.status}`);
    text = await response.text();
  } else {
    text = readFileSync(resolve(source), 'utf8');
  }
  const bundle = JSON.parse(text);
  if (bundle?.version !== 1 || !Array.isArray(bundle.examples)) {
    throw new Error(`${source} is not a supported examples bundle (version ${bundle?.version}). Update the skills.`);
  }
  return bundle;
}

/**
 * Where a file of an example lands in the project, or undefined for files that are only printed.
 * `layout` holds absolute paths: root, componentRoot, pagesDir, importRoot, apiDir. Exported for tests.
 */
export function destinationFor(example, filePath, layout) {
  const segments = filePath.split('/');
  if (isAbsolute(filePath) || segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw new Error(`unsafe path in the examples bundle: ${filePath}`);
  }
  if (example.kind === 'component') return join(layout.componentRoot, example.name, filePath);
  if (REFERENCE_ONLY.has(filePath)) return undefined;
  const [first, second, ...rest] = filePath.split('/');
  if (first === 'src') {
    const tail = rest.join('/');
    if (second === 'components') return join(layout.componentRoot, tail);
    if (second === 'pages') return join(layout.pagesDir, tail);
    if (second === 'api') return join(layout.apiDir, tail);
    return join(layout.importRoot, second, tail);
  }
  return join(layout.root, filePath);
}

/**
 * The files a reference selects, plus the example components those files use. Returns
 * [{ example, file }] with each file once. Throws on an unknown reference. Exported for tests.
 */
export function selectFiles(bundle, references) {
  const byName = new Map(bundle.examples.map((example) => [example.name, example]));
  const picked = new Map();
  const add = (example, file) => picked.set(`${example.name}/${file.path}`, { example, file });
  // [example the using file belongs to, component name]
  const queue = [];
  for (const reference of references) {
    const [name, ...rest] = reference.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    const example = byName.get(name);
    if (!example) {
      const names = bundle.examples.map((e) => e.name).join(', ');
      throw new Error(`no example named "${name}". Available: ${names}`);
    }
    const path = rest.join('/');
    const files = path ? example.files.filter((file) => file.path === path || file.path.startsWith(`${path}/`)) : example.files;
    if (files.length === 0) throw new Error(`${name} has no file or folder "${path}". Run with --list, or see ${example.docs}`);
    for (const file of files) {
      add(example, file);
      queue.push(...file.uses.map((name) => [example, name]));
    }
  }
  const seen = new Set();
  while (queue.length) {
    const [owner, name] = queue.shift();
    // A site's own src/components/<name>/ wins over the example component of the same name.
    const local = owner.kind === 'site' ? owner.files.filter((file) => new RegExp(`^src/components/(?:.*/)?${name}/`).test(file.path)) : [];
    const [example, files] = local.length ? [owner, local] : [byName.get(name), byName.get(name)?.files ?? []];
    const key = `${example?.name}:${name}`;
    if (!example || seen.has(key)) continue;
    seen.add(key);
    for (const file of files) {
      add(example, file);
      queue.push(...file.uses.map((used) => [example, used]));
    }
  }
  return [...picked.values()];
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      list: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      source: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || (!values.list && positionals.length === 0)) return console.log(HELP);

  let bundle;
  try {
    bundle = await loadBundle(values.source);
  } catch (error) {
    fail(`add-example: ${error.message}`);
  }
  // An example's docs link is a docs path, or a full URL for examples without a docs page (sites link to GitHub).
  const docsLink = (example) => new URL(example.docs, `${docsBaseUrl()}/`).href;

  if (values.list) {
    for (const kind of ['component', 'site']) {
      const examples = bundle.examples.filter((example) => example.kind === kind);
      if (!examples.length) continue;
      console.log(`\n${kind === 'component' ? 'Components' : 'Sites'}`);
      for (const example of examples) {
        const firstSentence = example.description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? example.description;
        console.log(`  ${example.name.padEnd(16)} ${firstSentence}`);
        console.log(`  ${''.padEnd(16)} ${docsLink(example)}`);
      }
    }
    return;
  }

  const root = findProjectRoot();
  const config = await loadProjectConfig(root);
  if (config?.error) fail(`add-example: could not load ${config.path}: ${config.error.message}`);
  const directory = config?.module?.default?.directory ?? {};
  const roots = componentRoots(root, config?.module);
  const layout = {
    root,
    componentRoot: roots[0],
    pagesDir: pagesDirectory(root, config?.module),
    importRoot: resolve(root, config?.module?.default?.scripts?.importRoot ?? 'src'),
    apiDir: resolve(root, directory.api ?? 'src/api'),
  };

  let selected;
  try {
    selected = selectFiles(bundle, positionals);
  } catch (error) {
    fail(`add-example: ${error.message}`);
  }

  const existingComponents = listComponents(roots, root);
  const plan = [];
  const printed = [];
  for (const { example, file } of selected) {
    let destination;
    try {
      destination = destinationFor(example, file.path, layout);
    } catch (error) {
      fail(`add-example: ${error.message}`);
    }
    if (!destination) {
      if (file.path !== 'README.md') printed.push({ example, file });
      continue;
    }
    if (destination.endsWith('.html') && example.kind === 'component' && file.path === `${example.name}.html`) {
      const clash = existingComponents.find((c) => c.tag === example.name && resolve(root, c.file) !== destination);
      if (clash) {
        const same = readFileSync(resolve(root, clash.file), 'utf8') === file.content;
        if (same) {
          console.log(`same  ${clash.file}  (already in the project)`);
          continue;
        }
        fail(`add-example: a component named <${example.name}> already exists at ${clash.file}. Rename one of them first.`);
      }
    }
    plan.push({ example, file, destination });
  }

  const show = (path) => relative(root, path).replace(/\\/g, '/');
  const conflicts = plan.filter(({ file, destination }) => existsSync(destination) && readFileSync(destination, 'utf8') !== file.content);
  if (conflicts.length && !values.force) {
    const list = conflicts.map(({ example, file, destination }) => `  ${show(destination)}  (compare with ${docsLink(example)}, file ${file.path})`);
    fail(`add-example: these files already exist and differ; nothing was written. Merge by hand, or rerun with --force:\n${list.join('\n')}`);
  }

  let written = 0;
  for (const { file, destination } of plan) {
    if (existsSync(destination) && readFileSync(destination, 'utf8') === file.content) {
      console.log(`same  ${show(destination)}`);
      continue;
    }
    console.log(`${values['dry-run'] ? 'would' : 'write'} ${show(destination)}`);
    if (values['dry-run']) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
    written++;
  }

  for (const { example, file } of printed) {
    console.log(`\n--- ${example.name}/${file.path} (not copied: merge what you need by hand) ---\n${file.content.trimEnd()}`);
  }
  const packageJson = printed.find(({ file }) => file.path === 'package.json');
  if (packageJson) {
    const wanted = Object.keys(JSON.parse(packageJson.file.content).dependencies ?? {});
    const projectPackage = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
    const have = new Set([...Object.keys(projectPackage.dependencies ?? {}), ...Object.keys(projectPackage.devDependencies ?? {})]);
    const missing = wanted.filter((name) => !have.has(name));
    if (missing.length) console.log(`\nInstall the dependencies this example uses: npm install ${missing.join(' ')}`);
  }
  if (!values['dry-run']) console.log(`\n${written} file${written === 1 ? '' : 's'} written. Read each file's comments for setup steps.`);
}

if (isMain(import.meta.url)) await main();
