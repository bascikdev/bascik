import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchCompatibilityRules } from './rules';

const BUILT_IN_HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr'
]);

function normalizeComponentName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop()?.replace(/\.html$/i, '').toLowerCase() ?? '';
}

function findComponentMap(workspaceRoot: string): Map<string, string> {
  const components = new Map<string, string>();
  const dir = path.join(workspaceRoot, 'src', 'components');

  if (!fs.existsSync(dir)) {
    return components;
  }

  const stack = [dir];
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

function createDiagnosticsForDocument(document: vscode.TextDocument): vscode.Diagnostic[] {
  const { languageId } = document;

  if (languageId !== 'css' && languageId !== 'javascript' && languageId !== 'typescript' && languageId !== 'html') {
    return [];
  }

  const text = document.getText();
  const diagnostics: vscode.Diagnostic[] = [];

  // Warn if a component file name in src/components is not hyphenated per WHATWG HTML §4.13
  if (languageId === 'html' && document.uri.scheme === 'file') {
    const fsPath = document.uri.fsPath.replace(/\\/g, '/');
    if (fsPath.includes('/src/components/')) {
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

  const parseScriptOpenTagAttributes = (openTag: string): Map<string, string | true> => {
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

  const scriptBlockRe = /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\s*>/gi;
  const styleBlockRe = /(<style\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/style\s*>/gi;

  if (languageId === 'html') {
    let scriptMatch: RegExpExecArray | null;
    while ((scriptMatch = scriptBlockRe.exec(text)) !== null) {
      const openTag = scriptMatch[1];
      const scriptBody = scriptMatch[2] ?? '';
      const scriptBodyOffset = (scriptMatch.index ?? 0) + openTag.length;
      const attrs = parseScriptOpenTagAttributes(openTag);
      if (attrs.has('data-bascik-build') && attrs.has('data-bascik-server')) {
        const start = document.positionAt(scriptMatch.index ?? 0);
        const end = document.positionAt((scriptMatch.index ?? 0) + openTag.length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'data-bascik-build and data-bascik-server cannot both appear on the same <script> tag. Remove one - a script runs at build time or at request time, not both.',
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      }
      if (attrs.has('data-bascik-routes') && attrs.has('data-bascik-server')) {
        const start = document.positionAt(scriptMatch.index ?? 0);
        const end = document.positionAt((scriptMatch.index ?? 0) + openTag.length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'data-bascik-routes and data-bascik-server cannot both appear on the same <script> tag. Remove one - a routes script runs at build time, while a server script runs at request time.',
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      }
      if (attrs.has('data-bascik-routes') && attrs.has('data-bascik-build')) {
        const start = document.positionAt(scriptMatch.index ?? 0);
        const end = document.positionAt((scriptMatch.index ?? 0) + openTag.length);
        const diag = new vscode.Diagnostic(
          new vscode.Range(start, end),
          'data-bascik-routes and data-bascik-build cannot both appear on the same <script> tag. Remove one.',
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'bascik';
        diagnostics.push(diag);
      }
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
    vscode.workspace.onDidChangeTextDocument((event) => refreshDiagnostics(event.document)),
  );
}

export function deactivate(): void {
  // no-op
}
