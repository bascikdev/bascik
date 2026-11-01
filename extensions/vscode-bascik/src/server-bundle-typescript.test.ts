import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  type Diagnostic,
  type MessageConnection,
} from "vscode-languageserver-protocol/node";
// @ts-expect-error build.mjs is plain JavaScript with no declaration file.
import { bundleServer } from "../build.mjs";
import { initializationOptions } from "./client-options";

/** TypeScript 6 (with the language service), standing in for the copy VS Code ships. */
const TYPESCRIPT_6_DIR = dirname(
  createRequire(__filename).resolve("typescript-6/package.json"),
);

interface RunningServer {
  connection: MessageConnection;
  child: ChildProcess;
  logs: string[];
  /** Messages the server asked the editor to show (`window/showMessageRequest`). */
  shown: string[];
  /** Resolves with the first diagnostics published for `uri` that pass `accept`. */
  waitFor(
    uri: string,
    accept: (diagnostics: Diagnostic[]) => boolean,
  ): Promise<Diagnostic[]>;
  stop(): Promise<void>;
}

/** Starts the bundle as the extension does, with the given initializationOptions. */
async function startServer(
  serverFile: string,
  projectRoot: string,
  options: unknown,
): Promise<RunningServer> {
  const child = spawn(process.execPath, [serverFile, "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!),
  );
  const latest = new Map<string, Diagnostic[]>();
  const waiters: {
    uri: string;
    accept: (diagnostics: Diagnostic[]) => boolean;
    resolve: (diagnostics: Diagnostic[]) => void;
  }[] = [];
  const logs: string[] = [];
  const shown: string[] = [];
  connection.onRequest(
    "window/showMessageRequest",
    ({ message }: { message: string }) => {
      shown.push(message);
      return null;
    },
  );
  connection.onNotification(
    "window/logMessage",
    ({ message }: { message: string }) => {
      logs.push(message);
    },
  );
  connection.onNotification(
    PublishDiagnosticsNotification.type,
    ({ uri, diagnostics }) => {
      latest.set(uri, diagnostics);
      for (const waiter of [...waiters]) {
        if (waiter.uri === uri && waiter.accept(diagnostics)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(diagnostics);
        }
      }
    },
  );
  connection.listen();
  await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: pathToFileURL(projectRoot).toString(),
    workspaceFolders: [
      { uri: pathToFileURL(projectRoot).toString(), name: "site" },
    ],
    capabilities: {},
    initializationOptions: options,
  });
  await connection.sendNotification(InitializedNotification.type, {});
  return {
    connection,
    child,
    logs,
    shown,
    waitFor(uri, accept) {
      const current = latest.get(uri);
      if (current && accept(current)) return Promise.resolve(current);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No matching diagnostics for ${uri}; last: ${JSON.stringify(latest.get(uri))}`,
              ),
            ),
          15_000,
        );
        waiters.push({
          uri,
          accept,
          resolve: (diagnostics) => {
            clearTimeout(timer);
            resolve(diagnostics);
          },
        });
      });
    },
    async stop() {
      await connection.sendRequest(ShutdownRequest.type).catch(() => undefined);
      await connection
        .sendNotification(ExitNotification.type)
        .catch(() => undefined);
      connection.dispose();
      child.kill();
    },
  };
}

const isTypeScript = (diagnostic: Diagnostic) =>
  diagnostic.source === "ts (bascik)";

const PAGE =
  '<main>Milk frother</main>\n<script type="text/typescript">\n  const speed: number = "fast";\n</script>\n';

/**
 * The bundle checks TypeScript blocks in its worker thread (the bundle is its own worker file), with the
 * TypeScript the client names, and never with one of its own.
 */
describe("the bundled language server's TypeScript checks", () => {
  let work: string;
  let serverFile: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "bascik-ext-ts-"));
    serverFile = join(work, "dist/server.js");
    await bundleServer(serverFile);
  }, 30_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function project(name: string): Promise<string> {
    const root = join(work, name);
    await mkdir(join(root, "src/pages"), { recursive: true });
    await writeFile(join(root, "bascik.config.ts"), "export default {};\n");
    return root;
  }

  async function open(
    server: RunningServer,
    file: string,
    text: string,
    version = 1,
  ) {
    await writeFile(file, text);
    await server.connection.sendNotification(
      DidOpenTextDocumentNotification.type,
      {
        textDocument: {
          uri: pathToFileURL(file).toString(),
          languageId: "html",
          version,
          text,
        },
      },
    );
  }

  it("contains no TypeScript of its own", async () => {
    const bundle = await readFile(serverFile, "utf8");
    expect(bundle).not.toContain("createLanguageService(host");
    expect(bundle).not.toMatch(/var ts = \{\};|namespace ts \{/);
  });

  it("reports TS2322 at the exact range with the TypeScript the client passes, after Bascik's own diagnostics", async () => {
    const root = await project("with-client-typescript");
    const server = await startServer(serverFile, root, {
      typescript: { path: TYPESCRIPT_6_DIR },
      editorHasEmbeddedTypeScript: true,
    });
    try {
      const file = join(root, "src/pages/index.html");
      const uri = pathToFileURL(file).toString();
      await open(server, file, PAGE);
      const first = await server.waitFor(uri, () => true);
      // Bascik publishes first; TypeScript follows from the worker.
      expect(first.some(isTypeScript)).toBe(false);
      const diagnostics = await server.waitFor(uri, (all) =>
        all.some(isTypeScript),
      );
      expect(diagnostics.filter(isTypeScript)).toEqual([
        expect.objectContaining({
          code: 2322,
          severity: 1,
          range: {
            start: { line: 2, character: 8 },
            end: { line: 2, character: 13 },
          },
        }),
      ]);

      // An unsaved edit fixes it.
      await server.connection.sendNotification(
        DidChangeTextDocumentNotification.type,
        {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: PAGE.replace('"fast"', "3") }],
        },
      );
      const fixed = await server.waitFor(uri, (all) => !all.some(isTypeScript));
      expect(fixed.filter(isTypeScript)).toEqual([]);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("ends its TypeScript worker once no open page has blocks, and starts it again for the next one", async () => {
    const root = await project("released");
    const server = await startServer(serverFile, root, {
      typescript: { path: TYPESCRIPT_6_DIR, releaseDelayMs: 200 },
      editorHasEmbeddedTypeScript: true,
    });
    const released = () =>
      server.logs.filter((log) => log.includes("gave their memory back"))
        .length;
    const waitForLog = async (count: number) => {
      const deadline = Date.now() + 15_000;
      while (released() < count && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(released()).toBe(count);
    };
    try {
      const file = join(root, "src/pages/index.html");
      const uri = pathToFileURL(file).toString();
      await open(server, file, PAGE);
      await server.waitFor(uri, (all) => all.some(isTypeScript));
      await server.connection.sendNotification(
        DidCloseTextDocumentNotification.type,
        { textDocument: { uri } },
      );
      await waitForLog(1);
      // A new worker checks the page when it is opened again.
      await open(server, file, PAGE.replace('"fast"', '"faster"'), 2);
      const again = await server.waitFor(uri, (all) =>
        all.some(
          (diagnostic) => isTypeScript(diagnostic) && diagnostic.code === 2322,
        ),
      );
      expect(again.filter(isTypeScript)).toHaveLength(1);
      expect(released()).toBe(1);
    } finally {
      await server.stop();
    }
  }, 40_000);

  it("checks every page of many opened together, each at its exact error", async () => {
    const root = await project("many-pages");
    const server = await startServer(serverFile, root, {
      typescript: { path: TYPESCRIPT_6_DIR },
      editorHasEmbeddedTypeScript: true,
    });
    try {
      const files = Array.from({ length: 12 }, (_, index) =>
        join(root, `src/pages/page-${index}.html`),
      );
      for (const file of files) await open(server, file, PAGE);
      for (const file of files) {
        const diagnostics = await server.waitFor(
          pathToFileURL(file).toString(),
          (all) => all.some(isTypeScript),
        );
        expect(diagnostics.filter(isTypeScript).map((d) => d.code)).toEqual([
          2322,
        ]);
      }
    } finally {
      await server.stop();
    }
  }, 40_000);

  it("misuse: a mistyped TypeScript path setting falls back to the editor's own TypeScript, with a warning", async () => {
    const root = await project("mistyped-setting");
    const fallback = await startServer(serverFile, root, {
      typescript: {
        path: join(work, "nonexistent/typescript"),
        editorPath: TYPESCRIPT_6_DIR,
      },
      editorHasEmbeddedTypeScript: true,
    });
    try {
      const file = join(root, "src/pages/index.html");
      const uri = pathToFileURL(file).toString();
      await open(fallback, file, PAGE);
      const diagnostics = await fallback.waitFor(uri, (all) =>
        all.some(isTypeScript),
      );
      expect(diagnostics.filter(isTypeScript).map((d) => d.code)).toEqual([
        2322,
      ]);
      expect(fallback.shown).toHaveLength(1);
      expect(fallback.shown[0]).toContain(join(work, "nonexistent/typescript"));
      expect(fallback.shown[0]).toContain("is not a typescript package folder");
    } finally {
      await fallback.stop();
    }
  }, 30_000);

  it("misuse: a relative TypeScript path setting is not read from the open project, with a warning", async () => {
    const root = await project("relative-setting");
    // The open project has a TypeScript at the relative path; it must not be the one loaded.
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(TYPESCRIPT_6_DIR, join(root, "node_modules", "typescript"));
    const server = await startServer(
      serverFile,
      root,
      initializationOptions(
        join(work, "no-editor"),
        { enabled: true, path: "node_modules/typescript" },
        true,
      ),
    );
    try {
      const file = join(root, "src/pages/index.html");
      await open(server, file, PAGE);
      // The project's own TypeScript still checks the page, as the last fallback; the setting is not what found it.
      const diagnostics = await server.waitFor(
        pathToFileURL(file).toString(),
        (all) => all.some(isTypeScript),
      );
      expect(diagnostics.filter(isTypeScript).map((d) => d.code)).toEqual([
        2322,
      ]);
      expect(server.shown).toHaveLength(1);
      expect(server.shown[0]).toContain(
        "(node_modules/typescript) is not an absolute path",
      );
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("is off, with one log line and no diagnostics, when the project has no usable TypeScript", async () => {
    const root = await project("without-typescript");
    const server = await startServer(
      serverFile,
      root,
      initializationOptions(
        join(work, "no-editor"),
        { enabled: true, path: "" },
        true,
      ),
    );
    try {
      const file = join(root, "src/pages/index.html");
      await open(server, file, PAGE);
      await server.waitFor(pathToFileURL(file).toString(), () => true);
      const deadline = Date.now() + 10_000;
      while (
        !server.logs.some((log) => log.includes("TypeScript checks")) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      const notes = server.logs.filter((log) =>
        log.includes("TypeScript checks"),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("is not a typescript package folder");
      expect(notes[0]).toContain("npm install --save-dev typescript@6");
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("checks nothing when the client turns TypeScript off", async () => {
    const root = await project("disabled");
    const server = await startServer(serverFile, root, {
      typescript: { enabled: false, path: TYPESCRIPT_6_DIR },
    });
    try {
      const file = join(root, "src/pages/index.html");
      await open(server, file, PAGE);
      const diagnostics = await server.waitFor(
        pathToFileURL(file).toString(),
        () => true,
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(diagnostics.some(isTypeScript)).toBe(false);
      expect(server.logs.some((log) => log.includes("TypeScript"))).toBe(false);
    } finally {
      await server.stop();
    }
  }, 30_000);

  /** A page importing `@/lib/frother.ts`, and the position of `needle` (plus `delta`) in it. */
  const FEATURE_PAGE =
    '<main>Milk frother</main>\n<script type="text/typescript">\n  import { frother } from "@/lib/frother.ts";\n  const rpm: number = frother.speed;\n  frother.\n</script>\n';
  const at = (needle: string, delta = 0) => {
    const before = FEATURE_PAGE.slice(
      0,
      FEATURE_PAGE.indexOf(needle) + delta,
    ).split("\n");
    return { line: before.length - 1, character: before.at(-1)!.length };
  };

  async function featureProject(name: string, editorFlag: boolean) {
    const root = await project(name);
    await mkdir(join(root, "src/lib"), { recursive: true });
    const helper = join(root, "src/lib/frother.ts");
    await writeFile(
      helper,
      "export interface Frother {\n  /** Revolutions per minute. */\n  speed: number;\n}\nexport const frother: Frother = { speed: 1200 };\n",
    );
    const server = await startServer(serverFile, root, {
      typescript: { path: TYPESCRIPT_6_DIR },
      editorHasEmbeddedTypeScript: editorFlag,
    });
    const file = join(root, "src/pages/index.html");
    const uri = pathToFileURL(file).toString();
    await open(server, file, FEATURE_PAGE);
    const ask = (method: string, needle: string, delta = 0, extra = {}) =>
      server.connection.sendRequest(method, {
        textDocument: { uri },
        position: at(needle, delta),
        ...extra,
      }) as Promise<any>;
    return { server, helper, ask };
  }

  it("answers hover, definition and member completion from its worker, for a client without its own TypeScript mode", async () => {
    const { server, helper, ask } = await featureProject("features", false);
    try {
      const hover = await ask("textDocument/hover", "frother.speed", 1);
      expect(hover.contents.value).toContain("const frother: Frother");
      expect((await ask("textDocument/hover", "rpm")).contents.value).toContain(
        "const rpm: number",
      );
      const [definition] = await ask(
        "textDocument/definition",
        "frother.speed",
        1,
      );
      expect(definition.uri).toBe(pathToFileURL(helper).toString());
      expect(definition.range.start).toEqual({ line: 4, character: 13 });
      const members = await ask("textDocument/completion", "frother.\n", 8, {
        context: { triggerKind: 2, triggerCharacter: "." },
      });
      expect(members.map((item: { label: string }) => item.label)).toEqual([
        "speed",
      ]);
    } finally {
      await server.stop();
    }
  }, 30_000);

  it("leaves the page's own names to VS Code's mode when the client says it has one", async () => {
    const { server, ask } = await featureProject("features-vscode", true);
    try {
      expect(await ask("textDocument/hover", "rpm")).toBeNull();
      expect(
        (await ask("textDocument/hover", "frother.speed", 1)).contents.value,
      ).toContain("const frother: Frother");
    } finally {
      await server.stop();
    }
  }, 30_000);
});
