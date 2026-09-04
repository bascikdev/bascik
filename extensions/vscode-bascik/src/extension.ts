import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchCompatibilityRules } from './rules';
import { analyzeApiRouteSource } from './api-rules';
import { findModuleSpecifiers } from './module-specifiers';
import { analyzeServerScriptSource } from './server-script-rules';

const BUILT_IN_HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
]);

function normalizeComponentName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()?.replace(/\.html$/i, '').toLowerCase() ?? '';
}

const CONFIG_FILE_CANDIDATES = ['bascik.config.ts', 'bascik.config.js', 'bascik.config.mjs'];
const DEFAULT_COMPONENT_ROOTS = ['src/components'];

/**
 * Read `directory.components` from the workspace's bascik.config file.
 *
 * This is a lexical (regex) read because the extension cannot execute a
 * TypeScript config. It accepts the same shapes as the runtime: a single
 * string or an array of strings. Values are relative to the project root and
 * may point outside it (monorepo shared components). Falls back to the runtime
 * default `['src/components']` when the config is missing or unparseable.
 */
function readComponentRoots(workspaceRoot: string): string[] {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(workspaceRoot, candidate);
    if (!fs.existsSync(configPath)) continue;
    try {
      const source = fs.readFileSync(configPath, 'utf8');
      const match = /\bcomponents\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/.exec(source);
      if (match?.[1]) {
        const literals = Array.from(match[1].matchAll(/['"]([^'"]+)['"]/g), (m) => m[1]);
        if (literals.length > 0) return literals;
      }
    } catch {
      // unreadable config: fall through to the default
    }
    break;
  }
  return DEFAULT_COMPONENT_ROOTS;
}

/** Absolute, forward-slash component roots for the workspace. */
function resolveComponentRoots(workspaceRoot: string): string[] {
  return readComponentRoots(workspaceRoot).map((root) =>
    path.resolve(workspaceRoot, root).replace(/\\/g, '/').replace(/\/+$/, ''),
  );
}

/** True when `fsPath` is inside any configured component root of its workspace. */
function isInsideComponentRoot(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, '/');
  const workspaceRoot = getWorkspaceRoot();
  const roots = workspaceRoot
    ? resolveComponentRoots(workspaceRoot)
    : DEFAULT_COMPONENT_ROOTS.map((root) => `/${root}`);
  return roots.some((root) =>
    workspaceRoot
      ? normalized === root || normalized.startsWith(`${root}/`)
      : normalized.includes(`${root}/`),
  );
}

function findComponentMap(workspaceRoot: string): Map<string, string> {
  const components = new Map<string, string>();
  const stack = resolveComponentRoots(workspaceRoot).filter((dir) => fs.existsSync(dir));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        const name = normalizeComponentName(fullPath);
        if (name) {
          components.set(name, fullPath);
        }
      }
    }
  }

  return components;
}

function findHtmlFiles(workspaceRoot: string): string[] {
  const files: string[] = [];
  const stack = [path.join(workspaceRoot, 'src')];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
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

function componentUsageSuppliesProp(
  workspaceRoot: string,
  componentName: string,
  propName: string,
): boolean {
  const escapedComponentName = componentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const usageRegex = new RegExp(
    `<${escapedComponentName}(?![\\w-])(?:[^>"']|"[^"]*"|'[^']*')*>`,
    'gi',
  );
  const propRegex = new RegExp(`\\sdata-bascik-prop-${escapedPropName}\\s*=`, 'i');
  return findHtmlFiles(workspaceRoot).some((filePath) => {
    const html = fs.readFileSync(filePath, 'utf8');
    return Array.from(html.matchAll(usageRegex)).some((match) => propRegex.test(match[0]));
  });
}

function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath;
}

class ComponentDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z0-9-]+/);
    if (!range) {
      return undefined;
    }

    const word = document.getText(range);
    if (!word || BUILT_IN_HTML_ELEMENTS.has(word.toLowerCase())) {
      return undefined;
    }

    const root = getWorkspaceRoot();
    if (!root) {
      return undefined;
    }

    const componentMap = findComponentMap(root);
    const tagName = word.toLowerCase();
    const file = componentMap.get(tagName);
    if (!file || !fs.existsSync(file)) {
      return undefined;
    }

    return new vscode.Location(vscode.Uri.file(file), new vscode.Position(0, 0));
  }
}

const SCRIPT_BLOCK_RE = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\s*>/gi;

const DEFAULT_IMPORT_ROOT = 'src';

/**
 * Read `scripts.importRoot` from the workspace's bascik.config file.
 *
 * The extension cannot execute a TypeScript config file, so this is a
 * best-effort regex read (`importRoot: '...'`) with a fallback to the runtime
 * default `src`. It mirrors `pkg/src/lib/import-root.ts`: the value is relative
 * to the project root and may point outside it (monorepo shared scripts).
 */
function readImportRoot(workspaceRoot: string): string {
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const configPath = path.join(workspaceRoot, candidate);
    if (!fs.existsSync(configPath)) continue;
    try {
      const source = fs.readFileSync(configPath, 'utf8');
      const match = /importRoot\s*:\s*['"]([^'"]+)['"]/.exec(source);
      if (match?.[1]) return match[1];
    } catch {
      // unreadable config: fall through to the default
    }
    break;
  }
  return DEFAULT_IMPORT_ROOT;
}

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
  if (value.startsWith('./') || value.startsWith('../')) return path.resolve(documentDir, value);
  if (value.startsWith('@/')) return path.resolve(importRootAbs, value.slice(2));
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
  if (!attrs.has('data-bascik-build') && !attrs.has('data-bascik-server') && !attrs.has('data-bascik-routes') && !attrs.has('data-bascik-stream')) {
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

  const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
  if (srcMatch) {
    const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '';
    if (srcValue.startsWith('/')) {
      const valueStart = blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
      push(valueStart, valueStart + srcValue.length, srcValue);
    }
  }

  const bodyStart = blockStart + openTag.length;
  for (const { start, end, value } of findModuleSpecifiers(scriptBody)) {
    if (value.startsWith('/')) push(bodyStart + start, bodyStart + end, value);
  }
  return out;
}

function parseScriptOpenTagAttributes(openTag: string): Map<string, string | true> {
  const attrs = new Map<string, string | true>();
  const insideTag = openTag
    .replace(/^<script\b/i, '')
    .replace(/>$/, '');
  const attrRe = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
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
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    if (document.languageId !== 'html') {
      return undefined;
    }

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
      if (!attrs.has('data-bascik-build') &&
        !attrs.has('data-bascik-server') &&
        !attrs.has('data-bascik-routes')) {
        return undefined;
      }

      const baseDir = path.dirname(document.uri.fsPath);
      const workspaceRoot = getWorkspaceRoot();
      const importRootAbs = workspaceRoot
        ? path.resolve(workspaceRoot, readImportRoot(workspaceRoot))
        : path.resolve(baseDir, DEFAULT_IMPORT_ROOT);

      // Cursor inside the open tag: check for the src attribute value.
      if (offset >= blockStart && offset <= openTagEnd) {
        const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
        if (!srcMatch) return undefined;
        const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '';
        if (!srcValue) return undefined;
        const valueStart = blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
        const valueEnd = valueStart + srcValue.length;
        if (offset < valueStart || offset > valueEnd) return undefined;
        const resolved = resolveScriptTarget(srcValue, baseDir, importRootAbs, 'src');
        if (!resolved || !fs.existsSync(resolved)) return undefined;
        return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
      }

      // Cursor inside the script body: inspect lexical ESM specifiers only.
      const bodyOffset = offset - openTagEnd;
      for (const { start, end, value: specifier } of findModuleSpecifiers(scriptBody)) {
        if (bodyOffset < start || bodyOffset > end) continue;
        const resolved = resolveScriptTarget(specifier, baseDir, importRootAbs, 'specifier');
        if (!resolved || !fs.existsSync(resolved)) return undefined;
        return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
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
  const tn = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const openRe = new RegExp(`<${tn}[\\s>]`, "gi");
  const closeRe = new RegExp(`<\\/${tn}>`, "gi");
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
    (_match, openTag: string, _tagName: string, content: string, closeTag: string) =>
      `${openTag}${' '.repeat(content.length)}${closeTag}`,
  );
}

function createDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
  const { languageId } = document;

  if (languageId !== 'css' && languageId !== 'javascript' && languageId !== 'typescript' && languageId !== 'html') {
    return [];
  }

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];
  const normalizedDocumentPath = document.uri.fsPath.replace(/\\/g, '/');
  const isComponentDocument =
    document.uri.scheme === 'file' && isInsideComponentRoot(normalizedDocumentPath);
  const isApiRouteDocument =
    document.uri.scheme === 'file' &&
    normalizedDocumentPath.includes('/src/api/') &&
    (languageId === 'typescript' || languageId === 'javascript');

  if (isApiRouteDocument) {
    const apiDiags = analyzeApiRouteSource(text);
    for (const diag of apiDiags) {
      const severity =
        diag.severity === 'error'
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning;
      const start = new vscode.Position(0, 0);
      const end = new vscode.Position(0, Math.min(text.length, 10));
      const vdiag = new vscode.Diagnostic(new vscode.Range(start, end), diag.message, severity);
      vdiag.source = 'bascik';
      diagnostics.push(vdiag);
    }
  }

  // Warn if a component file name in any configured components root is not
  // hyphenated per WHATWG HTML §4.13
  if (languageId === 'html' && document.uri.scheme === 'file') {
    const fsPath = document.uri.fsPath.replace(/\\/g, '/');
    if (isInsideComponentRoot(fsPath)) {
      const fileName = path.basename(fsPath);
      const nameWithoutExt = fileName.replace(/\.html$/i, '').toLowerCase();
      if (!nameWithoutExt.includes('-') && !BUILT_IN_HTML_ELEMENTS.has(nameWithoutExt)) {
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

  const addCompatibilityDiagnostics = (sourceText: string, kind: 'css' | 'js', offset: number) => {
    for (const rule of matchCompatibilityRules(sourceText, kind)) {
      const flags = rule.regex.flags.includes('g') ? rule.regex.flags : `${rule.regex.flags}g`;
      const regex = new RegExp(rule.regex.source, flags);
      const match = regex.exec(sourceText);
      if (!match || typeof match.index !== 'number') continue;
      const start = document.positionAt(offset + match.index);
      const end = document.positionAt(offset + match.index + Math.max(match[0].length, 1));
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
    return normalized === 'module'
      || normalized === 'text/javascript'
      || normalized === 'application/javascript'
      || normalized === 'text/ecmascript'
      || normalized === 'application/ecmascript';
  };

  // Fresh instance: SCRIPT_BLOCK_RE is a global (`g`) regex shared with the
  // definition provider, and a stale lastIndex would silently skip blocks.
  const scriptBlockRe = new RegExp(SCRIPT_BLOCK_RE.source, SCRIPT_BLOCK_RE.flags);
  const styleBlockRe = /(<style\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style\s*>/gi;

  if (languageId === 'html') {
    if (isComponentDocument) {
      const referenceScanText = maskHtmlRawTextContents(text)
        .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => ' '.repeat(comment.length));
      const declaredIds = new Set(
        Array.from(referenceScanText.matchAll(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi))
          .map((match) => match[1] ?? match[2])
          .filter((id): id is string => Boolean(id)),
      );
      const idReferenceAttributeRegex = /\s(for|itemref|aria-activedescendant|aria-details|aria-errormessage|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-flowto)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
      let idReferenceMatch: RegExpExecArray | null;
      while ((idReferenceMatch = idReferenceAttributeRegex.exec(referenceScanText)) !== null) {
        const value = idReferenceMatch[2] ?? idReferenceMatch[3] ?? '';
        for (const id of value.trim().split(/\s+/).filter(Boolean)) {
          if (declaredIds.has(id)) continue;
          const valueOffset = idReferenceMatch[0].indexOf(id);
          const start = document.positionAt(idReferenceMatch.index + Math.max(valueOffset, 0));
          const end = document.positionAt(idReferenceMatch.index + Math.max(valueOffset, 0) + id.length);
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
      while ((fragmentReferenceMatch = fragmentReferenceRegex.exec(referenceScanText)) !== null) {
        const id = fragmentReferenceMatch[1] ?? fragmentReferenceMatch[2];
        if (!id || declaredIds.has(id)) continue;
        const idOffset = fragmentReferenceMatch[0].indexOf(id);
        const start = document.positionAt(fragmentReferenceMatch.index + Math.max(idOffset, 0));
        const end = document.positionAt(fragmentReferenceMatch.index + Math.max(idOffset, 0) + id.length);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(start, end),
          `ID reference "${id}" is not declared in this component and will be left unscoped.`,
          vscode.DiagnosticSeverity.Information,
        );
        diagnostic.source = 'bascik';
        diagnostics.push(diagnostic);
      }
    }

    const preserveDirectiveRegex = /data-bascik-preserve(?:\s*=\s*("([^"]*)"|'([^']*)'))?/gi;
    let preserveMatch: RegExpExecArray | null;
    while ((preserveMatch = preserveDirectiveRegex.exec(text)) !== null) {
      if (preserveMatch[1] === undefined) continue;
      const value = preserveMatch[2] ?? preserveMatch[3] ?? '';
      for (const preserveToken of value.trim().split(/\s+/).filter(Boolean)) {
        if (preserveToken === 'id' || preserveToken === 'name' || preserveToken === 'class') continue;
        const tokenOffset = preserveMatch[0].indexOf(preserveToken);
        const start = document.positionAt(preserveMatch.index + Math.max(tokenOffset, 0));
        const end = document.positionAt(preserveMatch.index + Math.max(tokenOffset, 0) + preserveToken.length);
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
    while (isComponentDocument && (formMatch = formOpenTagRegex.exec(text)) !== null) {
      const actionMatch = formMatch[0].match(/\saction\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const action = actionMatch?.[1] ?? actionMatch?.[2];
      if (!action || !/^(?:https?:)?\/\//i.test(action)) continue;
      const preserveMatch = formMatch[0].match(/\sdata-bascik-preserve(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/i);
      const preservesName = preserveMatch !== null && (
        preserveMatch[1] === undefined ||
        (preserveMatch[1] ?? preserveMatch[2] ?? '').trim().split(/\s+/).includes('name')
      );
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

    const workspaceRoot = getWorkspaceRoot();
    if (
      workspaceRoot &&
      isComponentDocument
    ) {
      const componentName = normalizeComponentName(document.uri.fsPath);
      const directiveRegex = /data-bascik-attr-([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([\w-]+)"|'([\w-]+)')/gi;
      let directiveMatch: RegExpExecArray | null;
      while ((directiveMatch = directiveRegex.exec(text)) !== null) {
        const targetName = directiveMatch[1];
        const propName = directiveMatch[2] ?? directiveMatch[3];
        if (componentUsageSuppliesProp(workspaceRoot, componentName, propName)) continue;
        const start = document.positionAt(directiveMatch.index);
        const end = document.positionAt(directiveMatch.index + directiveMatch[0].length);
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
          const end = document.positionAt((scriptMatch.index ?? 0) + openTag.length);
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
          const diag = new vscode.Diagnostic(new vscode.Range(start, end), sd.message, severity);
          diag.source = 'bascik';
          diag.code = sd.code;
          diagnostics.push(diag);
        }
      }

      diagnostics.push(
        ...collectLeadingSlashDiagnostics(document, openTag, scriptBody, scriptMatch.index ?? 0, attrs),
      );
      if (isJavaScriptScriptTag(openTag)) {
        addCompatibilityDiagnostics(scriptBody, 'js', scriptBodyOffset);
      }
    }

    let styleMatch: RegExpExecArray | null;
    const hasCompanionCss = document.uri.scheme === 'file'
      && document.uri.fsPath.toLowerCase().endsWith('.html')
      && fs.existsSync(document.uri.fsPath.replace(/\.html$/i, '.css'));

    const maskedText = text
      .replace(
        /(<(code|pre|script|textarea)(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
        (_m, open: string, _tag: string, content: string, close: string) =>
          open + ' '.repeat(content.length) + close,
      )
      .replace(
        /<!--([\s\S]*?)-->/g,
        (_m, content: string) => '<!--' + ' '.repeat(content.length) + '-->'
      );

    const root = getWorkspaceRoot();
    const componentMap = root ? findComponentMap(root) : new Map<string, string>();
    const componentNames = Array.from(componentMap.keys());
    if (componentNames.length > 0) {
      componentNames.sort((a, b) => b.length - a.length);
      const escapedNames = componentNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const componentTagRe = new RegExp(`<(${escapedNames.join('|')})\\b`, 'gi');
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
          const isSelfClosing = /\/\s*>$/.test(openTagText);
          if (!isSelfClosing) {
            const closeIndex = findMatchingClose(maskedText, tagName, openTagEndIndex);
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
  const definitionProvider = new ComponentDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'html' }, { language: 'javascript' }, { language: 'typescript' }, { language: 'css' }],
      definitionProvider,
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      [{ language: 'html' }],
      new ScriptImportDefinitionProvider(),
    ),
  );

  const diagnostics = vscode.languages.createDiagnosticCollection('bascik');
  context.subscriptions.push(diagnostics);

  const refreshDiagnostics = (document: vscode.TextDocument | undefined) => {
    if (!document) return;
    const items = createDiagnosticsForDocument(document);
    diagnostics.set(document.uri, items);
  };

  for (const document of vscode.workspace.textDocuments) {
    refreshDiagnostics(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refreshDiagnostics),
    vscode.workspace.onDidChangeTextDocument((event) => {
      refreshDiagnostics(event.document);
      if (event.document.languageId === 'html') {
        for (const document of vscode.workspace.textDocuments) {
          if (document !== event.document && document.languageId === 'html') {
            refreshDiagnostics(document);
          }
        }
      }
    }),
  );
}
