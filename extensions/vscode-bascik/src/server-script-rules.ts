import { findModuleSpecifiers } from './module-specifiers';

interface TemplatePlaceholder {
  literalStart: number;
  placeholderStart: number;
  placeholderEnd: number;
  expr: string;
  precedingInLiteral: string;
}

function findTemplatePlaceholders(source: string): TemplatePlaceholder[] {
  const placeholders: TemplatePlaceholder[] = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '`') {
      const literalStart = i;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
        } else if (source[i] === '`') {
          i++;
          break;
        } else if (source[i] === '$' && source[i + 1] === '{') {
          const placeholderStart = i;
          let depth = 1;
          let j = i + 2;
          while (j < source.length && depth > 0) {
            if (source[j] === '\\') {
              j += 2;
            } else if (source[j] === '{') {
              depth++;
              j++;
            } else if (source[j] === '}') {
              depth--;
              j++;
            } else if (source[j] === "'" || source[j] === '"') {
              const quote = source[j];
              j++;
              while (j < source.length) {
                if (source[j] === '\\') j += 2;
                else if (source[j] === quote) {
                  j++;
                  break;
                } else j++;
              }
            } else if (source[j] === '`') {
              // skip template literal inside expr
              j++;
              while (j < source.length) {
                if (source[j] === '\\') j += 2;
                else if (source[j] === '`') {
                  j++;
                  break;
                } else j++;
              }
            } else {
              j++;
            }
          }
          const placeholderEnd = j;
          const expr = source.slice(placeholderStart + 2, placeholderEnd - 1);
          placeholders.push({
            literalStart,
            placeholderStart,
            placeholderEnd,
            expr,
            precedingInLiteral: source.slice(literalStart + 1, placeholderStart),
          });
          i = placeholderEnd;
        } else {
          i++;
        }
      }
    } else if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      i++;
      while (i < source.length) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === quote) {
          i++;
          break;
        } else i++;
      }
    } else if (source[i] === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
    } else if (source[i] === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(i + 2, source.length);
    } else {
      i++;
    }
  }
  return placeholders;
}

export interface ServerScriptDiagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  start: number;
  end: number;
}

export interface AnalyzeOptions {
  hasSrcAttribute: boolean;
  directive: 'server' | 'stream';
}

export function analyzeServerScriptSource(
  body: string,
  opts: AnalyzeOptions,
): ServerScriptDiagnostic[] {
  const diagnostics: ServerScriptDiagnostic[] = [];

  // Rule 2: server-script-missing-default-export
  if (body.trim().length > 0 && !opts.hasSrcAttribute) {
    if (!/^\s*export\s+default\b/m.test(body)) {
      const match = /\S+/.exec(body);
      const start = match ? match.index : 0;
      const end = match ? match.index + match[0].length : 0;
      diagnostics.push({
        code: 'server-script-missing-default-export',
        message: `A data-bascik-${opts.directive} script must \`export default\` a function \`(request, context, { signal })\`. Bascik loads it as an ES module and calls the default export on each request.`,
        severity: 'error',
        start,
        end,
      });
    }
  }

  // Rule 3: server-script-legacy-request-shape
  // Any of req.searchParams, req.headers[, req.path, req.method as a member expression,
  // or a parameter list matching \(\s*\{\s*req\s*\} (the destructured first argument).
  // One diagnostic per occurrence, ranged on the occurrence. Message names the replacement:
  // - req.searchParams.x -> new URL(request.url).searchParams.get('x')
  // - req.headers['x'] -> request.headers.get('x')
  // - req.path -> new URL(request.url).pathname
  // - req.method -> request.method
  // - ({ req }) -> (request, context, { signal })
  const legacyPatterns: Array<{ regex: RegExp; replacement: string; patternName: string }> = [
    {
      regex: /\(\s*\{\s*req\s*\}\s*\)/g,
      replacement: '(request, context, { signal })',
      patternName: '({ req })',
    },
    {
      regex: /\breq\.searchParams\b/g,
      replacement: "new URL(request.url).searchParams.get('x')",
      patternName: 'req.searchParams.x',
    },
    {
      regex: /\breq\.headers\s*\[/g,
      replacement: "request.headers.get('x')",
      patternName: "req.headers['x']",
    },
    {
      regex: /\breq\.path\b/g,
      replacement: 'new URL(request.url).pathname',
      patternName: 'req.path',
    },
    {
      regex: /\breq\.method\b/g,
      replacement: 'request.method',
      patternName: 'req.method',
    },
  ];

  const matchedLegacyRanges: Array<{ start: number; end: number; diag: ServerScriptDiagnostic }> = [];

  for (const { regex, replacement, patternName } of legacyPatterns) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(body)) !== null) {
      matchedLegacyRanges.push({
        start: match.index,
        end: match.index + match[0].length,
        diag: {
          code: 'server-script-legacy-request-shape',
          message: `Legacy request property \`${patternName}\` was removed in Bascik. Use \`${replacement}\` instead.`,
          severity: 'error',
          start: match.index,
          end: match.index + match[0].length,
        },
      });
    }
  }

  matchedLegacyRanges.sort((a, b) => a.start - b.start);
  for (const item of matchedLegacyRanges) {
    diagnostics.push(item.diag);
  }

  // Rule 4: server-script-legacy-output
  // process.stdout.write(, process.env.BASCIK_REQUEST, or bare top-level console.log(
  const stdoutRegex = /\bprocess\.stdout\.write\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = stdoutRegex.exec(body)) !== null) {
    diagnostics.push({
      code: 'server-script-legacy-output',
      message: 'Server scripts return their markup from the default export. stdout and console.log are not captured.',
      severity: 'error',
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const envReqRegex = /\bprocess\.env\.BASCIK_REQUEST\b/g;
  while ((match = envReqRegex.exec(body)) !== null) {
    diagnostics.push({
      code: 'server-script-legacy-output',
      message: 'Server scripts return their markup from the default export. stdout and console.log are not captured.',
      severity: 'error',
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  // Top-level console.log heuristic:
  // Either export default is missing, or console.log occurs outside the export default function body.
  const hasExportDefault = /^\s*export\s+default\b/m.test(body);
  const exportDefaultIndex = body.search(/^\s*export\s+default\b/m);

  // Find end of export default function if possible, or if console.log is before export default
  const consoleLogRegex = /\bconsole\.log\s*\(/g;
  while ((match = consoleLogRegex.exec(body)) !== null) {
    let isTopLevel = false;
    if (!hasExportDefault) {
      isTopLevel = true;
    } else if (match.index < exportDefaultIndex) {
      isTopLevel = true;
    } else {
      // Check if after export default function ends
      // Find the body of export default
      // If export default is `export default ... { ... }` or `export default ... => ...`
      // Let's find braces after exportDefaultIndex
      const afterExport = body.slice(exportDefaultIndex);
      const openBraceOffset = afterExport.indexOf('{');
      if (openBraceOffset !== -1) {
        // scan matching brace
        let depth = 0;
        let closeBraceIndex = -1;
        for (let i = openBraceOffset; i < afterExport.length; i++) {
          if (afterExport[i] === '{') depth++;
          else if (afterExport[i] === '}') {
            depth--;
            if (depth === 0) {
              closeBraceIndex = exportDefaultIndex + i;
              break;
            }
          }
        }
        if (closeBraceIndex !== -1 && match.index > closeBraceIndex) {
          isTopLevel = true;
        }
      }
    }

    if (isTopLevel) {
      diagnostics.push({
        code: 'server-script-legacy-output',
        message: 'Server scripts return their markup from the default export. stdout and console.log are not captured.',
        severity: 'error',
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  // Rule 5: server-script-bascik-import
  // An ESM import whose specifier is exactly @bascik/bascik or starts with @bascik/bascik/
  const moduleSpecifiers = findModuleSpecifiers(body);
  for (const { start, end, value } of moduleSpecifiers) {
    if (value === '@bascik/bascik' || value.startsWith('@bascik/bascik/')) {
      diagnostics.push({
        code: 'server-script-bascik-import',
        message: '`@bascik/bascik` exports nothing for use inside a server script. Escaping and other helpers belong in your project, for example `@/lib/server.ts`.',
        severity: 'error',
        start,
        end,
      });
    }
  }

  // Part C: Sink rules (template literal placeholders)
  const placeholders = findTemplatePlaceholders(body);
  for (const { placeholderStart, placeholderEnd, expr, precedingInLiteral } of placeholders) {
    // A placeholder inside a <!-- --> comment within the literal is skipped.
    const lastCommentOpen = precedingInLiteral.lastIndexOf('<!--');
    const lastCommentClose = precedingInLiteral.lastIndexOf('-->');
    if (lastCommentOpen !== -1 && lastCommentClose < lastCommentOpen) {
      continue;
    }

    // 1. URL attribute
    // Inside a quoted href, src, action, formaction, poster, data, srcset, xlink:href value:
    // \b(?:href|src|action|formaction|poster|data|srcset|xlink:href)\s*=\s*["'][^"']*$
    const urlAttrRegex = /\b(?:href|src|action|formaction|poster|data|srcset|xlink:href)\s*=\s*["'][^"']*$/i;
    if (urlAttrRegex.test(precedingInLiteral)) {
      diagnostics.push({
        code: 'server-script-sink-url-attribute',
        message: 'URL attribute. HTML entity escaping does not neutralize `javascript:` or `data:` URLs. Validate with `new URL(value, base)` and allow-list `http:` and `https:`.',
        severity: 'warning',
        start: placeholderStart,
        end: placeholderEnd,
      });
      continue;
    }

    // 2. Event handler attribute
    // Inside a quoted on* attribute value: \bon[a-z]+\s*=\s*["'][^"']*$
    const eventHandlerRegex = /\bon[a-z]+\s*=\s*["'][^"']*$/i;
    if (eventHandlerRegex.test(precedingInLiteral)) {
      diagnostics.push({
        code: 'server-script-sink-event-handler',
        message: 'Event handler attribute. There is no safe way to interpolate untrusted data here. Move the value to a `data-*` attribute and read it from a static client script.',
        severity: 'warning',
        start: placeholderStart,
        end: placeholderEnd,
      });
      continue;
    }

    // 4. Inline <script> body
    // An unclosed <script tag precedes the placeholder within the literal: last <script\b[^>]*> after the last </script>
    const scriptOpenMatches = [...precedingInLiteral.matchAll(/<script\b[^>]*>/gi)];
    const lastScriptOpen = scriptOpenMatches.length > 0 ? (scriptOpenMatches[scriptOpenMatches.length - 1].index ?? -1) : -1;
    const scriptCloseMatches = [...precedingInLiteral.matchAll(/<\/script>/gi)];
    const lastScriptClose = scriptCloseMatches.length > 0 ? (scriptCloseMatches[scriptCloseMatches.length - 1].index ?? -1) : -1;
    if (lastScriptOpen !== -1 && lastScriptOpen > lastScriptClose) {
      diagnostics.push({
        code: 'server-script-sink-inline-script',
        message: 'Inline `<script>` body. Entity escaping does not apply in JavaScript context. Serialize to a `data-*` attribute or a `<script type="application/json">` with `<` escaped as `\\u003c`.',
        severity: 'warning',
        start: placeholderStart,
        end: placeholderEnd,
      });
      continue;
    }

    // 5. Style context
    // Inside a quoted style attribute or an unclosed <style tag
    const styleAttrRegex = /\bstyle\s*=\s*["'][^"']*$/i;
    const styleOpenMatches = [...precedingInLiteral.matchAll(/<style\b[^>]*>/gi)];
    const lastStyleOpen = styleOpenMatches.length > 0 ? (styleOpenMatches[styleOpenMatches.length - 1].index ?? -1) : -1;
    const styleCloseMatches = [...precedingInLiteral.matchAll(/<\/style>/gi)];
    const lastStyleClose = styleCloseMatches.length > 0 ? (styleCloseMatches[styleCloseMatches.length - 1].index ?? -1) : -1;
    const isInsideStyleTag = lastStyleOpen !== -1 && lastStyleOpen > lastStyleClose;

    if (styleAttrRegex.test(precedingInLiteral) || isInsideStyleTag) {
      diagnostics.push({
        code: 'server-script-sink-style',
        message: 'CSS context. Do not interpolate untrusted data into styles.',
        severity: 'warning',
        start: placeholderStart,
        end: placeholderEnd,
      });
      continue;
    }

    // 3. Unquoted attribute
    // \s[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*$ (an = with no opening quote)
    const unquotedAttrRegex = /\s[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=\s*$/;
    if (unquotedAttrRegex.test(precedingInLiteral)) {
      diagnostics.push({
        code: 'server-script-sink-unquoted-attribute',
        message: 'Unquoted attribute. A space in the value breaks out of the attribute. Quote it: `attr="${...}"`.',
        severity: 'warning',
        start: placeholderStart,
        end: placeholderEnd,
      });
      continue;
    }

    // 6. Text unescaped
    // None of the above, and the placeholder expression is not a call expression
    // and does reference request-derived data: contains request., context., searchParams, .headers.get(, or URL(request.url)
    const trimmedExpr = expr.trim();
    const referencesRequestData =
      trimmedExpr.includes('request.') ||
      trimmedExpr.includes('context.') ||
      trimmedExpr.includes('searchParams') ||
      trimmedExpr.includes('.headers.get(') ||
      trimmedExpr.includes('URL(request.url)');

    // Check if the expression is wrapped in a function call (e.g. escape(...), sanitize(...), fn(...))
    // Note: direct request/context access like `request.headers.get(...)` or `new URL(...)` is accessing request data, not an escaping wrapper.
    const isEscapingCall =
      /^[A-Za-z_$][\w$]*\s*\(/.test(trimmedExpr) &&
      !trimmedExpr.startsWith('request.') &&
      !trimmedExpr.startsWith('context.') &&
      !trimmedExpr.startsWith('new URL(');

    if (!isEscapingCall && referencesRequestData) {
      diagnostics.push({
        code: 'server-script-sink-text-unescaped',
        message: 'Untrusted request value interpolated without an escaping function. Wrap it, for example `escape(value)` from your `@/lib/server.ts`.',
        severity: 'info',
        start: placeholderStart,
        end: placeholderEnd,
      });
    }
  }

  return diagnostics;
}
