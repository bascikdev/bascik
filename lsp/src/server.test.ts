import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { FileChangeType, type Diagnostic } from "vscode-languageserver";
import { BascikLanguageServer, uriToFsPath } from "./server.js";

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

  // A workspace folder with no bascik.config is a zero-config Bascik project only when its package.json lists
  // @bascik/bascik. Any other folder (a React or Vue app with its own src/components) gets no Bascik diagnostics.
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
