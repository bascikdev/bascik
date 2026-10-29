import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
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
import { DOCUMENT_SELECTOR, SERVER_MODULE } from "./client-options";

/**
 * Starts the language server exactly as it ships: the bundle `build.mjs` writes to dist/server.js, run by
 * Node with nothing installed beside it. The analysis is tested in lsp/; this proves the bundle starts, that
 * its bundled data files (such as the compatibility rules) made it in, and that it answers over the protocol.
 */
describe("the bundled language server", () => {
  let work: string;
  let project: string;
  let child: ChildProcess;
  let connection: MessageConnection;
  const published = new Map<string, Diagnostic[]>();
  const waiting = new Map<string, (diagnostics: Diagnostic[]) => void>();

  /** Opens a file of the project and resolves with the diagnostics the server publishes for it. */
  const diagnosticsFor = async (
    relative: string,
    languageId: string,
    text: string,
  ): Promise<Diagnostic[]> => {
    const file = join(project, relative);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, text);
    const uri = pathToFileURL(file).toString();
    const arrived = new Promise<Diagnostic[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No diagnostics published for ${relative}`)),
        10_000,
      );
      waiting.set(uri, (diagnostics) => {
        clearTimeout(timer);
        resolve(diagnostics);
      });
    });
    await connection.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: { uri, languageId, version: 1, text },
    });
    return arrived;
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "bascik-ext-server-"));
    project = join(work, "site");
    await mkdir(join(project, "src/components"), { recursive: true });
    await writeFile(join(project, "bascik.config.ts"), "export default {};\n");

    // Bundled outside the extension folder, so the test never depends on (or overwrites) a prior build.
    const server = join(work, "dist/server.js");
    await bundleServer(server);
    child = spawn(process.execPath, [server, "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    connection.onNotification(
      PublishDiagnosticsNotification.type,
      ({ uri, diagnostics }) => {
        published.set(uri, diagnostics);
        waiting.get(uri)?.(diagnostics);
        waiting.delete(uri);
      },
    );
    connection.listen();
    await connection.sendRequest(InitializeRequest.type, {
      processId: process.pid,
      rootUri: pathToFileURL(project).toString(),
      workspaceFolders: [
        { uri: pathToFileURL(project).toString(), name: "site" },
      ],
      capabilities: {},
    });
    await connection.sendNotification(InitializedNotification.type, {});
  }, 30_000);

  afterAll(async () => {
    await connection?.sendRequest(ShutdownRequest.type).catch(() => undefined);
    await connection
      ?.sendNotification(ExitNotification.type)
      .catch(() => undefined);
    connection?.dispose();
    child?.kill();
    await rm(work, { recursive: true, force: true });
  });

  it("is the file the extension starts", () => {
    expect(SERVER_MODULE).toBe("dist/server.js");
  });

  it("selects HTML, CSS, JavaScript, and TypeScript files on disk only", () => {
    expect(DOCUMENT_SELECTOR).toEqual([
      { scheme: "file", language: "html" },
      { scheme: "file", language: "css" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "typescript" },
    ]);
  });

  it("reports a CSS scoping problem, which needs the bundled compatibility rules", async () => {
    const diagnostics = await diagnosticsFor(
      "src/components/card.css",
      "css",
      "[data-state] { color: red; }",
    );
    expect(diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringContaining("Standalone attribute selectors are not scoped"),
    );
  });

  it("reports a JavaScript scoping problem", async () => {
    const diagnostics = await diagnosticsFor(
      "src/components/card.js",
      "javascript",
      'document.querySelector("[data-target]");',
    );
    expect(diagnostics.map((d) => d.message)).toContainEqual(
      expect.stringContaining("Attribute selectors are not rewritten"),
    );
  });

  it("reports a server script problem with its rule id", async () => {
    const diagnostics = await diagnosticsFor(
      "src/pages/index.html",
      "html",
      "<script data-bascik-server>\nconst x = 1;\n</script>",
    );
    expect(diagnostics.map((d) => d.code)).toContain(
      "server-script-missing-default-export",
    );
    expect(diagnostics.every((d) => d.source === "bascik")).toBe(true);
  });

  it("reports server-script-unescaped-markup from the bundled server, and allows the @bascik/bascik/html import", async () => {
    const diagnostics = await diagnosticsFor(
      "src/pages/search.html",
      "html",
      '<script data-bascik-server>\nimport { esc } from "@bascik/bascik/html";\nexport default (request) => {\n  const q = new URL(request.url).searchParams.get("q");\n  return `<p>${q}</p>`;\n};\n</script>',
    );
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain("server-script-unescaped-markup");
    expect(codes).not.toContain("server-script-bascik-import");
  });

  it("is released as 0.5.0, the version that bundles the language server with the html lint", async () => {
    const { readFile } = await import("node:fs/promises");
    // The tests compile to CommonJS, so the manifest is found from the working directory (the extension root).
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };
    expect(manifest.version).toBe("0.5.0");
  });
});
