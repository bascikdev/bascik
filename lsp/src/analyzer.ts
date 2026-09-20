import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type Diagnostic,
  DiagnosticSeverity,
  type Position,
  type Range,
  type CompletionItem,
  CompletionItemKind,
  type LocationLink,
  type Hover,
  MarkupKind,
} from 'vscode-languageserver';
import { type TextDocumentLike } from './types.js';
import {
  type ProjectSnapshot,
  isPathInside,
  isInsideComponentRoots,
  normalizeComponentName,
  htmlSuppliesComponentProp,
} from './project.js';
import { matchCompatibilityRules } from './rules.js';
import { analyzeApiRouteSource } from './api-rules.js';
import { findModuleSpecifiers } from './module-specifiers.js';
import { analyzeServerScriptSource } from './server-script-rules.js';
import {
  analyzeComponentSource,
  type ComponentMetadata,
} from './component-metadata.js';
import { parseIgnoreDirectives, isDiagnosticIgnored } from './ignore-comments.js';
import { loadExtensionConfig } from './config.js';

export const BUILT_IN_HTML_ELEMENTS = new Set([
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

export const SCRIPT_DIRECTIVES = [
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

export const SCRIPT_BLOCK_RE =
  /(<script\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)<\/script\s*>/gi;

export function maskHtmlRawTextContents(html: string): string {
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findMatchingClose(
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
        depth++;
        pos = tagEnd;
      } else {
        depth++;
        pos = openMatch.index + openMatch[0].length;
      }
    }
  }
  return -1;
}

export function findNearestParentComponent(
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

export function parseScriptOpenTagAttributes(
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

export function resolveScriptTarget(
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

export function leadingSlashSpecifierMessage(specifier: string): string {
  const rest = specifier.replace(/^\/+/, '');
  return (
    `Leading-slash specifier '${specifier}' is not supported in Bascik scripts. ` +
    `A bare '/' is ambiguous (filesystem root vs. site root). ` +
    `Use '@/${rest}' to resolve against scripts.importRoot, ` +
    `or './${rest}' to resolve relative to this file.`
  );
}

export function collectLeadingSlashDiagnostics(
  document: TextDocumentLike,
  openTag: string,
  scriptBody: string,
  blockStart: number,
  attrs: Map<string, string | true>,
): Diagnostic[] {
  if (
    !attrs.has('data-bascik-build') &&
    !attrs.has('data-bascik-server') &&
    !attrs.has('data-bascik-routes') &&
    !attrs.has('data-bascik-stream')
  ) {
    return [];
  }
  const out: Diagnostic[] = [];
  const push = (start: number, end: number, specifier: string) => {
    out.push({
      range: {
        start: document.positionAt(start),
        end: document.positionAt(end),
      },
      message: leadingSlashSpecifierMessage(specifier),
      severity: DiagnosticSeverity.Error,
      source: 'bascik',
      code: 'leading-slash-specifier',
    });
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

export function createComponentDocumentationMarkdown(
  relativePath: string,
  metadata: ComponentMetadata | undefined,
): string {
  const parts: string[] = [];
  if (metadata?.description) {
    parts.push(metadata.description, '\n\n');
  }
  parts.push(`Bascik component from \`${relativePath}\`.`);
  if (metadata) {
    parts.push('\n\n');
    appendMetadataMembersMarkdown(parts, 'Props', metadata.props);
    appendMetadataMembersMarkdown(parts, 'Slots', [
      ...metadata.slots,
      ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
    ]);
  }
  return parts.join('');
}

function appendMetadataMembersMarkdown(
  parts: string[],
  label: string,
  members: ComponentMetadata['props'],
): void {
  if (members.length === 0) return;
  parts.push(`**${label}:**\n\n`);
  for (const member of members) {
    parts.push(`- \`${member.name}\``);
    if (member.description) {
      parts.push(`: ${member.description}`);
    }
    parts.push('\n');
  }
  parts.push('\n');
}

export function completionReplacementRange(
  document: TextDocumentLike,
  position: Position,
): Range {
  const offset = document.offsetAt(position);
  const prefix =
    /[^\s<>"'=]*$/.exec(document.getText().slice(0, offset))?.[0] ?? '';
  return {
    start: document.positionAt(offset - prefix.length),
    end: position,
  };
}

export function createDiagnostics(
  document: TextDocumentLike,
  fsPath: string,
  snapshot: ProjectSnapshot | undefined,
  openDocumentTexts: { fsPath: string; text: string }[] = [],
): Diagnostic[] {
  const { languageId } = document;

  if (
    languageId !== 'css' &&
    languageId !== 'javascript' &&
    languageId !== 'typescript' &&
    languageId !== 'html'
  ) {
    return [];
  }

  const normalizedDocumentPath = fsPath.replace(/\\/g, '/');
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(normalizedDocumentPath)) {
    return [];
  }

  const text = document.getText();
  const diagnostics: Diagnostic[] = [];
  const isComponentDocument =
    snapshot !== undefined &&
    isInsideComponentRoots(normalizedDocumentPath, snapshot.componentRoots);
  const isApiRouteDocument =
    normalizedDocumentPath.includes('/src/api/') &&
    (languageId === 'typescript' || languageId === 'javascript');

  if (isApiRouteDocument) {
    const apiDiags = analyzeApiRouteSource(text);
    for (const diag of apiDiags) {
      let severity: DiagnosticSeverity = DiagnosticSeverity.Warning;
      if (diag.severity === 'error') {
        severity = DiagnosticSeverity.Error;
      } else if (diag.severity === 'info') {
        severity = DiagnosticSeverity.Information;
      }
      diagnostics.push({
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: Math.min(text.length, 10) },
        },
        message: diag.message,
        severity,
        source: 'bascik',
      });
    }
  }

  if (languageId === 'html' && fsPath.startsWith('/')) {
    if (snapshot && isInsideComponentRoots(normalizedDocumentPath, snapshot.componentRoots)) {
      const fileName = path.basename(normalizedDocumentPath);
      const nameWithoutExt = fileName.replace(/\.html$/i, '').toLowerCase();
      if (
        !nameWithoutExt.includes('-') &&
        !BUILT_IN_HTML_ELEMENTS.has(nameWithoutExt)
      ) {
        diagnostics.push({
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: Math.min(text.length, 10) },
          },
          message: `Component "${nameWithoutExt}" is not hyphenated. Under WHATWG HTML §4.13, custom elements should include a hyphen (e.g. "my-${nameWithoutExt}") to avoid collisions with future HTML standards.`,
          severity: DiagnosticSeverity.Warning,
          source: 'bascik',
        });
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
      diagnostics.push({
        range: { start, end },
        message: `${rule.message} ${rule.suggestion}`,
        severity: DiagnosticSeverity.Warning,
        source: 'bascik',
      });
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
          fs.existsSync(fsPath.replace(/\.html$/i, '.css')),
      });
      for (const metadataDiagnostic of metadata.diagnostics) {
        diagnostics.push({
          range: {
            start: document.positionAt(metadataDiagnostic.start),
            end: document.positionAt(metadataDiagnostic.end),
          },
          message: metadataDiagnostic.message,
          severity: DiagnosticSeverity.Warning,
          source: 'bascik',
          code: metadataDiagnostic.code,
        });
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
          diagnostics.push({
            range: { start, end },
            message: `ID reference "${id}" is not declared in this component and will be left unscoped.`,
            severity: DiagnosticSeverity.Information,
            source: 'bascik',
          });
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
        diagnostics.push({
          range: { start, end },
          message: `ID reference "${id}" is not declared in this component and will be left unscoped.`,
          severity: DiagnosticSeverity.Information,
          source: 'bascik',
        });
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
        diagnostics.push({
          range: { start, end },
          message: `Unknown data-bascik-preserve token "${preserveToken}". Valid tokens are id, name, and class.`,
          severity: DiagnosticSeverity.Warning,
          source: 'bascik',
        });
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
      diagnostics.push({
        range: { start, end },
        message:
          'External form actions require data-bascik-preserve="name" so submitted field names remain literal.',
        severity: DiagnosticSeverity.Warning,
        source: 'bascik',
      });
    }

    if (snapshot && isComponentDocument) {
      const componentName = normalizeComponentName(fsPath);
      const directiveRegex =
        /data-bascik-attr-([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([\w-]+)"|'([\w-]+)')/gi;
      let directiveMatch: RegExpExecArray | null;
      while ((directiveMatch = directiveRegex.exec(text)) !== null) {
        const targetName = directiveMatch[1];
        const propName = directiveMatch[2] ?? directiveMatch[3];
        const suppliedInOpen = openDocumentTexts.some(({ text }) =>
          htmlSuppliesComponentProp(text, componentName, propName),
        );
        const suppliedInDisk = Array.from(snapshot.htmlUsageByFile.values()).some((usageHtml) =>
          htmlSuppliesComponentProp(usageHtml, componentName, propName),
        );
        if (suppliedInOpen || suppliedInDisk) continue;

        const start = document.positionAt(directiveMatch.index);
        const end = document.positionAt(
          directiveMatch.index + directiveMatch[0].length,
        );
        diagnostics.push({
          range: { start, end },
          message: `data-bascik-attr-${targetName} references prop "${propName}", but no <${componentName}> usage supplies data-bascik-prop-${propName}.`,
          severity: DiagnosticSeverity.Warning,
          source: 'bascik',
        });
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
          diagnostics.push({
            range: { start, end },
            message,
            severity: DiagnosticSeverity.Error,
            source: 'bascik',
          });
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
          let severity: DiagnosticSeverity = DiagnosticSeverity.Error;
          if (sd.severity === 'warning') {
            severity = DiagnosticSeverity.Warning;
          } else if (sd.severity === 'info') {
            severity = DiagnosticSeverity.Information;
          }
          diagnostics.push({
            range: { start, end },
            message: sd.message,
            severity,
            source: 'bascik',
            code: sd.code,
          });
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
      fsPath.toLowerCase().endsWith('.html') &&
      fs.existsSync(fsPath.replace(/\.html$/i, '.css'));

    const maskedText = text
      .replace(
        /(<(style|textarea|script)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
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
    const elementOpenTagRe =
      /<([A-Za-z][\w-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*?)?\/?>/gi;
    let elementMatch: RegExpExecArray | null;
    while ((elementMatch = elementOpenTagRe.exec(maskedText)) !== null) {
      const tagName = elementMatch[1].toLowerCase();
      if (tagName === 'script') continue;
      const openTag = elementMatch[0];
      const matchStart = elementMatch.index;
      const scriptDirectives = new Set([
        'data-bascik-build',
        'data-bascik-server',
        'data-bascik-routes',
        'data-bascik-stream',
      ]);

      const insideTag = openTag
        .replace(/^<[A-Za-z][\w-]*\s*/i, '')
        .replace(/\/?>$/, '');
      const baseOffset =
        openTag.length - insideTag.length - (openTag.endsWith('/>') ? 2 : 1);
      const attrRe =
        /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRe.exec(insideTag)) !== null) {
        const attrName = attrMatch[1].toLowerCase();
        if (scriptDirectives.has(attrName)) {
          const start = document.positionAt(
            matchStart + baseOffset + attrMatch.index,
          );
          const end = document.positionAt(
            matchStart + baseOffset + attrMatch.index + attrMatch[1].length,
          );
          diagnostics.push({
            range: { start, end },
            message: `\`${attrMatch[1]}\` is only valid on <script> tags. It has no effect on <${tagName}>.`,
            severity: DiagnosticSeverity.Error,
            source: 'bascik',
          });
        }
      }
    }

    // 2. Diagnose data-bascik-slot outside of components, on the component itself, or targeting undeclared slots
    const slotTagRe =
      /<([A-Za-z][\w-]*)(?:\s+(?:[^>"']|"[^"]*"|'[^']*')*?)?\/?>/gi;
    let slotMatch: RegExpExecArray | null;
    while ((slotMatch = slotTagRe.exec(maskedText)) !== null) {
      const openTag = slotMatch[0];
      const matchStart = slotMatch.index;
      const insideTag = openTag
        .replace(/^<[A-Za-z][\w-]*\s*/i, '')
        .replace(/\/?>$/, '');
      const baseOffset =
        openTag.length - insideTag.length - (openTag.endsWith('/>') ? 2 : 1);
      const attrRe =
        /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
      let attrMatch: RegExpExecArray | null;
      let slotAttr: { name: string; value?: string; index: number } | null = null;
      while ((attrMatch = attrRe.exec(insideTag)) !== null) {
        if (attrMatch[1].toLowerCase() === 'data-bascik-slot') {
          slotAttr = {
            name: attrMatch[1],
            value: attrMatch[2] ?? attrMatch[3] ?? attrMatch[4],
            index: attrMatch.index,
          };
          break;
        }
      }
      if (!slotAttr) continue;

      const tagOffset = slotMatch.index;
      const slotName = slotAttr.value;
      const parentName = findNearestParentComponent(
        maskedText.slice(0, tagOffset),
        componentMap,
      );

      const isInsideComponentDefinition = isComponentDocument;
      if (!parentName && !isInsideComponentDefinition) {
        const start = document.positionAt(
          matchStart + baseOffset + slotAttr.index,
        );
        const end = document.positionAt(
          matchStart + baseOffset + slotAttr.index + slotAttr.name.length,
        );
        diagnostics.push({
          range: { start, end },
          message:
            '`data-bascik-slot` is only valid inside a Bascik component body.',
          severity: DiagnosticSeverity.Error,
          source: 'bascik',
        });
      } else if (parentName) {
        const parentMeta = snapshot?.componentMetadata.get(parentName);
        if (slotName !== undefined && parentMeta) {
          const declaredSlot = parentMeta.slots.some(
            (s) => s.name.toLowerCase() === slotName.toLowerCase(),
          );
          if (!declaredSlot) {
            const start = document.positionAt(
              matchStart + baseOffset + slotAttr.index,
            );
            const end = document.positionAt(
              matchStart + baseOffset + slotAttr.index + slotAttr.name.length,
            );
            diagnostics.push({
              range: { start, end },
              message: `Component <${parentName}> does not declare slot "${slotName}".`,
              severity: DiagnosticSeverity.Error,
              source: 'bascik',
            });
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
                const start = document.positionAt(
                  tagStartIndex + propMatch.index,
                );
                const end = document.positionAt(
                  tagStartIndex + propMatch.index + fullPropAttr.length,
                );
                diagnostics.push({
                  range: { start, end },
                  message: `Component <${tagName}> does not declare prop "${propName}".`,
                  severity: DiagnosticSeverity.Warning,
                  source: 'bascik',
                });
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
              diagnostics.push({
                range: { start, end },
                message: `Component tag <${tagName}> is unclosed. It will be treated as self-closing (<${tagName}/>), but an explicit closing tag is recommended to avoid layout or scoping issues.`,
                severity: DiagnosticSeverity.Warning,
                source: 'bascik',
                code: 'unclosed-component-tag',
              });
            } else if (compMeta) {
              const hasZeroSlots =
                !compMeta.defaultSlot && compMeta.slots.length === 0;
              if (hasZeroSlots) {
                const start = document.positionAt(tagStartIndex);
                const end = document.positionAt(
                  closeIndex + `</${tagName}>`.length,
                );
                diagnostics.push({
                  range: { start, end },
                  message: `Component <${tagName}> defines no slots and accepts no children. Use self-closing tag <${tagName} /> instead of paired <${tagName}></${tagName}>.`,
                  severity: DiagnosticSeverity.Warning,
                  source: 'bascik',
                  code: 'prefer-self-closing-component',
                });
              }
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
        diagnostics.push({
          range: { start, end },
          message:
            'Component has both a companion .css file and an inline <style> tag. They will be combined at build time, but mixing both is not recommended for readability and maintainability.',
          severity: DiagnosticSeverity.Warning,
          source: 'bascik',
        });
      }

      addCompatibilityDiagnostics(styleBody, 'css', styleBodyOffset);
    }
  } else if (languageId === 'css') {
    addCompatibilityDiagnostics(text, 'css', 0);
  } else {
    addCompatibilityDiagnostics(text, 'js', 0);
  }

  const ignoreRanges = parseIgnoreDirectives(text, languageId);
  const extConfig = snapshot ? loadExtensionConfig(snapshot.projectRoot) : {};
  const disabledRules = new Set(
    extConfig.diagnostics?.disabledRules?.map((r) => r.toLowerCase()) ?? [],
  );

  if (extConfig.diagnostics?.enabled === false) {
    return [];
  }

  return diagnostics.filter((diag) => {
    const line = diag.range.start.line;
    const code = typeof diag.code === 'string' ? diag.code : undefined;
    if (code && disabledRules.has(code.toLowerCase())) {
      return false;
    }
    if (
      code === 'prefer-self-closing-component' &&
      extConfig.diagnostics?.selfClosingComponents === false
    ) {
      return false;
    }
    if (
      code === 'unclosed-component-tag' &&
      extConfig.diagnostics?.unclosedComponents === false
    ) {
      return false;
    }
    return !isDiagnosticIgnored(line, code, ignoreRanges);
  });
}

export function createCompletions(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
): CompletionItem[] | undefined {
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

    const currentTagName = openTagMatch[1].toLowerCase();
    const openTagText = openTagMatch[0];
    const currentTagStart = offset - openTagText.length;

    if (currentTagName === 'script') {
      const hasAnyDirective = SCRIPT_DIRECTIVES.some((dir) =>
        new RegExp(`\\b${dir.name}\\b`, 'i').test(openTagText),
      );
      if (hasAnyDirective) return [];

      const range = completionReplacementRange(document, position);
      return SCRIPT_DIRECTIVES.map((dir) => ({
        label: dir.name,
        kind: CompletionItemKind.Property,
        textEdit: {
          range,
          newText: dir.name,
        },
        sortText: `0_${dir.name}`,
        detail: dir.detail,
        documentation: {
          kind: MarkupKind.Markdown,
          value: dir.documentation,
        },
      }));
    }

    const currentComponentMetadata =
      snapshot.componentMetadata.get(currentTagName);
    if (currentComponentMetadata) {
      const range = completionReplacementRange(document, position);
      return currentComponentMetadata.props
        .filter(
          ({ name }) =>
            !new RegExp(
              `\\bdata-bascik-prop-${escapeRegExp(name)}\\s*=`,
              'i',
            ).test(openTagText),
        )
        .map((prop) => {
          const attribute = `data-bascik-prop-${prop.name}`;
          const item: CompletionItem = {
            label: attribute,
            kind: CompletionItemKind.Property,
            textEdit: {
              range,
              newText: `${attribute}="$1"`,
            },
            insertTextFormat: 2, // Snippet
            sortText: `0_${attribute}`,
            detail: 'Bascik component prop',
          };
          if (prop.description) {
            item.documentation = {
              kind: MarkupKind.Markdown,
              value: prop.description,
            };
          }
          return item;
        });
    }

    const parentComponentName = findNearestParentComponent(
      maskedSource.slice(0, currentTagStart),
      snapshot.componentMap,
    );
    if (!parentComponentName) return undefined;
    const parentMetadata = snapshot.componentMetadata.get(parentComponentName);
    if (!parentMetadata) return undefined;

    if (/\bdata-bascik-slot(?:\s*=|\s|\/?>|$)/i.test(openTagText)) return [];
    const range = completionReplacementRange(document, position);
    return parentMetadata.slots.map((slot) => {
      const item: CompletionItem = {
        label: `data-bascik-slot="${slot.name}"`,
        kind: CompletionItemKind.Property,
        textEdit: {
          range,
          newText: `data-bascik-slot="${slot.name}"`,
        },
        filterText: `data-bascik-slot ${slot.name}`,
        sortText: `0_data-bascik-slot_${slot.name}`,
        detail: 'Bascik named slot',
      };
      if (slot.description) {
        item.documentation = {
          kind: MarkupKind.Markdown,
          value: slot.description,
        };
      }
      return item;
    });
  }

  const tagStart = offset - tagMatch[0].length;
  const sourceBeforeTag = sourceBeforeCursor.slice(0, tagStart);
  const previousTagStart = sourceBeforeTag.lastIndexOf('<');
  const previousTagEnd = sourceBeforeTag.lastIndexOf('>');
  if (previousTagStart > previousTagEnd) return undefined;

  const prefix = (tagMatch[1] ?? '').toLowerCase();
  const start = document.positionAt(offset - prefix.length);
  const replacementRange: Range = { start, end: position };

  return Array.from(snapshot.componentMap)
    .filter(([componentName]) => componentName.startsWith(prefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([componentName, componentPath]) => {
      const metadata = snapshot.componentMetadata.get(componentName);
      const relativePath = path
        .relative(snapshot.projectRoot, componentPath)
        .replace(/\\/g, '/');

      return {
        label: componentName,
        kind: CompletionItemKind.Class,
        sortText: `0_${componentName}`,
        range: {
          start: document.positionAt(tagStart),
          end: replacementRange.end,
        },
        insertText: metadata?.defaultSlot
          ? `<${componentName}>$0</${componentName}>`
          : `<${componentName} />$0`,
        insertTextFormat: 2, // Snippet
        filterText: componentName,
        detail: 'Bascik component',
        documentation: {
          kind: MarkupKind.Markdown,
          value: createComponentDocumentationMarkdown(relativePath, metadata),
        },
      };
    });
}

export function createHover(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
): Hover | undefined {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  const wordRegex = /[A-Za-z0-9-]+/g;
  let wordMatch: RegExpExecArray | null;
  let targetWord: string | undefined;
  let wordRange: Range | undefined;

  while ((wordMatch = wordRegex.exec(line)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (position.character >= start && position.character <= end) {
      targetWord = wordMatch[0];
      wordRange = {
        start: { line: position.line, character: start },
        end: { line: position.line, character: end },
      };
      break;
    }
  }

  if (!targetWord || !wordRange) return undefined;
  const componentName = targetWord.toLowerCase();
  if (BUILT_IN_HTML_ELEMENTS.has(componentName)) return undefined;

  const componentPath = snapshot.componentMap.get(componentName);
  if (!componentPath) return undefined;
  const metadata = snapshot.componentMetadata.get(componentName);
  if (!metadata) return undefined;

  const relativePath = path
    .relative(snapshot.projectRoot, componentPath)
    .replace(/\\/g, '/');
  const details: string[] = [`### \`<${componentName}>\`\n\n`];
  if (metadata.description) {
    details.push(metadata.description, '\n\n');
  }
  details.push(
    `**Source:** [\`${relativePath}\`](file://${componentPath})\n\n`,
  );
  appendMetadataMembersMarkdown(details, 'Props', metadata.props);
  appendMetadataMembersMarkdown(details, 'Slots', [
    ...metadata.slots,
    ...(metadata.defaultSlot ? [metadata.defaultSlot] : []),
  ]);
  const features = [
    metadata.hasStyles ? 'styles' : '',
    metadata.hasScripts ? 'scripts' : '',
  ].filter(Boolean);
  if (features.length > 0) {
    details.push(`**Includes:** ${features.join(', ')}`);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: details.join(''),
    },
    range: wordRange,
  };
}

export function createDefinition(
  document: TextDocumentLike,
  position: Position,
  snapshot: ProjectSnapshot,
  fsPath: string,
): LocationLink[] | undefined {
  if (document.languageId !== 'html') return undefined;

  // 1. Check for script import definition
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

    const baseDir = path.dirname(fsPath);
    const importRootAbs = snapshot.importRoot;

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
      return [
        {
          originSelectionRange: {
            start: document.positionAt(valueStart),
            end: document.positionAt(valueEnd),
          },
          targetUri: `file://${resolved}`,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }

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
      return [
        {
          originSelectionRange: {
            start: document.positionAt(openTagEnd + start),
            end: document.positionAt(openTagEnd + end),
          },
          targetUri: `file://${resolved}`,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }
  }

  // 2. Check for component tag jump-to-definition
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  const wordRegex = /[A-Za-z0-9-]+/g;
  let wordMatch: RegExpExecArray | null;
  while ((wordMatch = wordRegex.exec(line)) !== null) {
    const start = wordMatch.index;
    const end = start + wordMatch[0].length;
    if (position.character >= start && position.character <= end) {
      const word = wordMatch[0].toLowerCase();
      if (BUILT_IN_HTML_ELEMENTS.has(word)) return undefined;
      const componentPath = snapshot.componentMap.get(word);
      if (!componentPath) return undefined;
      return [
        {
          originSelectionRange: {
            start: { line: position.line, character: start },
            end: { line: position.line, character: end },
          },
          targetUri: `file://${componentPath}`,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ];
    }
  }

  return undefined;
}
