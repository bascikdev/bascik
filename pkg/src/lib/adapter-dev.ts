import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform, pipeline } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import type { CliFlags } from "./cli.ts";
import { resolveAdapterTarget } from "./adapter-resolution.ts";
import { availableDevPort } from "./adapter-dev-platform.ts";
import { registerExitStopper } from "./exit-stoppers.ts";
import { isSameOrInside } from "./path-containment.ts";
import {
  formatServerOrigin,
  hostnameExpectation,
  isPlausibleHostname,
  parsePort,
} from "./server-address.ts";

const CLIENT = "/__bascik_adapter_dev/client.js";
const EVENTS = "/__bascik_adapter_dev/events";

export const adapterDevClient = `
(() => {
  const version = Number(new URL(document.currentScript.src).searchParams.get("v"));
  const source = new EventSource("${EVENTS}");
  let errorDialog;
  source.onmessage = ({ data }) => {
    const state = JSON.parse(data);
    if (state.error && !errorDialog) {
      errorDialog = document.createElement("dialog");
      errorDialog.setAttribute("role", "alertdialog");
      const message = document.createElement("p");
      message.textContent = state.error;
      const dismiss = document.createElement("button");
      dismiss.textContent = "Dismiss";
      dismiss.onclick = () => { errorDialog.remove(); errorDialog = null; };
      errorDialog.append(message, dismiss);
      document.body.append(errorDialog);
      errorDialog.showModal();
    }
    if (!state.busy && !state.error && state.generation > version) location.reload();
  };
  addEventListener("pagehide", () => source.close(), { once: true });
})();
`;

/** Inject early without holding the response's delayed stream chunks. */
export class AdapterDevHtmlTransform extends Transform {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private injected = false;
  constructor(private generation: number) {
    super();
  }
  private emitHtml(final: boolean): void {
    const head = /<head(?:\s[^>]*)?>/i.exec(this.pending);
    if (head) {
      const at = head.index + head[0].length;
      this.push(
        this.pending.slice(0, at) +
          `<script data-bascik-live-reload src="${CLIENT}?v=${this.generation}" defer></script>` +
          this.pending.slice(at),
      );
      this.pending = "";
      this.injected = true;
    } else if (final || this.pending.length > 262_144) {
      // Fragments have no document head; do not turn API HTML into a document.
      this.push(this.pending);
      this.pending = "";
      this.injected = true;
    }
  }
  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    if (this.injected) this.push(this.decoder.write(chunk));
    else {
      this.pending += this.decoder.write(chunk);
      this.emitHtml(false);
    }
    done();
  }
  override _flush(done: (error?: Error | null) => void): void {
    const tail = this.decoder.end();
    if (!this.injected) {
      this.pending += tail;
      this.emitHtml(true);
    } else this.push(tail);
    done();
  }
}

export const adapterDevCsp = (policy: string): string => {
  const directives = policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const defaults =
    directives
      .find((part) => part.split(/\s/)[0] === "default-src")
      ?.split(/\s+/)
      .slice(1) ?? [];
  for (const name of ["script-src", "connect-src", "script-src-elem"]) {
    const index = directives.findIndex((part) => part.split(/\s/)[0] === name);
    const inherited =
      name === "script-src-elem"
        ? (directives
            .find((part) => part.startsWith("script-src "))
            ?.split(/\s+/)
            .slice(1) ?? defaults)
        : defaults;
    const sources = (
      index < 0 ? inherited : directives[index].split(/\s+/).slice(1)
    ).filter((source) => source !== "'none'");
    const updated = `${name} ${[...new Set([...sources, "'self'"])].join(" ")}`;
    if (index < 0) directives.push(updated);
    else directives[index] = updated;
  }
  return directives.join("; ");
};

const disconnected = (error: NodeJS.ErrnoException): boolean =>
  ["ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(
    error.code ?? "",
  );

const hasConfiguredSiteUrl = (
  projectRoot: string,
  flags: CliFlags,
): boolean => {
  if (flags.siteUrl !== undefined) return true;
  const inheritedSiteUrl = process.env.BASCIK_SITE_URL;
  if (inheritedSiteUrl !== undefined) return inheritedSiteUrl !== "";

  let fileSiteUrl: string | undefined;
  for (const file of [
    join(projectRoot, ".env"),
    ...flags.envFiles.map((path) => resolve(projectRoot, path)),
  ]) {
    if (existsSync(file))
      fileSiteUrl =
        parseEnv(readFileSync(file, "utf8")).BASCIK_SITE_URL ?? fileSiteUrl;
  }
  return Boolean(fileSiteUrl);
};

export const stopAdapterChild = async (
  child: ChildProcess | undefined,
): Promise<void> => {
  if (!child?.pid) return;
  const pid = child.pid;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
        }).on("error", (error) =>
          console.error(`[bascik] Cannot stop child ${pid}: ${error.message}`),
        );
      } else {
        process.kill(-pid, value);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  if (child.exitCode === null && child.signalCode === null) {
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      once(child, "exit"),
      new Promise<void>((done) => {
        timer = setTimeout(done, 3000);
      }),
    ]).finally(() => clearTimeout(timer!));
  }
  // The CLI may have exited before its runtime grandchild.
  signal("SIGKILL");
};

interface BuildLocation {
  distDir: string;
  outDir?: string;
  roots: string[];
}

export interface AdapterDevServer {
  url: string;
  close(): Promise<void>;
}

export const startAdapterDev = async (
  args: string[],
  flags: CliFlags,
): Promise<AdapterDevServer> => {
  const projectRoot = process.cwd();
  const target = flags.target!;
  const resolved = await resolveAdapterTarget(target, projectRoot);
  const adapter = resolved.adapter!;
  if (!adapter.dev) {
    throw new Error(
      `[bascik] Adapter "${adapter.name}" does not support local development. Use --build --target instead.`,
    );
  }
  const host = flags.host ?? process.env.BASCIK_SERVER_HOST ?? "127.0.0.1";
  if (!isPlausibleHostname(host))
    throw new Error(
      `[bascik] Invalid BASCIK_SERVER_HOST: ${hostnameExpectation(host, "BASCIK_SERVER_PORT")}.`,
    );
  const portEnv = process.env.BASCIK_SERVER_PORT;
  const envPort = parsePort(portEnv);
  if (
    flags.port === undefined &&
    portEnv !== undefined &&
    envPort === undefined
  )
    throw new Error(
      "[bascik] BASCIK_SERVER_PORT must be an integer from 1 to 65535.",
    );
  const port =
    flags.port ?? envPort ?? (adapter.name === "cloudflare" ? 8787 : 8888);
  const origin = formatServerOrigin("http", host, port);
  // Reassigned on every runtime start: a port reused across restarts sits
  // unreserved between stop and start, and anything can claim it meanwhile.
  let runtimePort = 0;
  const location: BuildLocation = {
    distDir: join(projectRoot, "dist"),
    roots: [projectRoot],
  };
  const outputRoots = new Set([location.distDir]);
  let generation = 0;
  let busy = true;
  let buildError: string | undefined;
  let runtimeReady = false;
  let closing = false;
  let running: Promise<void> | undefined;
  let dirty = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let runtime: ChildProcess | undefined;
  let builder: ChildProcess | undefined;
  let watcher: import("chokidar").FSWatcher | undefined;
  const clients = new Set<ServerResponse>();
  const state = () =>
    `data: ${JSON.stringify({ generation, busy, error: buildError })}\n\n`;
  const broadcast = () => {
    for (const response of clients) {
      if (!response.destroyed && !response.writableNeedDrain)
        response.write(state());
    }
  };
  const report = (error: unknown) => {
    buildError = error instanceof Error ? error.message : String(error);
    console.error(`[bascik] adapter dev: ${buildError}`);
    busy = false;
    broadcast();
  };
  const server = createServer((request, response) => {
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (!disconnected(error))
        console.error(`[bascik] adapter dev request: ${error.message}`);
      response.destroy();
    });
    response.on("error", (error: NodeJS.ErrnoException) => {
      if (!disconnected(error))
        console.error(`[bascik] adapter dev response: ${error.message}`);
    });
    const path = (request.url ?? "/").split("?")[0];
    if (path === CLIENT) {
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      response.end(adapterDevClient);
      return;
    }
    if (path === EVENTS) {
      if (clients.size >= 200) {
        response.writeHead(503).end("Too many live-reload connections");
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      clients.add(response);
      response.write(state());
      response.on("close", () => clients.delete(response));
      return;
    }
    if (!runtimeReady) {
      response.writeHead(503, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "1",
      });
      response.end(
        `<!doctype html><html><head><title>Bascik adapter dev</title><script src="${CLIENT}?v=${generation}" defer></script></head><body><h1>Bascik adapter dev</h1><p>${buildError ? "Build failed. Check the terminal, then save a correction to retry." : "Rebuilding the local adapter runtime…"}</p></body></html>`,
      );
      return;
    }
    const headers = { ...request.headers, "accept-encoding": "identity" };
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
    delete headers.range;
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: runtimePort,
        method: request.method,
        path: request.url,
        headers,
      },
      (incoming) => {
        const outgoing = { ...incoming.headers };
        const html =
          incoming.headers["content-type"]?.includes("text/html") &&
          request.method !== "HEAD";
        if (html) {
          if (
            outgoing["content-encoding"] &&
            outgoing["content-encoding"] !== "identity"
          ) {
            incoming.destroy();
            response
              .writeHead(502)
              .end(
                "Adapter dev requires uncompressed HTML from the local runtime.",
              );
            console.error(
              "[bascik] adapter dev received compressed HTML despite Accept-Encoding: identity.",
            );
            return;
          }
          delete outgoing["content-length"];
          delete outgoing.etag;
          delete outgoing["last-modified"];
          outgoing["cache-control"] = "no-store";
          for (const key of [
            "content-security-policy",
            "content-security-policy-report-only",
          ]) {
            const policy = outgoing[key];
            if (typeof policy === "string")
              outgoing[key] = adapterDevCsp(policy);
          }
        }
        response.writeHead(incoming.statusCode ?? 502, outgoing);
        const done = (error: NodeJS.ErrnoException | null) => {
          if (error && !disconnected(error))
            console.error(`[bascik] adapter dev proxy: ${error.message}`);
        };
        if (html)
          pipeline(
            incoming,
            new AdapterDevHtmlTransform(generation),
            response,
            done,
          );
        else pipeline(incoming, response, done);
      },
    );
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (!disconnected(error))
        console.error(`[bascik] adapter dev upstream: ${error.message}`);
      if (!response.headersSent)
        response
          .writeHead(502)
          .end("Local adapter runtime unavailable. Check the terminal.");
      else response.destroy();
    });
    response.on("close", () => upstream.destroy());
    request.on("aborted", () => upstream.destroy());
    request.pipe(upstream);
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.writableNeedDrain) client.destroy();
      else client.write(": heartbeat\n\n");
    }
  }, 20_000);
  const close = async () => {
    if (closing) return;
    closing = true;
    clearInterval(heartbeat);
    clearTimeout(debounce);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    await watcher?.close();
    await Promise.all([stopAdapterChild(builder), stopAdapterChild(runtime)]);
    for (const client of clients) client.end();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  const onSignal = () => {
    void close().catch(report);
  };
  const buildArgs = args.filter(
    (arg, index) =>
      !["--port", "--host", "--no-pin"].includes(arg) &&
      !(index > 0 && ["--port", "--host"].includes(args[index - 1])) &&
      !arg.startsWith("--port=") &&
      !arg.startsWith("--host="),
  );
  const rebuild = async () => {
    busy = true;
    buildError = undefined;
    runtimeReady = false;
    broadcast();
    const prior = runtime;
    runtime = undefined;
    await stopAdapterChild(prior);
    if (closing) return;
    try {
      const cli = fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts") ? "../index.ts" : "../index.js",
          import.meta.url,
        ),
      );
      const buildEnv = {
        ...process.env,
        BASCIK_ADAPTER_DEV: "1",
        BASCIK_BUILD: "1",
        BASCIK_SERVER: "0",
        ...(!hasConfiguredSiteUrl(projectRoot, flags) && {
          BASCIK_SITE_URL: origin,
        }),
      };
      builder = fork(cli, [...buildArgs, "--build"], {
        cwd: projectRoot,
        execArgv: [],
        detached: process.platform !== "win32",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: buildEnv,
      });
      builder.on("message", (message: unknown) => {
        if (
          !message ||
          typeof message !== "object" ||
          !("type" in message) ||
          !("distDir" in message) ||
          typeof message.distDir !== "string"
        )
          return;
        location.distDir = resolve(message.distDir);
        outputRoots.add(location.distDir);
        if (
          message.type === "bascik:adapter-output" &&
          "outDir" in message &&
          typeof message.outDir === "string"
        )
          location.outDir = message.outDir;
        if (
          message.type === "bascik:adapter-directories" &&
          "roots" in message &&
          Array.isArray(message.roots) &&
          message.roots.every((root) => typeof root === "string")
        ) {
          location.roots = [projectRoot, ...message.roots];
          watcher?.add(location.roots);
        }
      });
      const [code] = await once(builder, "exit");
      builder = undefined;
      if (closing) return;
      if (code !== 0 || !location.outDir)
        throw new Error(
          "Build failed. Fix the error above and save a file to retry.",
        );
      runtimePort = await availableDevPort();
      const command = await adapter.dev!({
        projectRoot,
        distDir: location.distDir,
        outDir: location.outDir,
        variant: resolved.variant,
        port: runtimePort,
      });
      if (closing) return;
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: { ...process.env, ...command.env },
        stdio: ["ignore", "inherit", "inherit"],
        detached: process.platform !== "win32",
      });
      runtime = child;
      let failed: Error | undefined;
      child.once("error", (error) => {
        failed = error;
      });
      child.once("exit", (code, signal) => {
        if (!closing && runtime === child) {
          runtimeReady = false;
          if (code === 0) {
            void close().catch(report);
            return;
          }
          failed = new Error(
            `Local ${adapter.name} runtime exited (${signal ?? code}). Save a file to retry.`,
          );
          report(failed);
        }
      });
      const deadline = Date.now() + 60_000;
      while (!closing) {
        if (failed) throw failed;
        try {
          const ready = await fetch(`http://127.0.0.1:${runtimePort}/`, {
            signal: AbortSignal.timeout(1000),
            redirect: "manual",
          });
          await ready.body?.cancel();
          if (ready.status < 500) break;
        } catch (error) {
          if (
            !(error instanceof TypeError) &&
            !(error instanceof DOMException && error.name === "TimeoutError")
          )
            throw error;
        }
        if (Date.now() >= deadline)
          throw new Error(
            `Local ${adapter.name} runtime did not become ready within 60 seconds.`,
          );
        await delay(100);
      }
      if (closing) return;
      runtimeReady = true;
      generation++;
      busy = false;
      buildError = undefined;
      broadcast();
      console.log(
        `[bascik] ${adapter.name} dev ready: ${origin} (watching for changes)`,
      );
    } catch (error) {
      const failedRuntime = runtime;
      runtime = undefined;
      await stopAdapterChild(failedRuntime);
      if (!closing) report(error);
    }
  };
  const drain = async () => {
    do {
      dirty = false;
      await rebuild();
    } while (dirty && !closing);
  };
  const schedule = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (closing) return;
      dirty = true;
      if (!running)
        running = drain().finally(() => {
          running = undefined;
        });
    }, 100);
  };
  try {
    server.listen(port, host);
    await once(server, "listening");
    server.on("error", (error) => {
      report(error);
      void close();
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
    registerExitStopper(() => (closing ? null : close()));
    const { watch } = await import("chokidar");
    watcher = watch(location.roots, {
      ignoreInitial: true,
      ignored: (path) => {
        const absolute = resolve(path);
        const parts = relative(projectRoot, absolute).split(sep);
        return (
          parts.some((part) =>
            [
              "node_modules",
              ".git",
              ".bascik",
              ".netlify",
              ".wrangler",
              "publish",
              "test-results",
              "playwright-report",
            ].includes(part),
          ) || [...outputRoots].some((root) => isSameOrInside(absolute, root))
        );
      },
    });
    watcher.on("all", schedule);
    watcher.on("error", (error) => {
      report(error);
      void close();
    });
    await once(watcher, "ready");
    running = drain();
    await running;
    running = undefined;
    return { url: origin, close };
  } catch (error) {
    await close();
    throw error;
  }
};
