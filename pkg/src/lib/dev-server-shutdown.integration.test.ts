import { afterEach, describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

let portCounter = 9800 + (process.pid % 100);
const nextPort = (): number => portCounter++;

// Every spawned server, so one a timed-out test never reached `finally` for
// is still killed instead of left listening.
const spawned = new Set<ChildProcess>();
afterEach(() => {
  for (const child of spawned)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  spawned.clear();
});

interface RunningServer {
  child: ChildProcess;
  port: number;
  url: string;
  output: () => string;
}

const spawnDevServer = async (
  root: string,
  options: { tls?: boolean } = {},
): Promise<RunningServer> => {
  const port = nextPort();
  const child = spawn(process.execPath, [PKG_ENTRY], {
    cwd: root,
    env: {
      ...process.env,
      BASCIK_SERVER_PORT: String(port),
      BASCIK_BUILD: "0",
      BASCIK_SERVER: "0",
      VITEST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.add(child);

  let output = "";
  const onData = (d: Buffer) => {
    output += d.toString();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  // Wait for server ready line. The server moves to the next port when the
  // requested one is taken (by a parallel test file or a stray server), so
  // the URL comes from the line it prints, never from the requested port.
  let url = "";
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error(`Server failed to boot within 15s. Output:\n${output}`));
    }, 15000);

    const check = () => {
      // nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const ready = output
        .replace(
          new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"),
          "",
        )
        .match(/Server running at\s+(https?:\/\/\S+)\s/);
      if (ready) {
        clearTimeout(timer);
        url = ready[1].replace(/\/$/, "");
        res();
      } else if (child.exitCode !== null) {
        clearTimeout(timer);
        rej(
          new Error(
            `Server exited early with code ${child.exitCode}. Output:\n${output}`,
          ),
        );
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  const scheme = options.tls ? "https" : "http";
  expect(url.startsWith(`${scheme}://`)).toBe(true);
  return {
    child,
    port: Number(new URL(url).port),
    url,
    output: () => output,
  };
};

describe("Dev server SSE shutdown hang (Prompt 146)", () => {
  it("HTTP/1.1: exits with code 0 in under 1500ms when an SSE client is connected", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "bascik-sse-h1-"));
    let server: RunningServer | undefined;
    let sseReq: http.ClientRequest | undefined;

    try {
      await mkdir(join(fixtureDir, "src/pages"), { recursive: true });
      await mkdir(join(fixtureDir, "src/components"), { recursive: true });
      await writeFile(
        join(fixtureDir, "src/pages/index.html"),
        "<!DOCTYPE html><html><body><h1>Dev Server</h1></body></html>",
        "utf8",
      );

      server = await spawnDevServer(fixtureDir);

      // Connect an SSE client to /bascik-live-reload
      await new Promise<void>((resolve) => {
        sseReq = http.get(
          `${server!.url}/bascik-live-reload`,
          { headers: { Accept: "text/event-stream" } },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toBe("text/event-stream");
            // Wait for initial "data: connected\n\n"
            res.on("data", (chunk: Buffer) => {
              if (chunk.toString().includes("connected")) {
                resolve();
              }
            });
          },
        );
        sseReq.on("error", () => {
          // May emit ECONNRESET on shutdown, ignore after connection is up
        });
      });

      // Now send SIGINT to child process and record duration
      const startTime = Date.now();
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        server!.child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });

      server.child.kill("SIGINT");
      const { code } = await exitPromise;
      const durationMs = Date.now() - startTime;

      expect(code).toBe(0);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      try {
        sseReq?.destroy();
      } catch {}
      if (server && server.child.exitCode === null) {
        server.child.kill("SIGKILL");
      }
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 20000);

  it("HTTP/2 (TLS): exits with code 0 in under 1500ms when an SSE client is connected", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "bascik-sse-h2-"));
    let server: RunningServer | undefined;
    let sseReq: http.ClientRequest | undefined;

    try {
      await mkdir(join(fixtureDir, "src/pages"), { recursive: true });
      await mkdir(join(fixtureDir, "src/components"), { recursive: true });
      await writeFile(
        join(fixtureDir, "src/pages/index.html"),
        "<!DOCTYPE html><html><body><h1>Dev Server TLS</h1></body></html>",
        "utf8",
      );
      await writeFile(
        join(fixtureDir, "bascik.config.ts"),
        "export default { http: { tls: { enabled: true } } };\n",
        "utf8",
      );

      server = await spawnDevServer(fixtureDir, { tls: true });

      // Connect an SSE client to /bascik-live-reload via HTTPS (self-signed cert rejected unauthorized false)
      await new Promise<void>((resolve) => {
        sseReq = https.get(
          `${server!.url}/bascik-live-reload`,
          {
            headers: { Accept: "text/event-stream" },
            // codeql[js/disabling-certificate-validation] Test-only client of a localhost server with a self-signed cert.
            rejectUnauthorized: false,
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toBe("text/event-stream");
            res.on("data", (chunk: Buffer) => {
              if (chunk.toString().includes("connected")) {
                resolve();
              }
            });
          },
        );
        sseReq.on("error", () => {});
      });

      // Send SIGINT to child process and record duration
      const startTime = Date.now();
      const exitPromise = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        server!.child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });

      server.child.kill("SIGINT");
      const { code } = await exitPromise;
      const durationMs = Date.now() - startTime;

      expect(code).toBe(0);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      try {
        sseReq?.destroy();
      } catch {}
      if (server && server.child.exitCode === null) {
        server.child.kill("SIGKILL");
      }
      await rm(fixtureDir, { recursive: true, force: true });
    }
  }, 20000);
});
