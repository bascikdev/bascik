import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  analyzeComponentSource,
  type ComponentMetadata,
} from './component-metadata.js';

export interface ProjectSnapshot {
  projectRoot: string;
  componentRoots: string[];
  componentMap: Map<string, string>;
  componentMetadata: Map<string, ComponentMetadata>;
  importRoot: string;
  htmlUsageByFile: Map<string, string>;
}

const CONFIG_FILE_CANDIDATES = [
  'bascik.config.ts',
  'bascik.config.js',
  'bascik.config.mjs',
];
const DEFAULT_COMPONENT_ROOTS = ['src/components'];
const DEFAULT_IMPORT_ROOT = 'src';

export function normalizeComponentName(name: string): string {
  return (
    name
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.html$/i, '')
      .toLowerCase() ?? ''
  );
}

export function parseComponentRoots(source: string | undefined): string[] {
  if (!source) return DEFAULT_COMPONENT_ROOTS;
  const match = /\bcomponents\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(source);
  if (!match?.[1]) return DEFAULT_COMPONENT_ROOTS;
  const literals = Array.from(
    match[1].matchAll(/['"]([^'"]+)['"]/g),
    (item) => item[1],
  );
  return literals.length > 0 ? literals : DEFAULT_COMPONENT_ROOTS;
}

export function parseImportRoot(source: string | undefined): string {
  return (
    /importRoot\s*:\s*['"]([^'"]+)['"]/.exec(source ?? '')?.[1] ??
    DEFAULT_IMPORT_ROOT
  );
}

export async function readConfigSource(
  workspaceRoot: string,
): Promise<string | undefined> {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(workspaceRoot, candidate);
    try {
      return await fsPromises.readFile(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    }
  }
  return undefined;
}

export function resolveComponentRoots(
  workspaceRoot: string,
  configuredRoots: string[],
): string[] {
  return configuredRoots.map((root) =>
    path.resolve(workspaceRoot, root).replace(/\\/g, '/').replace(/\/+$/, ''),
  );
}

export function isInsideComponentRoots(fsPath: string, roots: string[]): boolean {
  const normalized = fsPath.replace(/\\/g, '/');
  return roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

export async function findHtmlFiles(roots: string[]): Promise<string[]> {
  const files: string[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

export async function buildSnapshot(workspaceRoot: string): Promise<ProjectSnapshot> {
  const configSource = await readConfigSource(workspaceRoot);
  const componentRoots = resolveComponentRoots(
    workspaceRoot,
    parseComponentRoots(configSource),
  );
  const componentFiles = await findHtmlFiles(componentRoots);
  const componentMap = new Map<string, string>();
  for (const filePath of componentFiles) {
    const name = normalizeComponentName(filePath);
    if (name) componentMap.set(name, filePath);
  }
  const componentMetadata = new Map<string, ComponentMetadata>();
  await Promise.all(
    Array.from(componentMap, async ([name, filePath]) => {
      try {
        const source = await fsPromises.readFile(filePath, 'utf8');
        componentMetadata.set(
          name,
          analyzeComponentSource(source, {
            hasCompanionStyles: fs.existsSync(
              filePath.replace(/\.html$/i, '.css'),
            ),
          }),
        );
      } catch {
        // Ignored if file changed or unreadable
      }
    }),
  );

  const htmlUsageByFile = new Map<string, string>();
  const usageFiles = await findHtmlFiles([path.join(workspaceRoot, 'src')]);
  await Promise.all(
    usageFiles.map(async (filePath) => {
      try {
        htmlUsageByFile.set(
          filePath,
          await fsPromises.readFile(filePath, 'utf8'),
        );
      } catch {
        // Ignored
      }
    }),
  );

  return {
    projectRoot: path.resolve(workspaceRoot),
    componentRoots,
    componentMap,
    componentMetadata,
    importRoot: path.resolve(workspaceRoot, parseImportRoot(configSource)),
    htmlUsageByFile,
  };
}

export function isPathInside(fsPath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(fsPath));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function htmlSuppliesComponentProp(
  html: string,
  componentName: string,
  propName: string,
): boolean {
  const escapedComponentName = componentName.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&',
  );
  const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const usageRegex = new RegExp(
    `<${escapedComponentName}(?![\\w-])(?:[^>"']|"[^"]*"|'[^']*')*>`,
    'gi',
  );
  const propRegex = new RegExp(
    `\\sdata-bascik-prop-${escapedPropName}\\s*=`,
    'i',
  );
  return Array.from(html.matchAll(usageRegex)).some((match) =>
    propRegex.test(match[0]),
  );
}
