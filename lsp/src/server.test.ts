import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FileChangeType, type Diagnostic } from "vscode-languageserver";
import {
  BascikLanguageServer,
  type BascikLanguageServerOptions,
  readInitializationOptions,
  uriToFsPath,
} from "./server.js";
import {
  createInProcessTypeScriptEngine,
  type TypeScriptCheckRequest,
  type TypeScriptDiagnosticsResult,
  type TypeScriptEngine,
} from "./typescript-engine.js";
import { TYPESCRIPT_6_DIR } from "./typescript.test.util.js";

type Handler = (...args: any[]) => any;

/** The slice of a language server connection that the server uses, recording the handlers it registers. */
function createFakeConnection() {
  const handlers = new Map<string, Handler>();
  // The real connection only allows registering for folder changes once the client has said it sends them.
  const state = { clientSendsFolderChanges: false };
  const register = (name: string) =>
    vi.fn((handler: Handler) => {
      handlers.set(name, handler);
      return { dispose() {} };
    });
  const connection = {
    onInitialize: register("initialize"),
    onInitialized: register("initialized"),
    onCompletion: register("completion"),
    onHover: register("hover"),
    onDefinition: register("definition"),
    onReferences: register("references"),
    onCodeAction: register("codeAction"),
    onDidChangeWatchedFiles: register("watchedFiles"),
    onDidOpenTextDocument: register("didOpen"),
    onDidChangeTextDocument: register("didChange"),
    onDidCloseTextDocument: register("didClose"),
    onWillSaveTextDocument: register("willSave"),
    onWillSaveTextDocumentWaitUntil: register("willSaveWaitUntil"),
    onDidSaveTextDocument: register("didSave"),
    sendDiagnostics: vi.fn(),
    listen: vi.fn(),
    client: {
      register: vi.fn(
        async (..._args: unknown[]): Promise<{ dispose(): void }> => ({
          dispose() {},
        }),
      ),
    },
    console: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
    workspace: {
      onDidChangeWorkspaceFolders: vi.fn((handler: Handler) => {
        if (!state.clientSendsFolderChanges) {
          throw new Error(
            "Client doesn't support sending workspace folder change events.",
          );
        }
        handlers.set("workspaceFolders", handler);
        return { dispose() {} };
      }),
    },
  };
  return { connection, handlers, state };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("BascikLanguageServer", () => {
  let root: string;
  let server: BascikLanguageServer;
  let fake: ReturnType<typeof createFakeConnection>;

  const write = async (relative: string, content: string) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  const uri = (file: string) => pathToFileURL(file).toString();

  const initialize = async (
    dynamicRegistration = true,
    folderChanges = true,
    relativePatterns = true,
  ) => {
    fake.state.clientSendsFolderChanges = folderChanges;
    const result = await fake.handlers.get("initialize")!({
      workspaceFolders: [{ uri: uri(root), name: "site" }],
      capabilities: {
        workspace: {
          didChangeWatchedFiles: {
            dynamicRegistration,
            relativePatternSupport: relativePatterns,
          },
          workspaceFolders: folderChanges,
        },
      },
    });
    fake.handlers.get("initialized")!();
    return result;
  };
  const open = (file: string, text: string, languageId = "html", version = 1) =>
    fake.handlers.get("didOpen")!({
      textDocument: { uri: uri(file), languageId, version, text },
    });
  const close = (file: string) =>
    fake.handlers.get("didClose")!({ textDocument: { uri: uri(file) } });

  /** The diagnostics most recently published for a file, or undefined when none were. */
  const latest = (file: string): Diagnostic[] | undefined => {
    const calls = fake.connection.sendDiagnostics.mock.calls
      .map(([params]) => params as { uri: string; diagnostics: Diagnostic[] })
      .filter((params) => params.uri === uri(file));
    return calls.at(-1)?.diagnostics;
  };
  const codes = (file: string) => (latest(file) ?? []).map((d) => d.code);

  const COMPONENT = '<a data-bascik-attr-href="href">link</a>\n';
  const USAGE = '<my-card data-bascik-prop-href="/x"></my-card>\n';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "bascik-lsp-server-"));
    await write("bascik.config.ts", "export default {};\n");
    fake = createFakeConnection();
    server = new BascikLanguageServer(fake.connection as never);
  });

  afterEach(async () => {
    server.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("file watching", () => {
    const registered = (call: number) => {
      const [, options] = fake.connection.client.register.mock.calls[
        call
      ] as unknown as [unknown, { watchers: { globPattern: unknown }[] }];
      return options.watchers.map((w) => w.globPattern);
    };

    it("asks the editor to watch config files and HTML under each workspace folder", async () => {
      await initialize(true);
      expect(fake.connection.client.register).toHaveBeenCalledTimes(1);
      expect(registered(0)).toEqual([
        { baseUri: uri(root), pattern: "**/bascik.config.{ts,js,mjs}" },
        { baseUri: uri(root), pattern: "**/*.html" },
      ]);
    });

    it("falls back to plain patterns for an editor without folder-relative patterns", async () => {
      await initialize(true, true, false);
      expect(registered(0)).toEqual([
        "**/bascik.config.{ts,js,mjs}",
        "**/*.html",
      ]);
    });

    it("replaces the watchers when a workspace folder is added", async () => {
      await initialize(true);
      const registration =
        await fake.connection.client.register.mock.results[0].value;
      const dispose = vi.spyOn(registration, "dispose");
      const second = path.join(root, "second");
      fake.handlers.get("workspaceFolders")!({
        removed: [],
        added: [{ uri: uri(second), name: "second" }],
      });
      await settle(20);
      expect(dispose).toHaveBeenCalled();
      expect(fake.connection.client.register).toHaveBeenCalledTimes(2);
      expect(registered(1)).toContainEqual({
        baseUri: uri(second),
        pattern: "**/*.html",
      });
    });

    it("keeps running, and says why, when the editor rejects the watcher registration", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        fake.connection.client.register.mockRejectedValue(
          new Error("Unsupported glob pattern"),
        );
        await initialize(true);
        // A folder change registers again; that rejection must be handled too.
        fake.handlers.get("workspaceFolders")!({
          removed: [],
          added: [{ uri: uri(path.join(root, "second")), name: "second" }],
        });
        await settle(20);
        expect(unhandled).toEqual([]);
        expect(fake.connection.client.register).toHaveBeenCalledTimes(2);
        expect(fake.connection.console.error).toHaveBeenCalledWith(
          expect.stringContaining("Unsupported glob pattern"),
        );
        // The server still answers: an open document gets diagnostics.
        const page = await write("src/pages/index.html", "<p>hi</p>\n");
        open(page, "<p data-bascik-slott>hi</p>\n");
        await settle();
        expect(codes(page)).toContain("unknown-bascik-attribute");
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("does not register watchers with an editor that cannot", async () => {
      await initialize(false);
      expect(fake.connection.client.register).not.toHaveBeenCalled();
    });
  });

  describe("workspace folders", () => {
    it("says it follows workspace folder changes", async () => {
      const result = await initialize();
      expect(result.capabilities.workspace.workspaceFolders).toEqual({
        supported: true,
        changeNotifications: true,
      });
    });

    it("starts with a client that cannot send workspace folder changes", async () => {
      await expect(initialize(true, false)).resolves.toBeDefined();
      expect(fake.handlers.has("workspaceFolders")).toBe(false);
    });

    it("stops reporting on a removed folder's open files, and reports again when it comes back", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT);
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");

      fake.handlers.get("workspaceFolders")!({
        removed: [{ uri: uri(root), name: "site" }],
        added: [],
      });
      await settle();
      expect(latest(component)).toEqual([]);

      fake.handlers.get("workspaceFolders")!({
        removed: [],
        added: [{ uri: uri(root), name: "site" }],
      });
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");
    });

    it("rebuilds a project from disk when its folder is removed and added again", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const before = await server.getSnapshotForFile(component);
      fake.handlers.get("workspaceFolders")!({
        removed: [{ uri: uri(root), name: "site" }],
        added: [],
      });
      fake.handlers.get("workspaceFolders")!({
        removed: [],
        added: [{ uri: uri(root), name: "site" }],
      });
      expect(await server.getSnapshotForFile(component)).not.toBe(before);
    });

    it("publishes nothing for a file outside every workspace folder", async () => {
      await initialize();
      const elsewhere = await fs.mkdtemp(
        path.join(os.tmpdir(), "bascik-lsp-elsewhere-"),
      );
      try {
        const file = path.join(elsewhere, "loose.html");
        await fs.writeFile(file, COMPONENT);
        open(file, COMPONENT);
        await settle();
        expect(latest(file)).toEqual([]);
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  describe("diagnostics", () => {
    it("publishes diagnostics for a file with the document version", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT, "html", 7);
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");
      expect(fake.connection.sendDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({ version: 7 }),
      );
    });

    it("publishes nothing for documents that are not files on disk", async () => {
      await initialize();
      fake.handlers.get("didOpen")!({
        textDocument: {
          uri: "untitled:Untitled-1",
          languageId: "html",
          version: 1,
          text: COMPONENT,
        },
      });
      fake.handlers.get("didOpen")!({
        textDocument: {
          uri: "git:/site/src/components/my-card.html",
          languageId: "html",
          version: 1,
          text: COMPONENT,
        },
      });
      await settle();
      expect(fake.connection.sendDiagnostics).not.toHaveBeenCalled();
    });

    it("does not publish for a version that was edited while the project was being read", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT, "html", 1);
      // Edited before the project snapshot finished building: the first check is out of date.
      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(component), version: 2 },
        contentChanges: [{ text: "<p>edited</p>\n" }],
      });
      await settle();
      const versions = fake.connection.sendDiagnostics.mock.calls.map(
        ([params]) => params.version,
      );
      expect(versions).not.toContain(1);
      expect(versions).toContain(2);
    });

    it("clears a document's diagnostics when it closes", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT);
      await settle();
      close(component);
      expect(latest(component)).toEqual([]);
    });
  });

  // A workspace folder with no bascik.config is a Bascik project only when its package.json lists @bascik/bascik
  // or @bascik/language-server, or its root has a language server config (bascik.ext.json and so on). Any other folder (a React or Vue app with its own src/components) gets no Bascik diagnostics.
  describe("folders that are not Bascik projects", () => {
    const ATTRIBUTE_CSS = '[data-state="open"] {\n  color: red;\n}\n';
    const DEFAULT_EXPORT_ROUTE =
      "export default function handler() {\n  return 1;\n}\n";

    beforeEach(async () => {
      await fs.rm(path.join(root, "bascik.config.ts"));
    });

    const infoMessages = () =>
      fake.connection.console.info.mock.calls.map(([message]) =>
        String(message),
      );

    it("publishes no Bascik diagnostics in a folder without a config or an @bascik/bascik dependency", async () => {
      await write(
        "package.json",
        JSON.stringify({ dependencies: { react: "19.0.0" } }),
      );
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      const route = await write("src/api/users.ts", DEFAULT_EXPORT_ROUTE);
      open(css, ATTRIBUTE_CSS, "css");
      open(route, DEFAULT_EXPORT_ROUTE, "typescript");
      await settle();
      expect(latest(css)).toEqual([]);
      expect(latest(route)).toEqual([]);
    });

    it("publishes no Bascik diagnostics in a folder with no package.json either", async () => {
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      open(css, ATTRIBUTE_CSS, "css");
      await settle();
      expect(latest(css)).toEqual([]);
    });

    it("says once in the output panel why a folder gets no diagnostics", async () => {
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      const route = await write("src/api/users.ts", DEFAULT_EXPORT_ROUTE);
      open(css, ATTRIBUTE_CSS, "css");
      open(route, DEFAULT_EXPORT_ROUTE, "typescript");
      await settle();
      const notes = infoMessages().filter((message) =>
        message.includes("not a Bascik project"),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(root);
      expect(notes[0]).toContain("bascik.config");
      expect(notes[0]).toContain("@bascik/bascik");
    });

    it.each(["dependencies", "devDependencies"])(
      "checks a zero-config project whose package.json lists @bascik/bascik in %s",
      async (field) => {
        await write(
          "package.json",
          JSON.stringify({ [field]: { "@bascik/bascik": "^1.0.0" } }),
        );
        await initialize();
        const css = await write("src/components/button.css", ATTRIBUTE_CSS);
        const route = await write("src/api/users.ts", DEFAULT_EXPORT_ROUTE);
        open(css, ATTRIBUTE_CSS, "css");
        open(route, DEFAULT_EXPORT_ROUTE, "typescript");
        await settle();
        expect(codes(css)).toContain("css-attribute-selector");
        expect(codes(route)).toContain("missing-method-handler");
      },
    );

    // The linter on its own (a shared component library, or an editor other than VS Code) installs only
    // @bascik/language-server; the editor must report what `--check` reports in that folder.
    it.each(["dependencies", "devDependencies"])(
      "checks a linter-only project whose package.json lists @bascik/language-server in %s",
      async (field) => {
        await write(
          "package.json",
          JSON.stringify({ [field]: { "@bascik/language-server": "^1.0.0" } }),
        );
        await initialize();
        const css = await write("src/components/button.css", ATTRIBUTE_CSS);
        open(css, ATTRIBUTE_CSS, "css");
        await settle();
        expect(codes(css)).toContain("css-attribute-selector");
      },
    );

    it.each([
      "bascik.ext.json",
      ".bascikrc.json",
      "bascik.ext.ts",
      "bascik.ext.js",
    ])(
      "checks a project with no package.json whose root has a %s",
      async (file) => {
        await write(
          file,
          file.endsWith(".json") ? "{}\n" : "export default {};\n",
        );
        await initialize();
        const css = await write("src/components/button.css", ATTRIBUTE_CSS);
        open(css, ATTRIBUTE_CSS, "css");
        await settle();
        expect(codes(css)).toContain("css-attribute-selector");
      },
    );

    it("names every marker in the output-panel note", async () => {
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      open(css, ATTRIBUTE_CSS, "css");
      await settle();
      const note = infoMessages().find((message) =>
        message.includes("not a Bascik project"),
      );
      expect(note).toContain("@bascik/language-server");
      expect(note).toContain("bascik.ext.json");
    });

    it("treats a package.json that is not valid JSON as no dependency, and says where it failed", async () => {
      await write("package.json", '{ "devDependencies": { "@bascik/bascik": ');
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      open(css, ATTRIBUTE_CSS, "css");
      await settle();
      expect(latest(css)).toEqual([]);
      expect(
        infoMessages().some(
          (message) =>
            message.includes(path.join(root, "package.json")) &&
            message.includes("could not be read"),
        ),
      ).toBe(true);
    });

    it("starts checking once the dependency is added, on the next edit", async () => {
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      open(css, ATTRIBUTE_CSS, "css", 1);
      await settle();
      expect(latest(css)).toEqual([]);

      await write(
        "package.json",
        JSON.stringify({ devDependencies: { "@bascik/bascik": "^1.0.0" } }),
      );
      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(css), version: 2 },
        contentChanges: [{ text: ATTRIBUTE_CSS }],
      });
      await settle();
      expect(codes(css)).toContain("css-attribute-selector");
    });

    it("starts checking when a bascik.config is added", async () => {
      await initialize();
      const css = await write("src/components/button.css", ATTRIBUTE_CSS);
      open(css, ATTRIBUTE_CSS, "css");
      await settle();
      expect(latest(css)).toEqual([]);

      await write("bascik.config.ts", "export default {};\n");
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "bascik.config.ts")),
            type: FileChangeType.Created,
          },
        ],
      });
      await settle();
      expect(codes(css)).toContain("css-attribute-selector");
    });

    it("keeps navigation for a folder that is not a Bascik project", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const snapshot = await server.getSnapshotForFile(component);
      expect(snapshot?.componentMap.has("my-card")).toBe(true);
    });
  });

  describe("prop usage from other files", () => {
    it("checks a component again when an open page starts supplying its prop", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const page = await write("src/pages/index.html", "<p>no usage</p>\n");
      open(component, COMPONENT);
      open(page, "<p>no usage</p>\n");
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");

      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(page), version: 2 },
        contentChanges: [{ text: USAGE }],
      });
      await settle();
      expect(codes(component)).not.toContain("attr-prop-unsupplied");
    });

    it("checks a component again when the page that supplied its prop closes", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const page = await write("src/pages/index.html", "<p>no usage</p>\n");
      open(component, COMPONENT);
      open(page, USAGE);
      await settle();
      expect(codes(component)).not.toContain("attr-prop-unsupplied");

      close(page);
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");
    });

    it("stops counting a deleted page's buffer that the editor keeps open, until it is edited", async () => {
      // VS Code keeps a model for a file it showed in Peek or References after the file is deleted.
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const page = await write("src/pages/old.html", USAGE);
      open(component, COMPONENT);
      open(page, USAGE);
      await settle();
      expect(codes(component)).not.toContain("attr-prop-unsupplied");

      await fs.rm(page);
      await fake.handlers.get("watchedFiles")!({
        changes: [{ uri: uri(page), type: FileChangeType.Deleted }],
      });
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");

      // Typing in the orphaned buffer makes it unsaved work, which counts again.
      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(page), version: 2 },
        contentChanges: [{ text: USAGE }],
      });
      await settle();
      expect(codes(component)).not.toContain("attr-prop-unsupplied");
    });

    it("reads a saved page from disk without rebuilding the project", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      const page = await write("src/pages/index.html", "<p>no usage</p>\n");
      open(component, COMPONENT);
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");

      await fs.writeFile(page, USAGE);
      await fake.handlers.get("watchedFiles")!({
        changes: [{ uri: uri(page), type: FileChangeType.Changed }],
      });
      await settle();
      expect(codes(component)).not.toContain("attr-prop-unsupplied");

      await fs.rm(page);
      await fake.handlers.get("watchedFiles")!({
        changes: [{ uri: uri(page), type: FileChangeType.Deleted }],
      });
      await settle();
      expect(codes(component)).toContain("attr-prop-unsupplied");
    });
  });

  describe("project changes on disk", () => {
    it("picks up a new component that an open page uses", async () => {
      await initialize();
      const page = await write("src/pages/index.html", "<my-card></my-card>\n");
      open(page, "<my-card></my-card>\n");
      await settle();
      expect(
        (await server.getSnapshotForFile(page))?.componentMap.has("my-card"),
      ).toBe(false);

      // Adding the component changes what the page's tag means, which only a rebuilt snapshot knows.
      const before = fake.connection.sendDiagnostics.mock.calls.length;
      await write("src/components/my-card.html", "<p>card</p>\n");
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "src/components/my-card.html")),
            type: FileChangeType.Created,
          },
        ],
      });
      await settle();
      expect(fake.connection.sendDiagnostics.mock.calls.length).toBeGreaterThan(
        before,
      );
      const snapshot = await server.getSnapshotForFile(page);
      expect(snapshot?.componentMap.has("my-card")).toBe(true);
    });

    it("rebuilds a project after its config changes and checks every open document again", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT);
      await settle();
      const before = await server.getSnapshotForFile(component);
      expect(before?.componentRoots).toEqual([
        path.join(root, "src/components").replace(/\\/g, "/"),
      ]);

      await write(
        "bascik.config.ts",
        "export default { directory: { components: ['src/ui'] } };\n",
      );
      const calls = fake.connection.sendDiagnostics.mock.calls.length;
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "bascik.config.ts")),
            type: FileChangeType.Changed,
          },
        ],
      });
      await settle();
      const after = await server.getSnapshotForFile(component);
      expect(after).not.toBe(before);
      expect(after?.componentRoots).toEqual([
        path.join(root, "src/ui").replace(/\\/g, "/"),
      ]);
      expect(fake.connection.sendDiagnostics.mock.calls.length).toBeGreaterThan(
        calls,
      );
    });

    it("ignores changes inside node_modules and dist", async () => {
      await initialize();
      const component = await write("src/components/my-card.html", COMPONENT);
      open(component, COMPONENT);
      await settle();
      const before = await server.getSnapshotForFile(component);
      const calls = fake.connection.sendDiagnostics.mock.calls.length;

      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "node_modules/pkg/bascik.config.ts")),
            type: FileChangeType.Created,
          },
          {
            uri: uri(path.join(root, "dist/index.html")),
            type: FileChangeType.Changed,
          },
        ],
      });
      await settle();
      expect(await server.getSnapshotForFile(component)).toBe(before);
      expect(fake.connection.sendDiagnostics.mock.calls.length).toBe(calls);
    });

    it("does not treat a config file inside node_modules as a project", async () => {
      await initialize();
      await write("node_modules/pkg/bascik.config.ts", "export default {};\n");
      const inner = await write(
        "node_modules/pkg/src/components/x-card.html",
        COMPONENT,
      );
      const snapshot = await server.getSnapshotForFile(inner);
      expect(snapshot?.projectRoot).toBe(root);
    });
  });
});

describe("uriToFsPath", () => {
  // Built from the platform's own absolute path, so it holds for `/a/b c.html` on POSIX and `C:\a\b c.html` on Windows.
  const absolute = path.resolve(
    path.parse(process.cwd()).root,
    "a",
    "b c.html",
  );

  it("turns a file URI into a path and leaves other strings alone", () => {
    expect(uriToFsPath(pathToFileURL(absolute).toString())).toBe(absolute);
    expect(uriToFsPath(absolute)).toBe(absolute);
  });

  it("decodes the percent-encoding in a URI", () => {
    expect(pathToFileURL(absolute).toString()).toContain("b%20c.html");
    expect(uriToFsPath(pathToFileURL(absolute).toString())).toContain(
      "b c.html",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "reads the drive-letter form VS Code sends, with the colon encoded",
    () => {
      expect(uriToFsPath("file:///c%3A/Users/me/site/index.html")).toBe(
        "c:\\Users\\me\\site\\index.html",
      );
    },
  );
});

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `check` passes, for diagnostics that arrive after TypeScript's quiet period. */
async function eventually(
  check: () => void,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await pause(25);
    }
  }
}

/** An engine that records its calls and answers from `answer`. */
function recordingEngine(
  answer: (
    request: TypeScriptCheckRequest,
  ) =>
    | Promise<TypeScriptDiagnosticsResult>
    | TypeScriptDiagnosticsResult = () => ({
    status: "ok",
    diagnostics: [],
  }),
) {
  const engine = {
    diagnostics: vi.fn(async (request: TypeScriptCheckRequest) =>
      answer(request),
    ),
    cancel: vi.fn(),
    setOpenFile: vi.fn(),
    fileChanged: vi.fn(),
    closePage: vi.fn(),
    forgetProject: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } satisfies TypeScriptEngine;
  return engine;
}

const PAGE =
  '<main data-bascik-slott>Milk frother</main>\n<script type="text/typescript">\n  const speed: number = "fast";\n</script>\n';

describe("BascikLanguageServer TypeScript diagnostics", () => {
  let root: string;
  let server: BascikLanguageServer;
  let fake: ReturnType<typeof createFakeConnection>;

  const write = async (relative: string, content: string) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  const uri = (file: string) => pathToFileURL(file).toString();

  const start = async (
    options: BascikLanguageServerOptions,
    initializationOptions: unknown = {},
  ) => {
    server = new BascikLanguageServer(fake.connection as never, options);
    fake.state.clientSendsFolderChanges = true;
    await fake.handlers.get("initialize")!({
      workspaceFolders: [{ uri: uri(root), name: "site" }],
      capabilities: {
        workspace: {
          didChangeWatchedFiles: {
            dynamicRegistration: true,
            relativePatternSupport: true,
          },
          workspaceFolders: true,
        },
      },
      initializationOptions,
    });
    fake.handlers.get("initialized")!();
  };
  const realEngine: BascikLanguageServerOptions = {
    createTypeScriptEngine: (settings) =>
      createInProcessTypeScriptEngine(settings),
  };
  const withTypeScript6 = { typescript: { path: TYPESCRIPT_6_DIR } };

  const open = (file: string, text: string, languageId = "html", version = 1) =>
    fake.handlers.get("didOpen")!({
      textDocument: { uri: uri(file), languageId, version, text },
    });
  const change = (file: string, text: string, version: number) =>
    fake.handlers.get("didChange")!({
      textDocument: { uri: uri(file), version },
      contentChanges: [{ text }],
    });
  const close = (file: string) =>
    fake.handlers.get("didClose")!({ textDocument: { uri: uri(file) } });

  const published = (file: string): Diagnostic[][] =>
    fake.connection.sendDiagnostics.mock.calls
      .map(([params]) => params as { uri: string; diagnostics: Diagnostic[] })
      .filter((params) => params.uri === uri(file))
      .map((params) => params.diagnostics);
  const latest = (file: string) => published(file).at(-1) ?? [];
  const typeScriptOf = (file: string) =>
    latest(file).filter((d) => d.source === "ts (bascik)");

  beforeEach(async () => {
    root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "bascik-lsp-ts-")),
    );
    await write("bascik.config.ts", "export default {};\n");
    fake = createFakeConnection();
  });

  afterEach(async () => {
    server?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("publishes Bascik's diagnostics first, then adds TypeScript's at the exact range", async () => {
    await start(realEngine, withTypeScript6);
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() => expect(published(page).length).toBeGreaterThan(0));
    // The first publish is Bascik's alone.
    expect(published(page)[0].map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
    await eventually(() => expect(typeScriptOf(page)).toHaveLength(1));
    expect(typeScriptOf(page)[0]).toMatchObject({
      code: 2322,
      severity: 1,
      source: "ts (bascik)",
      range: {
        start: { line: 2, character: 8 },
        end: { line: 2, character: 13 },
      },
    });
    // Bascik's diagnostic is still there beside it.
    expect(latest(page).map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
      2322,
    ]);
  });

  it("clears TypeScript's error on an unsaved page edit and keeps Bascik's", async () => {
    await start(realEngine, withTypeScript6);
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() => expect(typeScriptOf(page)).toHaveLength(1));
    change(page, PAGE.replace('"fast"', "3"), 2);
    await eventually(() => expect(typeScriptOf(page)).toEqual([]));
    expect(latest(page).map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
  });

  it("checks the page again on an unsaved edit to an imported .ts file, and on a change on disk", async () => {
    await start(realEngine, withTypeScript6);
    const helper = await write(
      "src/pages/frother.ts",
      "export const speed: string = 'fast';\n",
    );
    const text =
      '<script type="text/typescript">\n  import { speed } from "./frother.ts";\n  const rpm: number = speed;\n</script>\n';
    const page = await write("src/pages/index.html", text);
    open(page, text);
    await eventually(() =>
      expect(typeScriptOf(page).map((d) => d.code)).toEqual([2322]),
    );

    open(helper, "export const speed: string = 'fast';\n", "typescript");
    change(helper, "export const speed: number = 3;\n", 2);
    await eventually(() => expect(typeScriptOf(page)).toEqual([]));

    // Closing the buffer goes back to the file on disk.
    close(helper);
    await eventually(() =>
      expect(typeScriptOf(page).map((d) => d.code)).toEqual([2322]),
    );

    await fs.writeFile(helper, "export const speed = 4;\n");
    await server.handleWatchedFileChanges([
      { fsPath: helper, type: FileChangeType.Changed },
    ]);
    await eventually(() => expect(typeScriptOf(page)).toEqual([]));
  });

  it("never asks the engine about a page without TypeScript blocks", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const page = await write(
      "src/pages/index.html",
      "<script>const a = 1;</script>\n",
    );
    open(page, '<script>const speed: number = "fast";</script>\n');
    await pause(400);
    expect(engine.diagnostics).not.toHaveBeenCalled();
    expect(latest(page).some((d) => d.source === "ts (bascik)")).toBe(false);
  });

  it("starts no engine when the client turns TypeScript off, and watches no TypeScript files", async () => {
    const create = vi.fn(() => recordingEngine());
    await start(
      { createTypeScriptEngine: create },
      { typescript: { enabled: false } },
    );
    expect(create).not.toHaveBeenCalled();
    await pause(10);
    const [, registration] = fake.connection.client.register.mock
      .calls[0] as unknown as [
      unknown,
      { watchers: { globPattern: { pattern: string } }[] },
    ];
    expect(registration.watchers.map((w) => w.globPattern.pattern)).toEqual([
      "**/bascik.config.{ts,js,mjs}",
      "**/*.html",
    ]);
  });

  it("passes the client's TypeScript path to the engine and watches the files blocks import", async () => {
    const create = vi.fn(() => recordingEngine());
    await start(
      { createTypeScriptEngine: create },
      { typescript: { path: " /editor/typescript " } },
    );
    expect(create).toHaveBeenCalledWith({ clientPath: "/editor/typescript" });
    await pause(10);
    const [, registration] = fake.connection.client.register.mock
      .calls[0] as unknown as [
      unknown,
      { watchers: { globPattern: { pattern: string } }[] },
    ];
    expect(registration.watchers.map((w) => w.globPattern.pattern)).toEqual([
      "**/bascik.config.{ts,js,mjs}",
      "**/*.html",
      "**/*.{ts,mts,cts,js,mjs,cjs}",
      "**/{tsconfig,package}.json",
    ]);
  });

  it("without TypeScript, writes one line to the output panel per project and publishes nothing for it", async () => {
    const engine = recordingEngine(() => ({
      status: "unavailable",
      message: "TypeScript checks are off: none found",
    }));
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    const other = await write("src/pages/other.html", PAGE);
    open(page, PAGE);
    open(other, PAGE);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    await pause();
    const notes = fake.connection.console.info.mock.calls.filter(([message]) =>
      String(message).includes("TypeScript checks are off"),
    );
    expect(notes).toEqual([[`${root}: TypeScript checks are off: none found`]]);
    expect(latest(page).map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
  });

  it("drops a result for a page edited while it was checked, and cancels the stale request at once", async () => {
    let release: (() => void) | undefined;
    const engine = recordingEngine(async (request) => {
      if (request.text.includes('"fast"'))
        await new Promise<void>((resolve) => (release = resolve));
      return {
        status: "ok",
        diagnostics: request.text.includes('"fast"')
          ? [{ start: 0, end: 4, message: "stale", code: 1, category: "error" }]
          : [],
      };
    });
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() => expect(release).toBeDefined());
    const cancelsBefore = engine.cancel.mock.calls.length;
    change(page, PAGE.replace('"fast"', "3"), 2);
    expect(engine.cancel.mock.calls.length).toBe(cancelsBefore + 1);
    release!();
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    await pause();
    expect(
      published(page)
        .flat()
        .some((d) => d.message === "stale"),
    ).toBe(false);
  });

  it("logs a failed check and keeps going", async () => {
    const engine = recordingEngine(() => ({
      status: "failed",
      message: "TypeError: boom",
    }));
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() =>
      expect(fake.connection.console.error).toHaveBeenCalledWith(
        expect.stringContaining("TypeError: boom"),
      ),
    );
    expect(latest(page).map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
  });

  it("tells the engine about closed pages, open buffers and config changes", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    close(page);
    expect(engine.closePage).toHaveBeenCalledWith(root, page);
    const helper = await write("src/lib/a.ts", "export const a = 1;\n");
    open(helper, "export const a = 2;\n", "typescript");
    expect(engine.setOpenFile).toHaveBeenLastCalledWith(
      helper,
      "export const a = 2;\n",
    );
    close(helper);
    expect(engine.setOpenFile).toHaveBeenLastCalledWith(helper, undefined);
    await server.handleWatchedFileChanges([
      {
        fsPath: path.join(root, "bascik.config.ts"),
        type: FileChangeType.Changed,
      },
      {
        fsPath: path.join(root, "tsconfig.json"),
        type: FileChangeType.Created,
      },
    ]);
    expect(engine.forgetProject).toHaveBeenCalledWith(root);
    expect(engine.fileChanged).toHaveBeenCalledWith(
      path.join(root, "tsconfig.json"),
    );
  });

  it("gives a page outside every workspace folder no TypeScript diagnostics", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const outside = path.join(os.tmpdir(), "bascik-outside-page.html");
    open(outside, PAGE);
    await pause(400);
    expect(engine.diagnostics).not.toHaveBeenCalled();
  });
});

describe("readInitializationOptions", () => {
  it("turns TypeScript on by default and reads the editor's flag", () => {
    expect(readInitializationOptions(undefined)).toEqual({
      typescriptEnabled: true,
      typescriptPath: undefined,
      editorHasEmbeddedTypeScript: false,
    });
    expect(
      readInitializationOptions({
        typescript: { enabled: true, path: "/ts" },
        editorHasEmbeddedTypeScript: true,
      }),
    ).toEqual({
      typescriptEnabled: true,
      typescriptPath: "/ts",
      editorHasEmbeddedTypeScript: true,
    });
  });

  it("misuse: ignores options of the wrong type rather than failing to start", () => {
    for (const value of [
      null,
      "typescript",
      3,
      [],
      { typescript: "on" },
      { typescript: null },
    ]) {
      expect(readInitializationOptions(value)).toEqual({
        typescriptEnabled: true,
        typescriptPath: undefined,
        editorHasEmbeddedTypeScript: false,
      });
    }
    expect(
      readInitializationOptions({
        typescript: { enabled: "false", path: "   " },
        editorHasEmbeddedTypeScript: "yes",
      }),
    ).toEqual({
      typescriptEnabled: true,
      typescriptPath: undefined,
      editorHasEmbeddedTypeScript: false,
    });
    expect(
      readInitializationOptions({ typescript: { enabled: false, path: 7 } }),
    ).toMatchObject({
      typescriptEnabled: false,
      typescriptPath: undefined,
    });
  });
});
