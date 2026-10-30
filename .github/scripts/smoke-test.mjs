#!/usr/bin/env node
// Checks that a deployed site answers each path with the expected status.
// Redirects are not followed, so a 301 is checked as a 301. Each path is
// retried for a short while, because a new Preview alias or deployment can
// take a few seconds to reach every Cloudflare location.
//
// Usage: node .github/scripts/smoke-test.mjs <base-url> <path>=<status>...
// Example: node .github/scripts/smoke-test.mjs https://bascik.dev /=200 /semantic-html=301
// SMOKE_ATTEMPTS (default 6) and SMOKE_DELAY_MS (default 10000) tune the retry.

/** @typedef {{ path: string; status: number }} SmokeCheck */

/**
 * @param {readonly string[]} args `<path>=<status>` arguments.
 * @returns {SmokeCheck[]}
 */
export function parseChecks(args) {
  if (args.length === 0)
    throw new Error("smoke-test: name at least one <path>=<status> check");
  return args.map((arg) => {
    const at = arg.lastIndexOf("=");
    const path = at < 0 ? "" : arg.slice(0, at);
    const status = at < 0 ? NaN : Number(arg.slice(at + 1));
    if (
      !path.startsWith("/") ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    )
      throw new Error(
        `smoke-test: "${arg}" is not <path>=<status>, such as /catalog=200`,
      );
    return { path, status };
  });
}

/**
 * @param {string} baseUrl Such as `https://bascik.dev`.
 * @param {readonly SmokeCheck[]} checks
 * @param {{ attempts?: number; delayMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; log?: (line: string) => void }} [options]
 * @returns {Promise<string[]>} One line per check that never answered as expected; empty when all passed.
 */
export async function smokeTest(baseUrl, checks, options = {}) {
  const {
    attempts = 6,
    delayMs = 10_000,
    timeoutMs = 15_000,
    fetchImpl = fetch,
    log = (line) => console.log(line),
  } = options;
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`smoke-test: "${baseUrl}" is not a URL`);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:")
    throw new Error(`smoke-test: "${baseUrl}" is not an http(s) URL`);
  const failures = [];
  for (const { path, status } of checks) {
    const url = new URL(path, base).href;
    let last = "no response";
    let passed = false;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetchImpl(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        last = `status ${response.status}`;
        if (response.status === status) {
          passed = true;
          break;
        }
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (attempt < attempts) {
        log(
          `${url}: ${last}, expected ${status}; retrying (${attempt}/${attempts})`,
        );
        await new Promise((done) => setTimeout(done, delayMs));
      }
    }
    if (passed) log(`${url}: ${status} ok`);
    else failures.push(`${url}: ${last}, expected ${status}`);
  }
  return failures;
}

if (import.meta.main) {
  const [baseUrl, ...args] = process.argv.slice(2);
  try {
    if (!baseUrl) throw new Error("smoke-test: pass the base URL first");
    const failures = await smokeTest(baseUrl, parseChecks(args), {
      attempts: Number(process.env.SMOKE_ATTEMPTS) || undefined,
      delayMs: Number(process.env.SMOKE_DELAY_MS) || undefined,
    });
    for (const failure of failures) console.error(`::error::${failure}`);
    if (failures.length) process.exit(1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
