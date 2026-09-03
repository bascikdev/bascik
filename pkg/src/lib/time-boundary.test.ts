import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Designated framework semantic-time modules.
 * These modules own semantic scheduling, deadlines, or rate-limiting in Bascik
 * and MUST use `FrameworkClock` / `clock.*` seam rather than direct ambient timer globals.
 */
export const DESIGNATED_FRAMEWORK_MODULES = [
  "api-runtime.ts",
  "script-registry.ts",
  "debounce.ts",
  "exec.ts",
  "rate-limit.ts",
  "script-cache.ts",
  "sse.ts",
  "server-lifecycle.ts",
] as const;

/**
 * Legitimate non-semantic ambient time classifications and allowlist.
 * If a new ambient timer is introduced, it must be classified here with an explicit one-line entry
 * rather than bypassing the architectural boundary.
 *
 * Classification Categories:
 * - `telemetry`: High-resolution wall-clock duration profiling (`performance.now()`)
 * - `uniqueness`: Random/unique identifier entropy or build artifact naming (`Date.now()`)
 * - `browser-code`: Client-side code delivered to and executed in the browser (e.g. `live-reload.ts`)
 * - `native-adapter`: The frozen FrameworkClock root adapter implementation (`clock.ts`)
 * - `external-watchdog`: Process-level test harness, runner, or OS socket timeouts
 * - `test-files`: Test suites exercising external systems or fake timer controls
 */
export interface AllowedAmbientTimerEntry {
  file: string;
  category: "telemetry" | "uniqueness" | "browser-code" | "native-adapter" | "external-watchdog" | "test-files";
  reason: string;
}

export const ALLOWED_AMBIENT_TIMERS: AllowedAmbientTimerEntry[] = [
  { file: "clock.ts", category: "native-adapter", reason: "Root native FrameworkClock implementation delegating to Node globals" },
  { file: "live-reload.ts", category: "browser-code", reason: "Browser-side client script executed in page context" },
  { file: "build-scripts.ts", category: "uniqueness", reason: "Unique filename generation for temporary build artifacts" },
  { file: "routes.ts", category: "uniqueness", reason: "Unique filename generation for temporary route artifacts" },
];

/**
 * Strips block comments, line comments, and string literals from TypeScript/JavaScript source code
 * so that timer occurrences in prose, log strings, or comments are not flagged as code violations.
 */
function stripCommentsAndStrings(source: string): string {
  // Regex to match string literals (single, double, template) and comments (single-line, multi-line)
  return source.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:\\[\s\S]|[^`\\])*`)|(\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match, str, comment) => {
      if (comment) return " ";
      if (str) return '""';
      return match;
    }
  );
}

/**
 * Checks whether source code contains ambient/direct timer or system time calls.
 * Allowed:
 * - clock.setTimeout, this.clock.setTimeout, etc.
 * - performance.now()
 * - Type references (e.g. TimeoutHandle = ReturnType<typeof setTimeout>)
 * Disallowed:
 * - Direct calls to setTimeout(...), setInterval(...), Date.now(), new Date()
 */
export function findAmbientTimeViolations(sourceCode: string): string[] {
  const stripped = stripCommentsAndStrings(sourceCode);
  const violations: string[] = [];

  // Patterns to detect disallowed ambient calls:
  // 1. Direct setTimeout(...) or setInterval(...) not prefixed with clock. or this.clock. or globalThis. or window.
  // Matching identifier followed by optional spaces and '('
  // We use regex lookbehind / boundary checks.
  const timerCallRegex = /(?<!\b(?:clock|this\.clock)\s*\.\s*)(?<!\btypeof\s+)\b(setTimeout|setInterval)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = timerCallRegex.exec(stripped)) !== null) {
    violations.push(match[1]);
  }

  // 2. Direct Date.now() not preceded by clock.
  const dateNowRegex = /(?<!\b(?:clock|this\.clock)\s*\.\s*)\bDate\.now\s*\(/g;
  while ((match = dateNowRegex.exec(stripped)) !== null) {
    violations.push("Date.now()");
  }

  // 3. Direct new Date(...)
  const newDateRegex = /\bnew\s+Date\s*\(/g;
  while ((match = newDateRegex.exec(stripped)) !== null) {
    violations.push("new Date()");
  }

  return violations;
}

describe("Time-boundary Architecture & Enforcement", () => {
  it("detects deliberate ambient timer violations in synthetic probe source", () => {
    const probeSource = `
      export function scheduleTask(cb: () => void) {
        setTimeout(cb, 100);
        setInterval(cb, 200);
        const t = Date.now();
        const d = new Date();
        return { t, d };
      }
    `;
    const violations = findAmbientTimeViolations(probeSource);
    expect(violations).toContain("setTimeout");
    expect(violations).toContain("setInterval");
    expect(violations).toContain("Date.now()");
    expect(violations).toContain("new Date()");
  });

  it("ignores timer mentions in comments, string literals, and type annotations", () => {
    const benignSource = `
      // setTimeout(fn, 1000) should be avoided
      /* multi-line comment: setInterval(fn, 500) and Date.now() */
      const msg = "Don't call new Date() or setTimeout() directly";
      export type MyHandle = ReturnType<typeof setTimeout>;
      export type MyInterval = ReturnType<typeof setInterval>;
      export function ok(clock: FrameworkClock) {
        clock.setTimeout(() => {}, 100);
        this.clock.setInterval(() => {}, 200);
        const elapsed = performance.now();
        return elapsed;
      }
    `;
    const violations = findAmbientTimeViolations(benignSource);
    expect(violations).toEqual([]);
  });

  it.each(DESIGNATED_FRAMEWORK_MODULES)(
    "designated module %s contains zero ambient timer or date globals",
    (moduleName) => {
      const modulePath = resolve(__dirname, moduleName);
      const source = readFileSync(modulePath, "utf-8");
      const violations = findAmbientTimeViolations(source);
      expect(
        violations,
        `Found ambient time violations in ${moduleName}: ${violations.join(", ")}`
      ).toEqual([]);
    }
  );
});
