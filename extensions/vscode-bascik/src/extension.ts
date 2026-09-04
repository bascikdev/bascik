import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { matchCompatibilityRules } from './rules';
import { analyzeApiRouteSource } from './api-rules';
import { findModuleSpecifiers } from './module-specifiers';

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

      // Cursor inside the open tag: check for the src attribute value.
      if (offset >= blockStart && offset <= openTagEnd) {
        const srcMatch = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(openTag);
        if (!srcMatch) return undefined;
        const srcValue = srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? '';
        if (!srcValue) return undefined;
        const valueStart = blockStart + (srcMatch.index ?? 0) + srcMatch[0].indexOf(srcValue);
        const valueEnd = valueStart + srcValue.length;
        if (offset < valueStart || offset > valueEnd) return undefined;
        if (path.isAbsolute(srcValue) || /^[a-z][a-z\d+.-]*:/i.test(srcValue)) return undefined;
        const resolved = path.resolve(baseDir, srcValue);
        if (!fs.existsSync(resolved)) return undefined;
        return new vscode.Location(vscode.Uri.file(resolved), new vscode.Position(0, 0));
      }

      // Cursor inside the script body: inspect lexical ESM specifiers only.
      const bodyOffset = offset - openTagEnd;
      for (const { start, end, value: specifier } of findModuleSpecifiers(scriptBody)) {
        if (bodyOffset < start || bodyOffset > end) continue;
        if (!(specifier.startsWith('./') || specifier.startsWith('../'))) return undefined;
        const resolved = path.resolve(baseDir, specifier);
        if (!fs.existsSync(resolved)) return undefined;
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
    document.uri.scheme === 'file' && normalizedDocumentPath.includes('/src/components/');
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

  const scriptBlockRe = SCRIPT_BLOCK_RE;
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

export function deactivate(): void {
  // no-op
}
