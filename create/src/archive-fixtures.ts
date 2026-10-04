/**
 * archive-fixtures.ts: test support. Builds small tar.gz archives byte by byte, so tests can include
 * entries that a well-behaved tar writer refuses to produce (`../` paths, absolute paths, links).
 * Also serves them from a local HTTP server, so the real download code path runs without the network.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export type EntrySpec =
  | { path: string; type: "file"; content: string | Buffer; mode?: number }
  | { path: string; type: "dir" }
  | { path: string; type: "symlink"; target: string }
  | { path: string; type: "hardlink"; target: string };

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(spec: EntrySpec, size: number): Buffer {
  const block = Buffer.alloc(512);
  const typeFlag = { file: "0", dir: "5", symlink: "2", hardlink: "1" }[spec.type];
  const path = Buffer.from(spec.type === "dir" && !spec.path.endsWith("/") ? `${spec.path}/` : spec.path);
  if (path.length > 100) throw new Error(`fixture path too long: ${spec.path}`);
  path.copy(block, 0);
  const mode = spec.type === "file" && spec.mode !== undefined ? spec.mode : spec.type === "dir" ? 0o755 : 0o644;
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(typeFlag, 156, "ascii");
  if (spec.type === "symlink" || spec.type === "hardlink") block.write(spec.target, 157, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7).slice(0, 6) + "\0 ", 148, "ascii");
  return block;
}

/** Raw (uncompressed) tar bytes. */
export function tarBytes(entries: EntrySpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.type === "file" ? Buffer.from(entry.content) : Buffer.alloc(0);
    blocks.push(header(entry, content.length), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function tarGz(entries: EntrySpec[]): Buffer {
  return gzipSync(tarBytes(entries));
}

/** The files of a typical GitHub archive: everything sits inside `repo-ref/`. */
export function githubArchive(files: Record<string, string | Buffer>, wrapper = "repo-main", extra: EntrySpec[] = []): Buffer {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) dirs.add(parts.slice(0, index).join("/"));
  }
  const entries: EntrySpec[] = [
    { path: wrapper, type: "dir" },
    ...[...dirs].sort().map((dir): EntrySpec => ({ path: `${wrapper}/${dir}`, type: "dir" })),
    ...Object.entries(files).map(([path, content]): EntrySpec => ({ path: `${wrapper}/${path}`, type: "file", content })),
    ...extra,
  ];
  return tarGz(entries);
}

export interface Route {
  status?: number;
  body?: Buffer | string;
  headers?: Record<string, string>;
  /** Send this many bytes of `body`, then stop without ending the response. */
  truncateAfter?: number;
  /** Never respond. */
  hang?: boolean;
  /** Close the socket abruptly after the headers. */
  reset?: boolean;
}

export interface FixtureServer {
  base: string;
  requests: string[];
  routes: Map<string, Route>;
  close(): Promise<void>;
}

/** Serve `routes` (keyed by path) on 127.0.0.1. Unknown paths answer 404. */
export async function startFixtureServer(initial: Record<string, Route> = {}): Promise<FixtureServer> {
  const routes = new Map(Object.entries(initial));
  const requests: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    requests.push(path);
    const route = routes.get(path);
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not Found");
      return;
    }
    if (route.hang) return;
    if (route.reset) {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.flushHeaders();
      setTimeout(() => request.socket.destroy(), 10);
      return;
    }
    const body = Buffer.from(route.body ?? "");
    response.writeHead(route.status ?? 200, { "content-type": "application/gzip", ...(route.truncateAfter === undefined ? { "content-length": String(body.length) } : {}), ...route.headers });
    if (route.truncateAfter !== undefined) {
      response.write(body.subarray(0, route.truncateAfter));
      setTimeout(() => request.socket.destroy(), 10);
      return;
    }
    response.end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () =>
      new Promise<void>((accept) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => accept());
      }),
  };
}
