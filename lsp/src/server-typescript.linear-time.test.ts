/**
 * Linear-time check for the language server's TypeScript checks: an edit in one page must cost the same
 * TypeScript work however many other pages with TypeScript blocks are open. A page's blocks import nothing from
 * other pages, so only the edited page is checked again; re-checking every open page made each keystroke cost
 * grow with the number of open pages.
 *
 * The engine here is TypeScript's own, run in process, with the CPU time of each check counted. Only that time
 * is compared, so the server's own revalidation of open pages (Bascik's diagnostics) does not blur the result.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LINEAR_TIME_TIMEOUT_MS } from "./linear-time.test.util.js";
import { BascikLanguageServer } from "./server.js";
import { createFakeConnection } from "./server.test.util.js";
import type { TypeScriptEngine } from "./typescript-engine.js";
import { TypeScriptProjects } from "./typescript-service.js";
import { TYPESCRIPT_6_DIR } from "./typescript.test.util.js";

const threadCpuMs = () => {
  const { user, system } = (
    process.threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process)
  )();
  return (user + system) / 1000;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An in-process engine that counts its checks and the CPU time they take. */
function measuredEngine() {
  const projects = new TypeScriptProjects({ clientPath: TYPESCRIPT_6_DIR });
  const stats = { requests: 0, running: 0, cpuMs: 0, lastRequestAt: 0 };
  const engine: TypeScriptEngine = {
    async diagnostics(request) {
      stats.requests++;
      stats.running++;
      stats.lastRequestAt = performance.now();
      await new Promise((resolve) => setImmediate(resolve));
      const start = threadCpuMs();
      try {
        return projects.diagnostics(request);
      } finally {
        stats.cpuMs += threadCpuMs() - start;
        stats.running--;
      }
    },
    preparePages: (request) => projects.preparePages(request),
    cancel: () => undefined,
    setOpenFile: (fsPath, text) => projects.setOpenFile(fsPath, text),
    fileChanged: (fsPath) => projects.fileChanged(fsPath),
    closePage: (projectRoot, htmlPath) =>
      projects.closePage(projectRoot, htmlPath),
    forgetProject: (projectRoot) => projects.forgetProject(projectRoot),
    async release() {
      projects.dispose();
    },
    async dispose() {
      projects.dispose();
    },
  };
  /** Resolves once `count` more checks have started, none is running, and none has started for a while. */
  const settled = async (count: number) => {
    const target = stats.requests + count;
    for (;;) {
      await pause(50);
      if (
        stats.requests >= target &&
        stats.running === 0 &&
        performance.now() - stats.lastRequestAt > 400
      )
        return;
    }
  };
  return { engine, stats, settled };
}

const pageText = (index: number, value: string) =>
  `<main>Milk frother ${index}</main>\n<script type="text/typescript">\n  const speed: number = ${value};\n  document.title = String(speed);\n</script>\n`;

/** TypeScript's CPU time and checks for `edits` edits in one page while `openPages` pages are open. */
async function editCost(openPages: number, edits: number) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "bascik-lsp-ts-linear-")),
  );
  const fake = createFakeConnection();
  const { engine, stats, settled } = measuredEngine();
  const server = new BascikLanguageServer(fake.connection as never, {
    createTypeScriptEngine: () => engine,
  });
  try {
    await fs.writeFile(
      path.join(root, "bascik.config.ts"),
      "export default {};\n",
    );
    await fs.mkdir(path.join(root, "src/pages"), { recursive: true });
    fake.state.clientSendsFolderChanges = true;
    await fake.handlers.get("initialize")!({
      workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: "site" }],
      capabilities: { workspace: { workspaceFolders: true } },
      initializationOptions: {},
    });
    fake.handlers.get("initialized")!();
    const uris: string[] = [];
    for (let index = 0; index < openPages; index++) {
      const file = path.join(root, `src/pages/page-${index}.html`);
      await fs.writeFile(file, pageText(index, String(index)));
      uris.push(pathToFileURL(file).toString());
      fake.handlers.get("didOpen")!({
        textDocument: {
          uri: uris[index],
          languageId: "html",
          version: 1,
          text: pageText(index, String(index)),
        },
      });
    }
    await settled(openPages);
    // Warm the edited page, as an open page is, so the samples measure edits only.
    let version = 1;
    const edit = () => {
      version++;
      fake.handlers.get("didChange")!({
        textDocument: { uri: uris[0], version },
        contentChanges: [
          { text: pageText(0, version % 2 ? `"${version}"` : String(version)) },
        ],
      });
    };
    edit();
    await settled(1);
    const before = { ...stats };
    for (let index = 0; index < edits; index++) {
      edit();
      await settled(1);
    }
    return {
      cpuMs: stats.cpuMs - before.cpuMs,
      requests: stats.requests - before.requests,
    };
  } finally {
    server.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("TypeScript checks in the language server: linear time", () => {
  it(
    "costs an edit in one page the same TypeScript work with 10 or 40 pages open",
    async () => {
      const edits = 6;
      const small = await editCost(10, edits);
      const large = await editCost(40, edits);
      // One check per edit, of the edited page only.
      expect(small.requests).toBe(edits);
      expect(large.requests).toBe(edits);
      // Re-checking every open page would read about 4; the same work reads about 1.
      expect(large.cpuMs / Math.max(small.cpuMs, 5)).toBeLessThan(2.5);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
