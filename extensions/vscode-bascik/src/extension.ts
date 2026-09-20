import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchCompatibilityRules } from './rules';
import { analyzeApiRouteSource } from './api-rules';
import { findModuleSpecifiers } from './module-specifiers';
import { analyzeServerScriptSource } from './server-script-rules';
import {
  analyzeComponentSource,
  type ComponentMetadata,
} from './component-metadata';

const BUILT_IN_HTML_ELEMENTS = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

function normalizeComponentName(name: string): string {
  return (
    name
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.html$/i, '')
      .toLowerCase() ?? ''
  );
}

const CONFIG_FILE_CANDIDATES = [
  'bascik.config.ts',
  'bascik.config.js',
  'bascik.config.mjs',
];
const DEFAULT_COMPONENT_ROOTS = ['src/components'];
const DEFAULT_IMPORT_ROOT = 'src';

interface ProjectSnapshot {
  componentRoots: string[];
  componentMap: Map<string, string>;
  componentMetadata: Map<string, ComponentMetadata>;
  importRoot: string;
  htmlUsageByFile: Map<string, string>;
}

type ProjectChangeKind = 'config' | 'components' | 'html';

/**
 * Read `directory.components` from the workspace's bascik.config file.
 *
 * This is a lexical (regex) read because the extension cannot execute a
 * TypeScript config. It accepts the same shapes as the runtime: a single
 * string or an array of strings. Values are relative to the project root and
 * may point outside it (monorepo shared components). Falls back to the runtime
 * default `['src/components']` when the config is missing or unparseable.
 */
function parseComponentRoots(source: string | undefined): string[] {
  if (!source) return DEFAULT_COMPONENT_ROOTS;
  const match = /\bcomponents\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(source);
  if (!match?.[1]) return DEFAULT_COMPONENT_ROOTS;
  const literals = Array.from(
    match[1].matchAll(/['"]([^'"]+)['"]/g),
    (item) => item[1],
  );
  return literals.length > 0 ? literals : DEFAULT_COMPONENT_ROOTS;
}

function parseImportRoot(source: string | undefined): string {
  return (
    /importRoot\s*:\s*['"]([^'"]+)['"]/.exec(source ?? '')?.[1] ??
    DEFAULT_IMPORT_ROOT
  );
}

async function readConfigSource(
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

function resolveComponentRoots(
  workspaceRoot: string,
  configuredRoots: string[],
): string[] {
  return configuredRoots.map((root) =>
    path.resolve(workspaceRoot, root).replace(/\\/g, '/').replace(/\/+$/, ''),
  );
}

function isInsideComponentRoots(fsPath: string, roots: string[]): boolean {
  const normalized = fsPath.replace(/\\/g, '/');
  return roots.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
}

async function findHtmlFiles(roots: string[]): Promise<string[]> {
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

async function buildSnapshot(workspaceRoot: string): Promise<ProjectSnapshot> {
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
        // The component watcher invalidates files changed during this scan.
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
        // The watcher will invalidate a file that changes during this scan.
      }
    }),
  );

  return {
    componentRoots,
    componentMap,
    componentMetadata,
    importRoot: path.resolve(workspaceRoot, parseImportRoot(configSource)),
    htmlUsageByFile,
  };
}

function htmlSuppliesComponentProp(
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

class ProjectState implements vscode.Disposable {
  private snapshotPromise: Promise<ProjectSnapshot> | undefined;
  private generation = 0;
  private disposed = false;
  private readonly staticWatchers: vscode.FileSystemWatcher[] = [];
  private componentWatchers: vscode.FileSystemWatcher[] = [];

  constructor(
    readonly folder: vscode.WorkspaceFolder,
    readonly projectRoot: string,
    private readonly onChange: (
      state: ProjectState,
      kind: ProjectChangeKind,
    ) => void,
  ) {
    const htmlWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(projectRoot, 'src/**/*.html'),
    );
    this.listen(htmlWatcher, 'html');
    this.staticWatchers.push(htmlWatcher);
  }

  async getSnapshot(): Promise<ProjectSnapshot> {
    if (!this.snapshotPromise) {
      const generation = this.generation;
      const pending = buildSnapshot(this.projectRoot).then((snapshot) => {
        if (this.disposed) return snapshot;
        if (generation !== this.generation) return this.getSnapshot();
        this.replaceComponentWatchers(snapshot.componentRoots);
        return snapshot;
      });
      this.snapshotPromise = pending;
    }
    return this.snapshotPromise;
  }

  invalidate(kind: ProjectChangeKind): void {
    this.generation++;
    this.snapshotPromise = undefined;
    if (kind === 'config') this.replaceComponentWatchers([]);
    this.onChange(this, kind);
  }

  componentUsageSuppliesProp(
    snapshot: ProjectSnapshot,
    componentName: string,
    propName: string,
  ): boolean {
    const openHtmlDocuments = vscode.workspace.textDocuments.filter(
      (document) =>
        document.languageId === 'html' &&
        document.uri.scheme === 'file' &&
        isPathInside(document.uri.fsPath, this.projectRoot),
    );
    const openPaths = new Set(
      openHtmlDocuments
        .filter((document) => document.uri.scheme === 'file')
        .map((document) => document.uri.fsPath),
    );
    return (
      openHtmlDocuments.some((document) =>
        htmlSuppliesComponentProp(document.getText(), componentName, propName),
      ) ||
      Array.from(snapshot.htmlUsageByFile).some(
        ([filePath, html]) =>
          !openPaths.has(filePath) &&
          htmlSuppliesComponentProp(html, componentName, propName),
      )
    );
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.snapshotPromise = undefined;
    this.replaceComponentWatchers([]);
    for (const watcher of this.staticWatchers) watcher.dispose();
  }

  private listen(
    watcher: vscode.FileSystemWatcher,
    kind: ProjectChangeKind,
  ): void {
    watcher.onDidCreate(() => this.invalidate(kind));
    watcher.onDidChange(() => this.invalidate(kind));
    watcher.onDidDelete(() => this.invalidate(kind));
  }

  private replaceComponentWatchers(roots: string[]): void {
    for (const watcher of this.componentWatchers) watcher.dispose();
    this.componentWatchers = roots.map((root) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '**/*.html'),
      );
      this.listen(watcher, 'components');
      return watcher;
    });
  }
}

class ProjectStateManager implements vscode.Disposable {
  private readonly states = new Map<string, ProjectState>();
  private readonly workspaceFoldersListener: vscode.Disposable;
  private readonly configWatchers = new Map<string, vscode.FileSystemWatcher>();

  constructor(
    private readonly onChange: (
      state: ProjectState,
      kind: ProjectChangeKind,
    ) => void,
    private readonly onRemove: (state: ProjectState) => void,
  ) {
    for (const folder of vscode.workspace.workspaceFolders ?? [])
      this.add(folder);
    this.workspaceFoldersListener =
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const folder of event.removed) this.remove(folder);
        for (const folder of event.added) this.add(folder);
      });
  }

  get(document: vscode.TextDocument): ProjectState | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== 'file') return undefined;
    this.discoverEnclosingProject(document.uri.fsPath, folder);
    return this.closestState(document.uri.fsPath, folder);
  }

  dispose(): void {
    this.workspaceFoldersListener.dispose();
    for (const watcher of this.configWatchers.values()) watcher.dispose();
    this.configWatchers.clear();
    for (const state of this.states.values()) state.dispose();
    this.states.clear();
  }

  private add(folder: vscode.WorkspaceFolder): void {
    this.addProject(folder, folder.uri.fsPath);
    const folderKey = folder.uri.toString();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '**/bascik.config.{ts,js,mjs}'),
    );
    watcher.onDidCreate((uri) => this.configCreated(folder, uri));
    watcher.onDidChange((uri) => this.configChanged(folder, uri));
    watcher.onDidDelete((uri) => this.configDeleted(folder, uri));
    this.configWatchers.set(folderKey, watcher);

    void vscode.workspace
      .findFiles(
        new vscode.RelativePattern(folder, '**/bascik.config.{ts,js,mjs}'),
        new vscode.RelativePattern(folder, '**/{node_modules,dist,.git}/**'),
      )
      .then((uris) => {
        if (this.configWatchers.get(folderKey) !== watcher) return;
        for (const uri of uris)
          this.addProject(folder, path.dirname(uri.fsPath));
      });
  }

  private remove(folder: vscode.WorkspaceFolder): void {
    const folderKey = folder.uri.toString();
    this.configWatchers.get(folderKey)?.dispose();
    this.configWatchers.delete(folderKey);
    for (const [key, state] of this.states) {
      if (state.folder.uri.toString() !== folderKey) continue;
      this.onRemove(state);
      state.dispose();
      this.states.delete(key);
    }
  }

  private addProject(
    folder: vscode.WorkspaceFolder,
    projectRoot: string,
  ): ProjectState {
    const normalizedRoot = path.resolve(projectRoot);
    const key = projectStateKey(folder, normalizedRoot);
    let state = this.states.get(key);
    if (!state) {
      state = new ProjectState(folder, normalizedRoot, this.onChange);
      this.states.set(key, state);
    }
    return state;
  }

  private closestState(
    fsPath: string,
    folder: vscode.WorkspaceFolder,
  ): ProjectState | undefined {
    let closest: ProjectState | undefined;
    for (const state of this.states.values()) {
      if (state.folder.uri.toString() !== folder.uri.toString()) continue;
      if (!isPathInside(fsPath, state.projectRoot)) continue;
      if (!closest || state.projectRoot.length > closest.projectRoot.length)
        closest = state;
    }
    return closest;
  }

  private discoverEnclosingProject(
    fsPath: string,
    folder: vscode.WorkspaceFolder,
  ): void {
    const workspaceRoot = path.resolve(folder.uri.fsPath);
    let directory = path.dirname(path.resolve(fsPath));
    while (isPathInside(directory, workspaceRoot)) {
      if (
        !isExcludedProjectPath(directory, workspaceRoot) &&
        CONFIG_FILE_CANDIDATES.some((candidate) =>
          fs.existsSync(path.join(directory, candidate)),
        )
      ) {
        this.addProject(folder, directory);
        return;
      }
      if (directory === workspaceRoot) return;
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }

  private configCreated(folder: vscode.WorkspaceFolder, uri: vscode.Uri): void {
    if (isExcludedProjectPath(uri.fsPath, folder.uri.fsPath)) return;
    this.addProject(folder, path.dirname(uri.fsPath)).invalidate('config');
  }

  private configChanged(folder: vscode.WorkspaceFolder, uri: vscode.Uri): void {
    if (isExcludedProjectPath(uri.fsPath, folder.uri.fsPath)) return;
    this.addProject(folder, path.dirname(uri.fsPath)).invalidate('config');
  }

  private configDeleted(folder: vscode.WorkspaceFolder, uri: vscode.Uri): void {
    if (isExcludedProjectPath(uri.fsPath, folder.uri.fsPath)) return;
    const projectRoot = path.dirname(uri.fsPath);
    if (
      CONFIG_FILE_CANDIDATES.some((candidate) =>
        fs.existsSync(path.join(projectRoot, candidate)),
      )
    ) {
      this.addProject(folder, projectRoot).invalidate('config');
      return;
    }
    if (path.resolve(projectRoot) === path.resolve(folder.uri.fsPath)) {
      this.addProject(folder, projectRoot).invalidate('config');
      return;
    }
    const key = projectStateKey(folder, projectRoot);
    const state = this.states.get(key);
    if (!state) return;
    this.onRemove(state);
    state.dispose();
    this.states.delete(key);
    this.closestState(projectRoot, folder)?.invalidate('config');
  }
}

function isPathInside(fsPath: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(fsPath));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function projectStateKey(
  folder: vscode.WorkspaceFolder,
  projectRoot: string,
): string {
  return `${folder.uri.toString()}\0${path.resolve(projectRoot)}`;
}

function isExcludedProjectPath(fsPath: string, workspaceRoot: string): boolean {
  const relativeParts = path
    .relative(path.resolve(workspaceRoot), path.resolve(fsPath))
    .split(path.sep);
  return relativeParts.some(
    (part) => part === 'node_modules' || part === 'dist' || part === '.git',
  );
}

class ComponentDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly projects: ProjectStateManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    if (document.languageId !== 'html') return undefined;
    const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9-]+/);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    if (!word || BUILT_IN_HTML_ELEMENTS.has(word.toLowerCase())) {
      return undefined;
    }

    const project = this.projects.get(document);
    if (!project) return undefined;
    return project.getSnapshot().then((snapshot) => {
      if (_token.isCancellationRequested) return undefined;
      const file = snapshot.componentMap.get(word.toLowerCase());
      return file
        ? new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0))
        : undefined;
    });
  }
}

class ComponentCompletionItemProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly projects: ProjectStateManager) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    if (document.languageId !== 'html') return undefined;

    const offset = document.offsetAt(position);
    const maskedSource = maskHtmlRawTextContents(document.getText()).replace(
      /<!--[\s\S]*?(?:-->|$)/g,
      (comment) => ' '.repeat(comment.length),
    );
    const sourceBeforeCursor = maskedSource.slice(0, offset);
    const tagMatch = /<([A-Za-z][\w-]*)?$/.exec(sourceBeforeCursor);
    if (!tagMatch) {
      const openTagMatch = /<([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*$/.exec(
        sourceBeforeCursor,
      );
      if (!openTagMatch) return undefined;
      const project = this.projects.get(document);
      if (!project) return undefined;
      return project.getSnapshot().then((snapshot) => {
        if (token.isCancellationRequested) return undefined;
        const currentTagName = openTagMatch[1].toLowerCase();
        const openTagText = openTagMatch[0];
        const currentTagStart = offset - openTagText.length;

        if (currentTagName === 'script') {
          return createScriptDirectiveCompletionItems(
            document,
            position,
            openTagText,
          );
        }

        const currentComponentMetadata =
          snapshot.componentMetadata.get(currentTagName);
        if (currentComponentMetadata) {
          return createPropCompletionItems(
            document,
            position,
            openTagText,
            currentComponentMetadata,
          );
        }

        const parentComponentName = findNearestParentComponent(
          maskedSource.slice(0, currentTagStart),
          snapshot.componentMap,
        );
        if (!parentComponentName) return undefined;
        const parentMetadata = snapshot.componentMetadata.get(
          parentComponentName,
        );
        if (!parentMetadata) return undefined;
        return createSlotCompletionItems(
          document,
          position,
          openTagText,
          parentMetadata,
        );
      });
    }
    const tagStart = offset - tagMatch[0].length;
    const sourceBeforeTag = sourceBeforeCursor.slice(0, tagStart);
    const previousTagStart = sourceBeforeTag.lastIndexOf('<');
    const previousTagEnd = sourceBeforeTag.lastIndexOf('>');
    if (previousTagStart > previousTagEnd) return undefined;

    const prefix = (tagMatch[1] ?? '').toLowerCase();
    const project = this.projects.get(document);
    if (!project) return undefined;

    const start = document.positionAt(offset - prefix.length);
    const replacementRange = new vscode.Range(start, position);

    return project.getSnapshot().then((snapshot) => {
      if (token.isCancellationRequested) return undefined;
      return Array.from(snapshot.componentMap)
        .filter(([componentName]) => componentName.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([componentName, componentPath]) => {
          const metadata = snapshot.componentMetadata.get(componentName);
          const item = new vscode.CompletionItem(
            componentName,
            vscode.CompletionItemKind.Class,
          );
          item.sortText = `0_${componentName}`;
          if (metadata?.defaultSlot) {
            item.range = new vscode.Range(
              document.positionAt(tagStart),
              replacementRange.end,
            );
            item.insertText = new vscode.SnippetString(
              `<${componentName}>$0</${componentName}>`,
            );
          } else {
            item.textEdit = vscode.TextEdit.replace(
              replacementRange,
              componentName,
            );
          }
          item.filterText = componentName;
          item.detail = 'Bascik component';
          const relativePath = path
            .relative(project.projectRoot, componentPath)
            .replace(/\\/g, '/');
          item.documentation = createComponentDocumentation(
            relativePath,
            metadata,
          );
          return item;
        });
    });
  }
}

const SCRIPT_DIRECTIVES = [
  {
    name: 'data-bascik-build',
    detail: 'Bascik build-time script',
    documentation:
      'Executes in Node.js at build time. Standard output from console.log() replaces this script tag in the generated HTML.',
  },
  {
    name: 'data-bascik-routes',
    detail: 'Bascik dynamic routes script',
    documentation:
      'Executes in Node.js at build time. Outputs a JSON array of dynamic route parameters to generate multiple pages from a template.',
  },
  {
    name: 'data-bascik-server',
    detail: 'Bascik server-side request script',
    documentation:
      'Executes in Node.js per request on production and dev servers. The default exported handler function replaces this script tag.',
  },
  {
    name: 'data-bascik-stream',
    detail: 'Bascik server-side streaming script',
    documentation:
      'Executes in Node.js per request on production servers. Streams chunked HTML responses to the client as data becomes available.',
  },
];

function createScriptDirectiveCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  openTagText: string,
): vscode.CompletionItem[] {
  const hasAnyDirective = SCRIPT_DIRECTIVES.some((dir) =>
    new RegExp(`\\b${dir.name}\\b`, 'i').test(openTagText),
  );
  if (hasAnyDirective) return [];

  const range = completionReplacementRange(document, position);
  return SCRIPT_DIRECTIVES.map((dir) => {
    const item = new vscode.CompletionItem(
      dir.name,
      vscode.CompletionItemKind.Property,
    );
    item.range = range;
    item.insertText = dir.name;
    item.sortText = `0_${dir.name}`;
    item.detail = dir.detail;
    item.documentation = new vscode.MarkdownString(dir.documentation);
    return item;
  });
}

function completionReplacementRange(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range {
  const offset = document.offsetAt(position);
  const prefix = /[^\s<>"'=]*$/.exec(document.getText().slice(0, offset))?.[0] ?? '';
  return new vscode.Range(document.positionAt(offset - prefix.length), position);
}

function createPropCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  openTagText: string,
  metadata: ComponentMetadata,
): vscode.CompletionItem[] {
  const range = completionReplacementRange(document, position);
  return metadata.props
    .filter(
      ({ name }) =>
        !new RegExp(`\\bdata-bascik-prop-${escapeRegExp(name)}\\s*=`, 'i').test(
          openTagText,
        ),
    )
    .map((prop) => {
      const attribute = `data-bascik-prop-${prop.name}`;
      const item = new vscode.CompletionItem(
        attribute,
        vscode.CompletionItemKind.Property,
      );
      item.range = range;
      item.insertText = new vscode.SnippetString(`${attribute}="$1"`);
      item.sortText = `0_${attribute}`;
      item.detail = 'Bascik component prop';
      if (prop.description) {
        const documentation = new vscode.MarkdownString();
        documentation.appendText(prop.description);
        item.documentation = documentation;
      }
      return item;
    });
}

function createSlotCompletionItems(
  document: vscode.TextDocument,
  position: vscode.Position,
  openTagText: string,
  metadata: ComponentMetadata,
): vscode.CompletionItem[] {
  if (/\bdata-bascik-slot(?:\s*=|\s|\/?>|$)/i.test(openTagText)) return [];
  const range = completionReplacementRange(document, position);
  return metadata.slots.map((slot) => {
    const item = new vscode.CompletionItem(
      `data-bascik-slot="${slot.name}"`,
      vscode.CompletionItemKind.Property,
    );
    item.range = range;
    item.insertText = `data-bascik-slot="${slot.name}"`;
    item.filterText = `data-bascik-slot ${slot.name}`;
    item.sortText = `0_data-bascik-slot_${slot.name}`;
    item.detail = 'Bascik named slot';
    if (slot.description) {
      const documentation = new vscode.MarkdownString();
      documentation.appendText(slot.description);
      item.documentation = documentation;
    }
    return item;
  });
}

function findNearestParentComponent(
  source: string,
  componentMap: Map<string, string>,
): string | undefined {
  const stack: string[] = [];
  const tagRegex = /<\/?([A-Za-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of source.matchAll(tagRegex)) {
    const name = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const matchingIndex = stack.lastIndexOf(name);
      if (matchingIndex >= 0) stack.splice(matchingIndex);
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(name);
    }
  }
  return stack.reverse().find((name) => componentMap.has(name));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createComponentDocumentation(
  relativePath: string,
  metadata: ComponentMetadata | undefined,
): vscode.MarkdownString {
  const documentation = new vscode.MarkdownString();
  if (metadata?.description) {
    documentation.appendText(metadata.description);
    documentation.appendMarkdown('\n\n');
  }
  documentation.appendMarkdown(`Bascik component from \`${relativePath}\`.`);
  if (metadata) {
    documentation.appendMarkdown('\n\n');
    appendMetadataMembers(documentation, 'Props', metadata.props);
    appendMetadataMembers(documentation, 'Slots', [
      ...metadata.slots,
      ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
    ]);
  }
  return documentation;
}

class ComponentHoverProvider implements vscode.HoverProvider {
  constructor(private readonly projects: ProjectStateManager) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9-]+/);
    if (!range) return undefined;
    const componentName = document.getText(range).toLowerCase();
    if (!componentName || BUILT_IN_HTML_ELEMENTS.has(componentName))
      return undefined;
    const project = this.projects.get(document);
    if (!project) return undefined;

    return project.getSnapshot().then((snapshot) => {
      if (token.isCancellationRequested) return undefined;
      const componentPath = snapshot.componentMap.get(componentName);
      if (!componentPath) return undefined;
      const metadata = snapshot.componentMetadata.get(componentName);
      if (!metadata) return undefined;
      const relativePath = path
        .relative(project.projectRoot, componentPath)
        .replace(/\\/g, '/');
      const details = new vscode.MarkdownString();
      details.appendMarkdown(`### \`<${componentName}>\`\n\n`);
      if (metadata.description) {
        details.appendText(metadata.description);
        details.appendMarkdown('\n\n');
      }
      details.appendMarkdown(
        `**Source:** [\`${relativePath}\`](${vscode.Uri.file(componentPath).toString()})\n\n`,
      );
      appendMetadataMembers(details, 'Props', metadata.props);
      appendMetadataMembers(details, 'Slots', [
        ...metadata.slots,
        ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
      ]);
      const features = [
        metadata.hasStyles ? 'styles' : '',
        metadata.hasScripts ? 'scripts' : '',
      ].filter(Boolean);
      if (features.length > 0)
        details.appendMarkdown(`**Includes:** ${features.join(', ')}`);
      return new vscode.Hover(details, range);
    });
  }
}

function appendMetadataMembers(
  markdown: vscode.MarkdownString,
  label: string,
  members: ComponentMetadata['props'],
): void {
  if (members.length === 0) return;
  markdown.appendMarkdown(`**${label}:**\n\n`);
  for (const member of members) {
    markdown.appendMarkdown(`- \`${member.name}\``);
    if (member.description) {
      markdown.appendMarkdown(': ');
      markdown.appendText(member.description);
    }
    markdown.appendMarkdown('\n');
  }
  markdown.appendMarkdown('\n');
}

const SCRIPT_BLOCK_RE =
  /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\s*>/gi;

/**
 * Resolve a script specifier or `src=` value the way Bascik's runtime does
 * (`pkg/src/lib/module-specifiers.ts`): `./` and `../` against the document's
 * directory, `@/` against the import root, and bare `src=` paths against the
 * document's directory. A leading `/` is a compile error in Bascik (see
 * `leadingSlashSpecifierMessage`) and returns no definition here.
 * Returns undefined for external specifiers (packages, `node:`, URLs).
 */
function resolveScriptTarget(
  value: string,
  documentDir: string,
  importRootAbs: string,
  kind: 'specifier' | 'src',
): string | undefined {
  if (value.startsWith('./') || value.startsWith('../'))
    return path.resolve(documentDir, value);
  if (value.startsWith('@/'))
    return path.resolve(importRootAbs, value.slice(2));
  if (value.startsWith('/')) return undefined;
  if (kind === 'src') {
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) return undefined;
    return path.resolve(documentDir, value);
  }
  return undefined;
}

/**
 * Mirrors `formatLeadingSlashMessage` in `pkg/src/lib/module-specifiers.ts`
 * so the editor and the compiler show the same wording.
 */
function leadingSlashSpecifierMessage(specifier: string): string {
  const rest = specifier.replace(/^\/+/, '');
  return (
    `Leading-slash specifier '${specifier}' is not supported in Bascik scripts. ` +
    `A bare '/' is ambiguous (filesystem root vs. site root). ` +
    `Use '@/${rest}' to resolve against scripts.importRoot, ` +
    `or './${rest}' to resolve relative to this file.`
  );
}

/**
 * Collect Error diagnostics for every leading-slash ESM specifier and `src=`
 * value inside `data-bascik-build`, `data-bascik-server`, and
 * `data-bascik-routes` script tags. Client `<script>` tags are skipped: a
 * leading slash there is an ordinary site-root URL.
 */
function collectLeadingSlashDiagnostics(
  document: vscode.TextDocument,
  openTag: string,
  scriptBody: string,
  blockStart: number,
  attrs: Map<string, string | true>,
): vscode.Diagnostic[] {
  if (
    !attrs.has('data-bascik-build') &&
    !attrs.has('data-bascik-server') &&
    !attrs.has('data-bascik-routes') &&
    !attrs.has('data-bascik-stream')
  ) {
    return [];
  }
  const out: vscode.Diagnostic[] = [];
  const push = (start: number, end: number, specifier: string) => {
    const diag = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      leadingSlashSpecifierMessage(specifier),
      vscode.DiagnosticSeverity.Error,
    );
    diag.source = 'bascik';
    diag.code = 'leading-slash-specifier';
    out.push(diag);
  };

  const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
    openTag,
  );
  if (srcMatch) {
    const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '';
    if (srcValue.startsWith('/')) {
      const valueStart =
        blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
      push(valueStart, valueStart + srcValue.length, srcValue);
    }
  }

  const bodyStart = blockStart + openTag.length;
  for (const { start, end, value } of findModuleSpecifiers(scriptBody)) {
    if (value.startsWith('/')) push(bodyStart + start, bodyStart + end, value);
  }
  return out;
}

function parseScriptOpenTagAttributes(
  openTag: string,
): Map<string, string | true> {
  const attrs = new Map<string, string | true>();
  const insideTag = openTag.replace(/^<script\b/i, '').replace(/>$/, '');
  const attrRe =
    /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(insideTag)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4];
    attrs.set(name, value === undefined ? true : value);
  }
  return attrs;
}

class ScriptImportDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly projects: ProjectStateManager) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
    if (document.languageId !== 'html') {
      return undefined;
    }

    const project = this.projects.get(document);
    if (!project) return undefined;
    return project.getSnapshot().then((snapshot) => {
      if (_token.isCancellationRequested) return undefined;
      return this.provideFromSnapshot(document, position, snapshot);
    });
  }

  private provideFromSnapshot(
    document: vscode.TextDocument,
    position: vscode.Position,
    snapshot: ProjectSnapshot,
  ): vscode.Definition | vscode.LocationLink[] | undefined {
    const text = document.getText();
    const offset = document.offsetAt(position);

    SCRIPT_BLOCK_RE.lastIndex = 0;
    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = SCRIPT_BLOCK_RE.exec(text)) !== null) {
      const openTag = scriptMatch[1];
      const scriptBody = scriptMatch[2] ?? '';
      const blockStart = scriptMatch.index ?? 0;
      const openTagEnd = blockStart + openTag.length;
      const blockEnd = blockStart + scriptMatch[0].length;
      if (offset < blockStart || offset > blockEnd) continue;

      const attrs = parseScriptOpenTagAttributes(openTag);
      if (
        !attrs.has('data-bascik-build') &&
        !attrs.has('data-bascik-server') &&
        !attrs.has('data-bascik-routes')
      ) {
        return undefined;
      }

      const baseDir = path.dirname(document.uri.fsPath);
      const importRootAbs = snapshot.importRoot;

      // Cursor inside the open tag: check for the src attribute value.
      if (offset >= blockStart && offset <= openTagEnd) {
        const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
          openTag,
        );
        if (!srcMatch) return undefined;
        const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '';
        if (!srcValue) return undefined;
        const valueStart =
          blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
        const valueEnd = valueStart + srcValue.length;
        if (offset < valueStart || offset > valueEnd) return undefined;
        const resolved = resolveScriptTarget(
          srcValue,
          baseDir,
          importRootAbs,
          'src',
        );
        if (!resolved || !fs.existsSync(resolved)) return undefined;
        const targetUri = vscode.Uri.file(resolved);
        const originSelectionRange = new vscode.Range(
          document.positionAt(valueStart),
          document.positionAt(valueEnd),
        );
        return [
          {
            originSelectionRange,
            targetUri,
            targetRange: new vscode.Range(0, 0, 0, 0),
          },
        ];
      }

      // Cursor inside the script body: inspect lexical ESM specifiers only.
      const bodyOffset = offset - openTagEnd;
      for (const { start, end, value: specifier } of findModuleSpecifiers(
        scriptBody,
      )) {
        if (bodyOffset < start || bodyOffset > end) continue;
        const resolved = resolveScriptTarget(
          specifier,
          baseDir,
          importRootAbs,
          'specifier',
        );
        if (!resolved || !fs.existsSync(resolved)) return undefined;
        const targetUri = vscode.Uri.file(resolved);
        const originSelectionRange = new vscode.Range(
          document.positionAt(openTagEnd + start),
          document.positionAt(openTagEnd + end),
        );
        return [
          {
            originSelectionRange,
            targetUri,
            targetRange: new vscode.Range(0, 0, 0, 0),
          },
        ];
      }

      return undefined;
    }

    return undefined;
  }
}

function findMatchingClose(
  html: string,
  tagName: string,
  contentStart: number,
): number {
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(`<${tn}[\\s>]`, 'gi');
  const closeRe = new RegExp(`<\\/${tn}>`, 'gi');
  let depth = 1;
  let pos = contentStart;
  while (pos < html.length) {
    openRe.lastIndex = pos;
    closeRe.lastIndex = pos;
    const openMatch = openRe.exec(html);
    const closeMatch = closeRe.exec(html);
    if (!closeMatch) return -1;
    if (!openMatch || closeMatch.index < openMatch.index) {
      depth--;
      if (depth === 0) return closeMatch.index;
      pos = closeMatch.index + closeMatch[0].length;
    } else {
      let inDoubleQuote = false;
      let inSingleQuote = false;
      let tagEnd = -1;
      for (let i = openMatch.index; i < html.length; i++) {
        const char = html[i];
        if (char === '"' && !inSingleQuote) {
          inDoubleQuote = !inDoubleQuote;
        } else if (char === "'" && !inDoubleQuote) {
          inSingleQuote = !inSingleQuote;
        } else if (char === '>' && !inDoubleQuote && !inSingleQuote) {
          tagEnd = i + 1;
          break;
        }
      }
      if (tagEnd !== -1) {
        const fullOpenTag = html.slice(openMatch.index, tagEnd);
        if (/\/\s*>$/.test(fullOpenTag)) {
          pos = tagEnd;
          continue;
        }
      }
      depth++;
      pos = openMatch.index + openMatch[0].length;
    }
  }
  return -1;
}

function maskHtmlRawTextContents(html: string): string {
  return html.replace(
    /(<(script|style|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (
      _match,
      openTag: string,
      _tagName: string,
      content: string,
      closeTag: string,
    ) => `${openTag}${' '.repeat(content.length)}${closeTag}`,
  );
}

async function createDiagnosticsForDocument(
  document: vscode.TextDocument,
  projects: ProjectStateManager,
): Promise<vscode.Diagnostic[]> {
  const { languageId } = document;

  if (
    languageId !== 'css' &&
    languageId !== 'javascript' &&
    languageId !== 'typescript' &&
    languageId !== 'html'
  ) {
    return [];
  }

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  const project = projects.get(document);
  const snapshot = project ? await project.getSnapshot() : undefined;
  const normalizedDocumentPath = document.uri.fsPath.replace(/\\/g, '/');
  const isComponentDocument =
    document.uri.scheme === 'file' &&
    snapshot !== undefined &&
    isInsideComponentRoots(normalizedDocumentPath, snapshot.componentRoots);
  const isApiRouteDocument =
    document.uri.scheme === 'file' &&
    normalizedDocumentPath.includes('/src/api/') &&
    (languageId === 'typescript' || languageId === 'javascript');

  if (isApiRouteDocument) {
    const apiDiags = analyzeApiRouteSource(text);
    for (const diag of apiDiags) {
      let severity = vscode.DiagnosticSeverity.Warning;
      if (diag.severity === 'error') {
        severity = vscode.DiagnosticSeverity.Error;
      } else if (diag.severity === 'info') {
        severity = vscode.DiagnosticSeverity.Information;
      }
      const start = new vscode.Position(0, 0);
      const end = new vscode.Position(0, Math.min(text.length, 10));
      const vdiag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        diag.message,
        severity,
      );
      vdiag.source = 'bascik';
      diagnostics.push(vdiag);
    }
  }

  // Warn if a component file name in any configured components root is not
  // hyphenated per WHATWG HTML §4.13
  if (languageId === 'html' && document.uri.scheme === 'file') {
    const fsPath = document.uri.fsPath.replace(/\\/g, '/');
    if (snapshot && isInsideComponentRoots(fsPath, snapshot.componentRoots)) {
      const fileName = path.basename(fsPath);
      const nameWithoutExt = fileName.replace(/\.html$/i, '').toLowerCase();
      if (
        !nameWithoutExt.includes('-') &&
        !BUILT_IN_HTML_ELEMENTS.has(nameWithoutExt)
      ) {
        const start = new vscode.Position(0, 0);
        const end = new vscode.Position(0, Math.min(text.length, 10));
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Component "${nameWithoutExt}" is not hyphenated. Under WHATWG HTML §4.13, custom elements should include a hyphen (e.g. "my-${nameWithoutExt}") to avoid collisions with future HTML standards.`,
          vscode.DiagnosticSeverity.Warning,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      }
    }
  }

  const addCompatibilityDiagnostics = (
    sourceText: string,
    kind: 'css' | 'js',
    offset: number,
  ) => {
    for (const rule of matchCompatibilityRules(sourceText, kind)) {
      const flags = rule.regex.flags.includes('g')
        ? rule.regex.flags
        : `${rule.regex.flags}g`;
      const regex = new RegExp(rule.regex.source, flags);
      const match = regex.exec(sourceText);
      if (!match || typeof match.index !== 'number') continue;
      const start = document.positionAt(offset + match.index);
      const end = document.positionAt(
        offset + match.index + Math.max(match[0].length, 1),
      );
      const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `${rule.message} ${rule.suggestion}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'bascik';
      diagnostics.push(diag);
    }
  };

  const isJavaScriptScriptTag = (openTag: string): boolean => {
    const attrs = parseScriptOpenTagAttributes(openTag);
    const typeValue = attrs.get('type');
    if (!typeValue || typeValue === true) return true;
    const normalized = String(typeValue).trim().toLowerCase();
    return (
      normalized === 'module' ||
      normalized === 'text/javascript' ||
      normalized === 'application/javascript' ||
      normalized === 'text/ecmascript' ||
      normalized === 'application/ecmascript'
    );
  };

  // Fresh instance: SCRIPT_BLOCK_RE is a global (`g`) regex shared with the
  // definition provider, and a stale lastIndex would silently skip blocks.
  const scriptBlockRe = new RegExp(
    SCRIPT_BLOCK_RE.source,
    SCRIPT_BLOCK_RE.flags,
  );
  const styleBlockRe =
    /(<style\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style\s*>/gi;

  if (languageId === 'html') {
    if (isComponentDocument) {
      const metadata = analyzeComponentSource(text, {
        hasCompanionStyles:
          document.uri.scheme === 'file' &&
          fs.existsSync(document.uri.fsPath.replace(/\.html$/i, '.css')),
      });
      for (const metadataDiagnostic of metadata.diagnostics) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(metadataDiagnostic.start),
            document.positionAt(metadataDiagnostic.end),
          ),
          metadataDiagnostic.message,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'bascik';
        diagnostic.code = metadataDiagnostic.code;
        diagnostics.push(diagnostic);
      }

      const referenceScanText = maskHtmlRawTextContents(text).replace(
        /<!--[\s\S]*?(?:-->|$)/g,
        (comment) => ' '.repeat(comment.length),
      );
      const declaredIds = new Set(
        Array.from(
          referenceScanText.matchAll(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi),
        )
          .map((match) => match[1] ?? match[2])
          .filter((id): id is string => Boolean(id)),
      );
      const idReferenceAttributeRegex =
        /\s(for|itemref|aria-activedescendant|aria-details|aria-errormessage|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-flowto)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      let idReferenceMatch: RegExpExecArray | null;
      while (
        (idReferenceMatch =
          idReferenceAttributeRegex.exec(referenceScanText)) !== null
      ) {
        const value = idReferenceMatch[2] ?? idReferenceMatch[3] ?? '';
        for (const id of value.trim().split(/\s+/).filter(Boolean)) {
          if (declaredIds.has(id)) continue;
          const valueOffset = idReferenceMatch[0].indexOf(id);
          const start = document.positionAt(
            idReferenceMatch.index + Math.max(valueOffset, 0),
          );
          const end = document.positionAt(
            idReferenceMatch.index + Math.max(valueOffset, 0) + id.length,
          );
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(start, end),
            `ID reference "${id}" is not declared in this component and will be left unscoped.`,
            vscode.DiagnosticSeverity.Information,
          );
          diagnostic.source = 'bascik';
          diagnostics.push(diagnostic);
        }
      }
      const fragmentReferenceRegex = /\shref\s*=\s*(?:"#([^"]+)"|'#([^']+)')/gi;
      let fragmentReferenceMatch: RegExpExecArray | null;
      while (
        (fragmentReferenceMatch =
          fragmentReferenceRegex.exec(referenceScanText)) !== null
      ) {
        const id = fragmentReferenceMatch[1] ?? fragmentReferenceMatch[2];
        if (!id || declaredIds.has(id)) continue;
        const idOffset = fragmentReferenceMatch[0].indexOf(id);
        const start = document.positionAt(
          fragmentReferenceMatch.index + Math.max(idOffset, 0),
        );
        const end = document.positionAt(
          fragmentReferenceMatch.index + Math.max(idOffset, 0) + id.length,
        );
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `ID reference "${id}" is not declared in this component and will be left unscoped.`,
          vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = 'bascik';
        diagnostics.push(diagnostic);
      }
    }

    const preserveDirectiveRegex =
      /data-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'))?/gi;
    let preserveMatch: RegExpExecArray | null;
    while ((preserveMatch = preserveDirectiveRegex.exec(text)) !== null) {
      if (preserveMatch[1] === undefined) continue;
      const value = preserveMatch[2] ?? preserveMatch[3] ?? '';
      for (const preserveToken of value.trim().split(/\s+/).filter(Boolean)) {
        if (
          preserveToken === 'id' ||
          preserveToken === 'name' ||
          preserveToken === 'class'
        )
          continue;
        const tokenOffset = preserveMatch[0].indexOf(preserveToken);
        const start = document.positionAt(
          preserveMatch.index + Math.max(tokenOffset, 0),
        );
        const end = document.positionAt(
          preserveMatch.index + Math.max(tokenOffset, 0) + preserveToken.length,
        );
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `Unknown data-bascik-preserve token "${preserveToken}". Valid tokens are id, name, and class.`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'bascik';
        diagnostics.push(diagnostic);
      }
    }

    const formOpenTagRegex = /<form\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    let formMatch: RegExpExecArray | null;
    while (
      isComponentDocument &&
      (formMatch = formOpenTagRegex.exec(text)) !== null
    ) {
      const actionMatch = formMatch[0].match(
        /\saction\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
      );
      const action = actionMatch?.[1] ?? actionMatch?.[2];
      if (!action || !/^(?:https?:)?\/\//i.test(action)) continue;
      const preserveMatch = formMatch[0].match(
        /\sdata-bascik-preserve(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/i,
      );
      const preservesName =
        preserveMatch !== null &&
        (preserveMatch[1] === undefined ||
          (preserveMatch[1] ?? preserveMatch[2] ?? '')
            .trim()
            .split(/\s+/)
            .includes('name'));
      if (preservesName) continue;
      const start = document.positionAt(formMatch.index);
      const end = document.positionAt(formMatch.index + formMatch[0].length);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(start, end),
        'External form actions require data-bascik-preserve="name" so submitted field names remain literal.',
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = 'bascik';
      diagnostics.push(diagnostic);
    }

    if (project && snapshot && isComponentDocument) {
      const componentName = normalizeComponentName(document.uri.fsPath);
      const directiveRegex =
        /data-bascik-attr-([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([\w-]+)"|'([\w-]+)')/gi;
      let directiveMatch: RegExpExecArray | null;
      while ((directiveMatch = directiveRegex.exec(text)) !== null) {
        const targetName = directiveMatch[1];
        const propName = directiveMatch[2] ?? directiveMatch[3];
        if (
          project.componentUsageSuppliesProp(snapshot, componentName, propName)
        )
          continue;
        const start = document.positionAt(directiveMatch.index);
        const end = document.positionAt(
          directiveMatch.index + directiveMatch[0].length,
        );
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `data-bascik-attr-${targetName} references prop "${propName}", but no <${componentName}> usage supplies data-bascik-prop-${propName}.`,
          vscode.DiagnosticSeverity.Warning,
        );
        diagnostic.source = 'bascik';
        diagnostics.push(diagnostic);
      }
    }

    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = scriptBlockRe.exec(text)) !== null) {
      const openTag = scriptMatch[1];
      const scriptBody = scriptMatch[2] ?? '';
      const scriptBodyOffset = (scriptMatch.index ?? 0) + openTag.length;
      const attrs = parseScriptOpenTagAttributes(openTag);

      const directiveAttrs = [
        'data-bascik-build',
        'data-bascik-server',
        'data-bascik-routes',
        'data-bascik-stream',
      ];
      const presentDirectives = directiveAttrs.filter((d) => attrs.has(d));
      for (let i = 0; i < presentDirectives.length; i++) {
        for (let j = i + 1; j < presentDirectives.length; j++) {
          const d1 = presentDirectives[i];
          const d2 = presentDirectives[j];
          let message: string;
          if (
            (d1 === 'data-bascik-build' && d2 === 'data-bascik-server') ||
            (d1 === 'data-bascik-server' && d2 === 'data-bascik-build')
          ) {
            message =
              'data-bascik-build and data-bascik-server cannot both appear on the same <script> tag. Remove one - a script runs at build time or at request time, not both.';
          } else if (
            (d1 === 'data-bascik-routes' && d2 === 'data-bascik-server') ||
            (d1 === 'data-bascik-server' && d2 === 'data-bascik-routes')
          ) {
            message =
              'data-bascik-routes and data-bascik-server cannot both appear on the same <script> tag. Remove one - a routes script runs at build time, while a server script runs at request time.';
          } else if (
            (d1 === 'data-bascik-routes' && d2 === 'data-bascik-build') ||
            (d1 === 'data-bascik-build' && d2 === 'data-bascik-routes')
          ) {
            message =
              'data-bascik-routes and data-bascik-build cannot both appear on the same <script> tag. Remove one.';
          } else {
            message = `${d1} and ${d2} cannot both appear on the same <script> tag. Remove one.`;
          }

          const start = document.positionAt(scriptMatch.index ?? 0);
          const end = document.positionAt(
            (scriptMatch.index ?? 0) + openTag.length,
          );
          const diag = new vscode.Diagnostic(
            new vscode.Range(start, end),
            message,
            vscode.DiagnosticSeverity.Error,
          );
          diag.source = 'bascik';
          diagnostics.push(diag);
        }
      }

      if (attrs.has('data-bascik-server') || attrs.has('data-bascik-stream')) {
        const directive = attrs.has('data-bascik-stream') ? 'stream' : 'server';
        const hasSrcAttribute = /\ssrc\s*=/i.test(openTag);
        const serverDiags = analyzeServerScriptSource(scriptBody, {
          hasSrcAttribute,
          directive,
        });

        for (const sd of serverDiags) {
          const start = document.positionAt(scriptBodyOffset + sd.start);
          const end = document.positionAt(scriptBodyOffset + sd.end);
          let severity = vscode.DiagnosticSeverity.Error;
          if (sd.severity === 'warning') {
            severity = vscode.DiagnosticSeverity.Warning;
          } else if (sd.severity === 'info') {
            severity = vscode.DiagnosticSeverity.Information;
          }
          const diag = new vscode.Diagnostic(
            new vscode.Range(start, end),
            sd.message,
            severity,
          );
          diag.source = 'bascik';
          diag.code = sd.code;
          diagnostics.push(diag);
        }
      }

      diagnostics.push(
        ...collectLeadingSlashDiagnostics(
          document,
          openTag,
          scriptBody,
          scriptMatch.index ?? 0,
          attrs,
        ),
      );
      if (isJavaScriptScriptTag(openTag)) {
        addCompatibilityDiagnostics(scriptBody, 'js', scriptBodyOffset);
      }
    }

    let styleMatch: RegExpExecArray | null;
    const hasCompanionCss =
      document.uri.scheme === 'file' &&
      document.uri.fsPath.toLowerCase().endsWith('.html') &&
      fs.existsSync(document.uri.fsPath.replace(/\.html$/i, '.css'));

    const maskedText = text
      .replace(
        /(<(code|pre|script|textarea)(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
        (_m, open: string, _tag: string, content: string, close: string) =>
          open + ' '.repeat(content.length) + close,
      )
      .replace(
        /<!--([\s\S]*?)-->/g,
        (_m, content: string) => '<!--' + ' '.repeat(content.length) + '-->',
      );

    const componentMap = snapshot?.componentMap ?? new Map<string, string>();
    const componentNames = Array.from(componentMap.keys());

    // 1. Diagnose script directives on non-script tags
    const nonScriptDirectiveRe =
      /<([A-Za-z][\w-]*)\b([^>]*\b(data-bascik-(?:build|server|routes|stream))\b[^>]*)>/gi;
    let nonScriptMatch: RegExpExecArray | null;
    while ((nonScriptMatch = nonScriptDirectiveRe.exec(maskedText)) !== null) {
      const tagName = nonScriptMatch[1].toLowerCase();
      if (tagName === 'script') continue;
      const attrName = nonScriptMatch[3];
      const matchStart = nonScriptMatch.index;
      const tagContent = nonScriptMatch[0];
      const attrOffset = tagContent.indexOf(attrName);
      const start = document.positionAt(matchStart + attrOffset);
      const end = document.positionAt(matchStart + attrOffset + attrName.length);
      const diag = new vscode.Diagnostic(
        new vscode.Range(start, end),
        `\`${attrName}\` is only valid on <script> tags. It has no effect on <${tagName}>.`,
        vscode.DiagnosticSeverity.Error,
      );
      diag.source = 'bascik';
      diagnostics.push(diag);
    }

    // 2. Diagnose data-bascik-slot outside of components, on the component itself, or targeting undeclared slots
    const slotTagRe =
      /<([A-Za-z][\w-]*)\b([^>]*\bdata-bascik-slot(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?[^>]*)>/gi;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotTagRe.exec(maskedText)) !== null) {
      const tagOffset = slotMatch.index;
      const slotName = slotMatch[3] ?? slotMatch[4] ?? slotMatch[5];
      const parentName = findNearestParentComponent(
        maskedText.slice(0, tagOffset),
        componentMap,
      );

      // Check if this tag is in a component source file defining its own slot
      const isInsideComponentDefinition = isComponentDocument;
      if (!parentName && !isInsideComponentDefinition) {
        const slotAttrOffset = slotMatch[0].indexOf('data-bascik-slot');
        const start = document.positionAt(tagOffset + slotAttrOffset);
        const end = document.positionAt(
          tagOffset + slotAttrOffset + 'data-bascik-slot'.length,
        );
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          '`data-bascik-slot` is only valid inside a Bascik component body.',
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      } else if (parentName) {
        const parentMeta = snapshot?.componentMetadata.get(parentName);
        if (slotName !== undefined && parentMeta) {
          const declaredSlot = parentMeta.slots.some(
            (s) => s.name.toLowerCase() === slotName.toLowerCase(),
          );
          if (!declaredSlot) {
            const slotAttrOffset = slotMatch[0].indexOf('data-bascik-slot');
            const start = document.positionAt(tagOffset + slotAttrOffset);
            const end = document.positionAt(
              tagOffset + slotMatch[0].length - (slotMatch[0].endsWith('/>') ? 2 : 1),
            );
            const diag = new vscode.Diagnostic(
              new vscode.Range(start, end),
              `Component <${parentName}> does not declare slot "${slotName}".`,
              vscode.DiagnosticSeverity.Error,
            );
            diag.source = 'bascik';
            diagnostics.push(diag);
          }
        }
      }
    }

    if (componentNames.length > 0) {
      componentNames.sort((a, b) => b.length - a.length);
      const escapedNames = componentNames.map((name) =>
        name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      );
      const componentTagRe = new RegExp(
        `<(${escapedNames.join('|')})\\b`,
        'gi',
      );
      let compMatch: RegExpExecArray | null;
      while ((compMatch = componentTagRe.exec(maskedText)) !== null) {
        const tagStartIndex = compMatch.index;
        const tagName = compMatch[1].toLowerCase();

        let inDoubleQuote = false;
        let inSingleQuote = false;
        let openTagEndIndex = -1;
        for (let i = tagStartIndex; i < maskedText.length; i++) {
          const char = maskedText[i];
          if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
          } else if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
          } else if (char === '>' && !inDoubleQuote && !inSingleQuote) {
            openTagEndIndex = i + 1;
            break;
          }
        }

        if (openTagEndIndex !== -1) {
          const openTagText = maskedText.slice(tagStartIndex, openTagEndIndex);

          // Diagnose undeclared props on this component usage
          const compMeta = snapshot?.componentMetadata.get(tagName);
          if (compMeta) {
            const propRe = /\b(data-bascik-prop-([\w-]+))\b/gi;
            let propMatch: RegExpExecArray | null;
            while ((propMatch = propRe.exec(openTagText)) !== null) {
              const fullPropAttr = propMatch[1];
              const propName = propMatch[2];
              const isDeclared = compMeta.props.some(
                (p) => p.name.toLowerCase() === propName.toLowerCase(),
              );
              if (!isDeclared) {
                const start = document.positionAt(tagStartIndex + propMatch.index);
                const end = document.positionAt(
                  tagStartIndex + propMatch.index + fullPropAttr.length,
                );
                const diag = new vscode.Diagnostic(
                  new vscode.Range(start, end),
                  `Component <${tagName}> does not declare prop "${propName}".`,
                  vscode.DiagnosticSeverity.Warning,
                );
                diag.source = 'bascik';
                diagnostics.push(diag);
              }
            }
          }

          const isSelfClosing = /\/\s*>$/.test(openTagText);
          if (!isSelfClosing) {
            const closeIndex = findMatchingClose(
              maskedText,
              tagName,
              openTagEndIndex,
            );
            if (closeIndex === -1) {
              const start = document.positionAt(tagStartIndex);
              const end = document.positionAt(openTagEndIndex);
              const diag = new vscode.Diagnostic(
                new vscode.Range(start, end),
                `Component tag <${tagName}> is unclosed. It will be treated as self-closing (<${tagName}/>), but an explicit closing tag is recommended to avoid layout or scoping issues.`,
                vscode.DiagnosticSeverity.Warning,
              );
              diag.source = 'bascik';
              diagnostics.push(diag);
            }
          }
        }
      }
    }

    const styleMatches: RegExpExecArray[] = [];
    while ((styleMatch = styleBlockRe.exec(maskedText)) !== null) {
      styleMatches.push(styleMatch);
    }

    for (const match of styleMatches) {
      const openTag = match[1];
      const styleBody = match[2] ?? '';
      const styleBodyOffset = (match.index ?? 0) + openTag.length;

      if (hasCompanionCss) {
        const start = document.positionAt(match.index ?? 0);
        const end = document.positionAt((match.index ?? 0) + openTag.length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'Component has both a companion .css file and an inline <style> tag. They will be combined at build time, but mixing both is not recommended for readability and maintainability.',
          vscode.DiagnosticSeverity.Warning,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      }

      addCompatibilityDiagnostics(styleBody, 'css', styleBodyOffset);
    }
  } else if (languageId === 'css') {
    addCompatibilityDiagnostics(text, 'css', 0);
  } else {
    addCompatibilityDiagnostics(text, 'js', 0);
  }

  return diagnostics;
}

export function activate(context: vscode.ExtensionContext): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('bascik');
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  let projects: ProjectStateManager;

  const refreshDiagnostics = async (
    document: vscode.TextDocument | undefined,
  ) => {
    if (!document) return;
    const workspaceFolderKey = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    const project = projects.get(document);
    const version = document.version;
    const items = await createDiagnosticsForDocument(document, projects);
    const currentWorkspaceFolderKey = vscode.workspace
      .getWorkspaceFolder(document.uri)
      ?.uri.toString();
    if (
      document.version === version &&
      (!workspaceFolderKey ||
        currentWorkspaceFolderKey === workspaceFolderKey) &&
      projects.get(document) === project
    ) {
      diagnostics.set(document.uri, items);
    }
  };

  const scheduleProjectDiagnostics = (
    state: ProjectState,
    kind: ProjectChangeKind,
  ) => {
    const key = projectStateKey(state.folder, state.projectRoot);
    const previous = refreshTimers.get(key);
    if (previous) clearTimeout(previous);
    refreshTimers.set(
      key,
      setTimeout(() => {
        refreshTimers.delete(key);
        for (const document of vscode.workspace.textDocuments) {
          if (projects.get(document) !== state) continue;
          if (kind === 'html' && document.languageId !== 'html') continue;
          void refreshDiagnostics(document);
        }
      }, 50),
    );
  };

  projects = new ProjectStateManager(scheduleProjectDiagnostics, (state) => {
    const key = projectStateKey(state.folder, state.projectRoot);
    const timer = refreshTimers.get(key);
    if (timer) clearTimeout(timer);
    refreshTimers.delete(key);
    for (const [uri] of diagnostics) {
      if (uri.scheme !== 'file') continue;
      if (isPathInside(uri.fsPath, state.projectRoot)) {
        diagnostics.delete(uri);
      }
    }
  });
  context.subscriptions.push(projects, diagnostics, {
    dispose: () => {
      for (const timer of refreshTimers.values()) clearTimeout(timer);
      refreshTimers.clear();
    },
  });

  const definitionProvider = new ComponentDefinitionProvider(projects);
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'html' }],
      definitionProvider,
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      [{ language: 'html' }],
      new ComponentHoverProvider(projects),
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      [{ language: 'html' }],
      new ComponentCompletionItemProvider(projects),
      '<',
      ' ',
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'html' }],
      new ScriptImportDefinitionProvider(projects),
    ),
  );

  for (const document of vscode.workspace.textDocuments) {
    void refreshDiagnostics(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(
      (document) => void refreshDiagnostics(document),
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void refreshDiagnostics(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnostics.delete(document.uri);
    }),
  );
}
