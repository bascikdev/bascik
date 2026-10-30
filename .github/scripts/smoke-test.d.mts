export interface SmokeCheck {
  path: string;
  status: number;
}
export declare function parseChecks(args: readonly string[]): SmokeCheck[];
export declare function smokeTest(
  baseUrl: string,
  checks: readonly SmokeCheck[],
  options?: {
    attempts?: number;
    delayMs?: number;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    log?: (line: string) => void;
  },
): Promise<string[]>;
