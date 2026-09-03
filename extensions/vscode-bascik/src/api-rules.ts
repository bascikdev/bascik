export interface ApiRouteDiagnostic {
  message: string;
  severity: "error" | "warning" | "info";
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

  // Info diagnostic: request.json() or req.json() called without surrounding try/catch
  // Matches \b(?:request|req)\.json\(\)
  const jsonCallRegex = /\b(?:request|req)\.json\s*\(/g;
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonCallRegex.exec(text)) !== null) {
    // Check if there is a surrounding try block before this index in the function scope
    // Simple heuristic: check if `try {` appears before jsonMatch.index without a closing `}` before it
    const prefix = text.slice(0, jsonMatch.index);
    const lastTry = prefix.lastIndexOf("try");
    const lastCatch = prefix.lastIndexOf("catch");
    const insideTry = lastTry !== -1 && (lastCatch === -1 || lastTry > lastCatch);

    if (!insideTry) {
      diagnostics.push({
        message: `Calling request.json() without a surrounding try/catch will throw an unhandled error on malformed JSON payloads (resulting in a 500 response). Consider wrapping in a try/catch or validating input.`,
        severity: "info",
      });
    }
  }

  return diagnostics;
}
