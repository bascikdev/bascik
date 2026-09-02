export interface ApiRouteDiagnostic {
  message: string;
  severity: "error" | "warning";
  range?: { startLine: number; startChar: number; endLine: number; endChar: number };
}

const VALID_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const METHOD_LIKE_REGEX = /\bexport\s+(?:async\s+)?(?:const|function|let|var)\s+([a-zA-Z0-9_$]+)\b/g;

export function analyzeApiRouteSource(text: string): ApiRouteDiagnostic[] {
  const diagnostics: ApiRouteDiagnostic[] = [];
  METHOD_LIKE_REGEX.lastIndex = 0;

  const exportedNames: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = METHOD_LIKE_REGEX.exec(text)) !== null) {
    const name = match[1];
    exportedNames.push(name);

    // Warning: lowercase or mixed-case export that looks like a method (e.g. `post`, `Get`, `pOST`)
    const upper = name.toUpperCase();
    if (VALID_METHODS.has(upper) && name !== upper) {
      diagnostics.push({
        message: `API route method export "${name}" must be uppercase ("${upper}"). Lowercase or mixed-case HTTP methods are not recognized by the dispatcher.`,
        severity: "warning",
      });
    }

    // Warning: handler whose return type is annotated and not Response / Promise<Response>
    // Check for pattern like: `export const GET = async (...): Promise<string> =>` or `export function GET(...): string`
    const lineStartIndex = text.lastIndexOf("\n", match.index) + 1;
    const lineEndIndex = text.indexOf("\n", match.index);
    const line = text.slice(lineStartIndex, lineEndIndex === -1 ? undefined : lineEndIndex);

    const returnTypeMatch = line.match(/:\s*(?:Promise<([a-zA-Z0-9_$]+)>|([a-zA-Z0-9_$]+))\s*(?:=>|\{)/);
    if (returnTypeMatch) {
      const returnType = returnTypeMatch[1] ?? returnTypeMatch[2];
      if (returnType && returnType !== "Response" && returnType !== "any" && returnType !== "unknown") {
        diagnostics.push({
          message: `API route handler "${name}" has return type "${returnType}". Handlers must return a standard WHATWG Response (or Promise<Response>).`,
          severity: "warning",
        });
      }
    }
  }

  const hasRecognizedMethod = exportedNames.some((n) => VALID_METHODS.has(n));
  if (!hasRecognizedMethod) {
    diagnostics.push({
      message: `API route file does not export any recognized HTTP method handler (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).`,
      severity: "error",
    });
  }

  return diagnostics;
}
