/**
 * Prompt 147: dev server boot transpile timing and single-thread bottleneck diagnostic.
 *
 * Spawns a real dev server child process against an isolated fixture with 40 pages
 * and components with heavy scoped styles and scoped client scripts.
 *
 * Verifies:
 * 1. No single page reports > 5x the median duration (preventing queue-wait staircase inflation).
 * 2. Sum of per-page durations is bounded against the batch wall time (catches staircase stretch).
 * 3. Diagnostic tip is conditionally asserted if boot wall time meets the >=2000ms boundary on 4+ cores.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir, cpus } from "node:os";
import { fileURLToPath } from "node:url";

const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");

interface DevServer {
  logs(): string;
  close(): Promise<void>;
}

let portCounter = 9800 + (process.pid % 100);
const nextPort = (): number => portCounter++;

const startDevServer = async (root: string): Promise<DevServer> => {
  const port = nextPort();
  const child = spawn(process.execPath, [PKG_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_ENABLE_TLS: "false",
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "0",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let closed = false;
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  const close = async (): Promise<void> => {
    if (closed) return;
    child.kill("SIGTERM");
    const deadline = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 3000);
    try {
      await childClosed;
    } finally {
      clearTimeout(deadline);
    }
  };

  let output = "";
  const waiters: Array<{ pattern: RegExp; from: number; resolve: (s: string) => void; reject: (err: Error) => void }> = [];

  const onData = (d: Buffer): void => {
    output += d.toString();
    for (const waiter of [...waiters]) {
      const slice = output.slice(waiter.from);
      if (waiter.pattern.test(slice)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(slice);
      }
    }
  };

  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const cleanupListeners = (): void => {
    child.stdout?.off("data", onData);
    child.stderr?.off("data", onData);
    child.off("error", onError);
    child.off("exit", onExit);
  };

  const onError = (err: Error): void => {
    cleanupListeners();
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`Dev server process error: ${err.message}\nOutput:\n${output}`));
    }
  };

  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    cleanupListeners();
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error(`Dev server exited early with code ${code}, signal ${signal}\nOutput:\n${output}`));
    }
  };

  child.once("error", onError);
  child.once("exit", onExit);

  const waitForLog = (pattern: RegExp, timeoutMs = 30000): Promise<string> => {
    const from = 0;
    if (pattern.test(output.slice(from))) return Promise.resolve(output.slice(from));
    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === wrappedRes);
        if (idx >= 0) waiters.splice(idx, 1);
        rej(new Error(`log ${pattern} not seen within ${timeoutMs}ms. Output:\n${output}`));
      }, timeoutMs);
      const wrappedRes = (s: string): void => {
        clearTimeout(timer);
        res(s);
      };
      const wrappedRej = (err: Error): void => {
        clearTimeout(timer);
        rej(err);
      };
      waiters.push({ pattern, from, resolve: wrappedRes, reject: wrappedRej });
    });
  };

  try {
    await waitForLog(/Server running at/, 30000);
  } catch (err) {
    await close();
    throw err;
  }

  return {
    logs: () => output,
    close,
  };
};

const writeAt = async (root: string, rel: string, content: string): Promise<string> => {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return abs;
};

// Generate realistic heavy scoped CSS rules across classes, child selectors, and media queries
const makeHeavyCss = (id: number): string => {
  const rules: string[] = [];
  for (let i = 0; i < 1200; i++) {
    rules.push(`.card-${id}-${i} { color: #333; padding: 10px; margin: 4px; display: flex; align-items: center; }`);
    rules.push(`.card-${id}-${i} > span { font-weight: bold; font-size: 14px; }`);
    rules.push(`@media (min-width: 768px) { .card-${id}-${i} { padding: 20px; } }`);
  }
  return rules.join("\n");
};

describe("dev boot transpile timing and worker diagnostic", () => {
  it("reports per-page durations bounded near work rather than staircase and checks worker advisory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bascik-147-dev-"));
    let server: DevServer | null = null;
    try {

    await writeAt(
      root,
      "bascik.config.js",
      `module.exports = {
  directory: { components: ["src/components"] },
  pipeline: { workers: false },
  logging: { level: "info", requests: false },
  generate: { sitemap: false, robots: false },
  minify: { html: false, css: false, js: false, identifiers: false },
};`,
    );

    // Component with heavy scoped styles and client script (DOM scoping, event binding)
    await writeAt(
      root,
      "src/components/heavy-card/heavy-card.html",
      `<div class="heavy-card" id="card-root">
  <style>
    ${makeHeavyCss(1)}
  </style>
  <p class="title" data-bascik-prop-title>Default Title</p>
  <script>
    const root = document.getElementById("card-root");
    root.addEventListener("click", () => {
      console.log("Card clicked:", root.dataset);
    });
  </script>
</div>`,
    );

    // Create 40 pages that each instantiate multiple heavy components
    for (let i = 1; i <= 40; i++) {
      await writeAt(
        root,
        `src/pages/page-${i}.html`,
        `<!DOCTYPE html>
<html>
<head><title>Page ${i}</title></head>
<body>
  <h1>Page ${i}</h1>
  <heavy-card data-bascik-prop-title="Page ${i} A"></heavy-card>
  <heavy-card data-bascik-prop-title="Page ${i} B"></heavy-card>
  <heavy-card data-bascik-prop-title="Page ${i} C"></heavy-card>
  <heavy-card data-bascik-prop-title="Page ${i} D"></heavy-card>
</body>
</html>`,
      );
    }

    server = await startDevServer(root);
    const logs = server.logs();

    // Extract all per-page transpile durations in ms
    const transpiledLines = logs
      .split("\n")
      .filter((line) => line.includes("transpiled: pages/page-"));

    expect(transpiledLines.length).toBe(40);

    const durations: number[] = [];
    let reportedSum = 0;
    for (const line of transpiledLines) {
      const match = line.match(/in\s+(\d+(?:\.\d+)?)(ms|s)/);
      expect(match).not.toBeNull();
      const val = parseFloat(match![1]);
      const unit = match![2];
      const ms = unit === "s" ? val * 1000 : val;
      durations.push(ms);
      reportedSum += ms;
    }

    // Calculate median
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median).toBeGreaterThan(0);

    // Bound individual outliers; the sum assertion below detects cumulative queue time.
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(median * 5);
    }

    // Extract total boot time
    const totalMatch = logs.match(/✓\s+40\s+pages\s+transpiled\s+in\s+(\d+(?:\.\d+)?)(ms|s)/);
    expect(totalMatch).not.toBeNull();
    const totalVal = parseFloat(totalMatch![1]);
    const totalUnit = totalMatch![2];
    const batchWallMs = totalUnit === "s" ? totalVal * 1000 : totalVal;

    // (b) Check sum of per-page durations against batch wall time
    // Under CPU-segment accumulation, the sum of per-page compute cannot exceed wall time.
    expect(batchWallMs).toBeGreaterThan(0);
    expect(reportedSum).toBeLessThanOrEqual(batchWallMs * 1.05);

    // (c) Advisory diagnostic check: conditional on runtime elapsed time (no hard 2s failure on fast hardware)
    const coreCount = cpus().length;
    // formatDuration rounds seconds, so a printed 2s can straddle the threshold.
    // Exact threshold behavior is exercised by processAllPages unit tests.
    if (coreCount >= 4 && batchWallMs > 2010) {
      expect(logs).toContain("💡 Boot transpilation took");
      expect(logs).toContain("pipeline.workers: true");
    } else if (coreCount < 4 || batchWallMs < 1990) {
      expect(logs).not.toContain("💡 Boot transpilation took");
    }
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 45000);
});
