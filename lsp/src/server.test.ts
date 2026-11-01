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
  type TypeScriptFeatureRequest,
  type TypeScriptFeatureResult,
  type TypeScriptPagesRequest,
} from "./typescript-engine.js";
import { createFakeConnection } from "./server.test.util.js";
import { TYPESCRIPT_6_DIR } from "./typescript.test.util.js";

// A file Bascik cannot analyze: the scanners no longer overflow on deep
// nesting, so the analysis-failed fallback is reached through a marker that
// makes the server-script analysis throw as an overflow would.
const ANALYSIS_THROWS = "/* bascik-test: analysis throws */";
vi.mock("./server-script-rules.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-script-rules.js")>();
  return {
    ...actual,
    analyzeServerScriptSource: (
      ...args: Parameters<typeof actual.analyzeServerScriptSource>
    ) => {
      if (args[0].includes(ANALYSIS_THROWS))
        throw new RangeError("Maximum call stack size exceeded");
      return actual.analyzeServerScriptSource(...args);
    },
  };
});

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

    it("asks the editor to watch config files, HTML and script modules under each workspace folder", async () => {
      await initialize(true);
      expect(fake.connection.client.register).toHaveBeenCalledTimes(1);
      expect(registered(0)).toEqual([
        { baseUri: uri(root), pattern: "**/bascik.config.{ts,js,mjs}" },
        { baseUri: uri(root), pattern: "**/*.html" },
        { baseUri: uri(root), pattern: "**/*.{ts,mts,js,mjs}" },
      ]);
    });

    it("falls back to plain patterns for an editor without folder-relative patterns", async () => {
      await initialize(true, true, false);
      expect(registered(0)).toEqual([
        "**/bascik.config.{ts,js,mjs}",
        "**/*.html",
        "**/*.{ts,mts,js,mjs}",
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

    it("checks an open helper again when an unsaved page starts or stops importing it", async () => {
      await initialize();
      const HELPER = "export const card = (n: string) => `<p>${n}</p>`;\n";
      const helper = await write("src/lib/card.ts", HELPER);
      const page = await write("src/pages/index.html", "<p>no usage</p>\n");
      open(helper, HELPER, "typescript");
      open(page, "<p>no usage</p>\n");
      await settle();
      expect(codes(helper)).toEqual([]);

      const importing =
        '<script data-bascik-build>import { card } from "@/lib/card.ts"; export default () => card("x");</script>\n';
      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(page), version: 2 },
        contentChanges: [{ text: importing }],
      });
      await settle();
      expect(codes(helper)).toEqual(["server-script-unescaped-markup"]);

      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(page), version: 3 },
        contentChanges: [{ text: "<p>no usage</p>\n" }],
      });
      await settle();
      expect(codes(helper)).toEqual([]);
    });

    it("checks an open module again when another open module starts importing it", async () => {
      await initialize();
      await write(
        "src/pages/index.html",
        '<script data-bascik-build>import { a } from "@/lib/a.ts"; export default () => a;</script>\n',
      );
      const ESC =
        'export function escapeHtml(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }\n';
      const a = await write("src/lib/a.ts", "export const a = 1;\n");
      const b = await write("src/lib/b.ts", ESC);
      open(a, "export const a = 1;\n", "typescript");
      open(b, ESC, "typescript");
      await settle();
      expect(codes(b)).toEqual([]);

      fake.handlers.get("didChange")!({
        textDocument: { uri: uri(a), version: 2 },
        contentChanges: [{ text: 'import "./b.ts";\nexport const a = 1;\n' }],
      });
      await settle();
      expect(codes(b)).toEqual(["hand-written-html-escaper"]);
    });

    it("publishes analysis-failed for a module it cannot analyze, and keeps running", async () => {
      await initialize();
      await write(
        "src/pages/index.html",
        '<script data-bascik-build>import { t } from "@/lib/deep.ts"; export default () => t;</script>\n',
      );
      const DEEP = `${ANALYSIS_THROWS}\nexport const t = \`\${\`x\`}\`;\n`;
      const deep = await write("src/lib/deep.ts", DEEP);
      open(deep, DEEP, "typescript");
      await settle();
      expect(codes(deep)).toEqual(["analysis-failed"]);
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
    it.each([0, 250])(
      "picks up a new component that an open page uses with a %i ms snapshot delay",
      async (snapshotDelay) => {
        await initialize();
        const page = await write(
          "src/pages/index.html",
          "<my-card></my-card>\n",
        );
        open(page, "<my-card></my-card>\n");
        await vi.waitFor(() => expect(latest(page)).toBeDefined(), {
          timeout: 5000,
        });
        expect(
          (await server.getSnapshotForFile(page))?.componentMap.has("my-card"),
        ).toBe(false);

        // Adding the component changes what the page's tag means, which only a rebuilt snapshot knows.
        const publications = () =>
          fake.connection.sendDiagnostics.mock.calls.filter(
            ([params]) => params.uri === uri(page),
          ).length;
        const before = publications();
        const getSnapshot = server.getSnapshotForFile.bind(server);
        vi.spyOn(server, "getSnapshotForFile").mockImplementationOnce(
          async (file) => {
            await settle(snapshotDelay);
            return getSnapshot(file);
          },
        );
        await write("src/components/my-card.html", "<p>card</p>\n");
        await fake.handlers.get("watchedFiles")!({
          changes: [
            {
              uri: uri(path.join(root, "src/components/my-card.html")),
              type: FileChangeType.Created,
            },
          ],
        });
        await vi.waitFor(() => expect(publications()).toBeGreaterThan(before), {
          timeout: 5000,
        });
        const snapshot = await server.getSnapshotForFile(page);
        expect(snapshot?.componentMap.has("my-card")).toBe(true);
      },
    );

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

    it("checks an open module again when a closed module changes its imports on disk (review round 2)", async () => {
      await initialize();
      await write(
        "src/pages/index.html",
        '<script data-bascik-build>import { a } from "@/lib/a.ts"; export default () => a();</script>\n',
      );
      await write("src/lib/a.ts", "export const a = () => 'Milk frother';\n");
      const bText =
        'export const b = (name: string) => `<li class="item">${name}</li>`;\n';
      const b = await write("src/lib/b.ts", bText);
      open(b, bText, "typescript");
      await settle();
      expect(codes(b)).toEqual([]);

      // a.ts, closed, starts importing b.ts: b.ts now runs in Node.
      await write(
        "src/lib/a.ts",
        'import { b } from "./b.ts";\nexport const a = () => b("Milk frother");\n',
      );
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "src/lib/a.ts")),
            type: FileChangeType.Changed,
          },
        ],
      });
      await settle();
      expect(codes(b)).toEqual(["server-script-unescaped-markup"]);

      // And stops again.
      await write("src/lib/a.ts", "export const a = () => 'Milk frother';\n");
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "src/lib/a.ts")),
            type: FileChangeType.Changed,
          },
        ],
      });
      await settle();
      expect(codes(b)).toEqual([]);
    });

    it("a script change inside node_modules checks nothing again", async () => {
      await initialize();
      const bText = "export const b = 1;\n";
      const b = await write("src/lib/b.ts", bText);
      open(b, bText, "typescript");
      await settle();
      const calls = fake.connection.sendDiagnostics.mock.calls.length;
      await fake.handlers.get("watchedFiles")!({
        changes: [
          {
            uri: uri(path.join(root, "node_modules/pkg/index.js")),
            type: FileChangeType.Changed,
          },
        ],
      });
      await settle();
      expect(fake.connection.sendDiagnostics.mock.calls.length).toBe(calls);
    });

    it("checks a helper under scripts.importRoot outside the project with the project that imports it (review round 2)", async () => {
      await write(
        "site/bascik.config.ts",
        'export default { scripts: { importRoot: "../shared" } };\n',
      );
      const pageText =
        '<script data-bascik-build>import { card } from "@/lib/cards.ts"; export default () => card("Milk frother");</script>\n';
      const page = await write("site/src/pages/index.html", pageText);
      const cardsText =
        'export const card = (name: string) => `<article class="card"><h2>${name}</h2></article>`;\n';
      const cards = await write("shared/lib/cards.ts", cardsText);
      // The workspace root's own config is a different project.
      await initialize();
      open(page, pageText);
      await settle();
      open(cards, cardsText, "typescript");
      await settle();
      expect(codes(cards)).toEqual(["server-script-unescaped-markup"]);
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
    feature: vi.fn(
      async (
        _request: TypeScriptFeatureRequest,
      ): Promise<TypeScriptFeatureResult<never>> => ({
        status: "ok",
        answer: undefined,
      }),
    ),
    preparePages: vi.fn((_request: TypeScriptPagesRequest) => undefined),
    cancel: vi.fn(),
    setOpenFile: vi.fn(),
    fileChanged: vi.fn(),
    closePage: vi.fn(),
    forgetProject: vi.fn(),
    release: vi.fn(async () => undefined),
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

  it("misuse: clears a missing import's error once the file is created on disk, the page untouched", async () => {
    await start(realEngine, withTypeScript6);
    const text =
      '<script type="text/typescript">\n  import { speed } from "./lib/missing-file.ts";\n  console.log(speed);\n</script>\n';
    const page = await write("src/pages/index.html", text);
    open(page, text);
    await eventually(() =>
      expect(typeScriptOf(page).map((d) => d.code)).toEqual([2307]),
    );
    const created = await write(
      "src/pages/lib/missing-file.ts",
      "export const speed = 3;\n",
    );
    await server.handleWatchedFileChanges([
      { fsPath: created, type: FileChangeType.Created },
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
      "**/*.{ts,mts,js,mjs}",
    ]);
  });

  it("passes the client's TypeScript path to the engine and watches the files blocks import", async () => {
    const create = vi.fn(() => recordingEngine());
    await start(
      { createTypeScriptEngine: create },
      { typescript: { path: " /editor/typescript " } },
    );
    expect(create).toHaveBeenCalledWith({
      clientPath: "/editor/typescript",
      editorPath: undefined,
    });
    await pause(10);
    const [, registration] = fake.connection.client.register.mock
      .calls[0] as unknown as [
      unknown,
      { watchers: { globPattern: { pattern: string } }[] },
    ];
    expect(registration.watchers.map((w) => w.globPattern.pattern)).toEqual([
      "**/bascik.config.{ts,js,mjs}",
      "**/*.html",
      "**/*.{ts,mts,js,mjs}",
      "**/*.{cts,cjs}",
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

  it("misuse: warns once, visibly, when the TypeScript path the client set cannot be used", async () => {
    const problem =
      "the TypeScript path the editor gave (/nonexistent/typescript) is not a typescript package folder";
    const engine = recordingEngine(() => ({
      status: "ok",
      diagnostics: [],
      clientPathProblem: problem,
    }));
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    const other = await write("src/pages/other.html", PAGE);
    open(page, PAGE);
    open(other, PAGE);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    await pause();
    expect(fake.connection.window.showWarningMessage).toHaveBeenCalledTimes(1);
    const [message] = fake.connection.window.showWarningMessage.mock.calls[0];
    expect(message).toContain("/nonexistent/typescript");
    expect(message).toContain("checked with another TypeScript");
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

  it("asks for a scoped component's client blocks one by one and a page's in one scope", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    const component = await write("src/components/frother-card.html", PAGE);
    open(page, PAGE);
    open(component, PAGE);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    const scopes = new Map(
      engine.diagnostics.mock.calls.map(([request]) => [
        request.htmlPath,
        request.isolatedClientBlocks,
      ]),
    );
    expect(scopes.get(page)).toBe(false);
    expect(scopes.get(component)).toBe(true);
  });

  it("passes the HTML of components whose scripts share the page scope, and checks pages again when one is edited", async () => {
    await write(
      "bascik.config.ts",
      "export default { scoping: { scriptBlocks: false } };\n",
    );
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const button =
      "<button>Milk frother</button>\n<script>function startFrother() {}</script>\n";
    const component = await write("src/components/frother-button.html", button);
    const pageText = `<frother-button></frother-button>\n${PAGE}`;
    const page = await write("src/pages/index.html", pageText);
    open(page, pageText);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalled());
    const first = engine.diagnostics.mock.calls.at(-1)![0];
    expect(first).toMatchObject({
      htmlPath: page,
      isolatedClientBlocks: false,
      pageScopeHtml: [button],
    });

    // An unsaved edit to the component is what the page sees, and the page is checked again for it.
    open(component, button);
    await pause(400);
    engine.diagnostics.mockClear();
    const edited = button.replace("startFrother", "stopFrother");
    change(component, edited, 2);
    await eventually(() =>
      expect(
        engine.diagnostics.mock.calls.some(
          ([request]) =>
            request.htmlPath === page && request.pageScopeHtml?.[0] === edited,
        ),
      ).toBe(true),
    );
  });

  it("passes the components with TypeScript blocks a page uses, and checks pages again when one is edited", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const tag =
      '<span>ga</span>\n<script type="text/typescript">interface Window { dataLayer: unknown[] }</script>\n';
    const component = await write("src/components/ga-tag.html", tag);
    // A component without a TypeScript block adds nothing to the page's globals, so it is not passed.
    await write("src/components/frother-label.html", "<b>Milk frother</b>\n");
    const pageText = `<ga-tag></ga-tag><frother-label></frother-label>\n${PAGE}`;
    const page = await write("src/pages/index.html", pageText);
    open(page, pageText);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalled());
    expect(engine.diagnostics.mock.calls.at(-1)![0]).toMatchObject({
      htmlPath: page,
      isolatedClientBlocks: false,
      pageScopeHtml: [],
      usedComponents: [{ fsPath: component, text: tag }],
    });

    open(component, tag);
    await pause(400);
    engine.diagnostics.mockClear();
    const edited = tag.replace("dataLayer", "events");
    change(component, edited, 2);
    await eventually(() =>
      expect(
        engine.diagnostics.mock.calls.some(
          ([request]) =>
            request.htmlPath === page &&
            request.usedComponents?.[0]?.text === edited,
        ),
      ).toBe(true),
    );
  });

  it("gives the engine every owed page together before checking them one by one", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const pages = await Promise.all(
      ["a", "b", "c"].map((name) => write(`src/pages/${name}.html`, PAGE)),
    );
    const plain = await write("src/pages/plain.html", "<p>Milk frother</p>\n");
    for (const page of pages) open(page, PAGE);
    open(plain, "<p>Milk frother</p>\n");
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(3));
    expect(engine.preparePages).toHaveBeenCalledTimes(1);
    const [prepared] = engine.preparePages.mock.calls[0];
    expect(prepared).toMatchObject({ projectRoot: root });
    // Only pages with TypeScript blocks, each with its text and scope.
    expect(prepared.pages.map((p) => [p.htmlPath, p.text])).toEqual(
      pages.map((page) => [page, PAGE]),
    );
    expect(prepared.pages.every((p) => p.isolatedClientBlocks === false)).toBe(
      true,
    );
    expect(engine.preparePages.mock.invocationCallOrder[0]).toBeLessThan(
      engine.diagnostics.mock.invocationCallOrder[0],
    );
  });

  it("releases the engine once no open page has TypeScript blocks, and starts it again on the next one", async () => {
    const engine = recordingEngine();
    await start({
      createTypeScriptEngine: () => engine,
      typeScriptReleaseDelayMs: 100,
    });
    const first = await write("src/pages/a.html", PAGE);
    const second = await write("src/pages/b.html", PAGE);
    const plain = await write("src/pages/plain.html", "<p>Milk frother</p>\n");
    open(first, PAGE);
    open(second, PAGE);
    open(plain, "<p>Milk frother</p>\n");
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    // One TypeScript page is still open: nothing is released.
    close(first);
    await pause(400);
    expect(engine.release).not.toHaveBeenCalled();
    // Typing the blocks away counts as no TypeScript page, like closing it.
    change(second, "<p>no blocks now</p>\n", 2);
    await eventually(() => expect(engine.release).toHaveBeenCalledTimes(1));
    // A page with blocks again: checked as before, and a quick close and reopen does not release.
    engine.diagnostics.mockClear();
    change(second, PAGE, 3);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(1));
    close(second);
    open(second, PAGE);
    await pause(400);
    expect(engine.release).toHaveBeenCalledTimes(1);
  });

  it("never asks the engine about a page that names text/typescript without a TypeScript block, and lets it release", async () => {
    const engine = recordingEngine();
    await start({
      createTypeScriptEngine: () => engine,
      typeScriptReleaseDelayMs: 100,
    });
    const mentions = {
      "src/pages/prose.html":
        "<p>Write a block with type text/typescript to get checks.</p>\n",
      "src/pages/pre.html":
        '<pre>&lt;script type="text/typescript"&gt;</pre>\n',
      "src/pages/comment.html":
        '<!-- <script type="text/typescript">const speed: number = "fast";</script> -->\n<p>Milk frother</p>\n',
      "src/pages/data.html":
        '<script type="application/json">{"type": "text/typescript"}</script>\n',
    };
    for (const [relative, text] of Object.entries(mentions))
      open(await write(relative, text), text);
    await eventually(() => expect(engine.release).toHaveBeenCalled());
    expect(engine.diagnostics).not.toHaveBeenCalled();
    expect(engine.preparePages).not.toHaveBeenCalled();
    // A hover inside the commented-out script is outside every block: TypeScript is not asked either.
    await fake.handlers.get("hover")!({
      textDocument: { uri: uri(path.join(root, "src/pages/comment.html")) },
      position: { line: 0, character: 45 },
    });
    expect(engine.feature).not.toHaveBeenCalled();
  });

  /** An answer with one error on the first `speed` in the checked text. */
  const errorOnSpeed = (
    request: TypeScriptCheckRequest,
  ): TypeScriptDiagnosticsResult => {
    const start = request.text.indexOf("speed");
    return {
      status: "ok",
      diagnostics: [
        { start, end: start + 5, message: "m", code: 2322, category: "error" },
      ],
    };
  };

  it("checks only the edited page on a page edit, and publishes nothing new for the others", async () => {
    const engine = recordingEngine(errorOnSpeed);
    await start({ createTypeScriptEngine: () => engine });
    const pages = await Promise.all(
      ["a", "b", "c"].map((name) => write(`src/pages/${name}.html`, PAGE)),
    );
    for (const page of pages) open(page, PAGE);
    await eventually(() => {
      for (const page of pages) expect(typeScriptOf(page)).toHaveLength(1);
    });
    await pause(400);
    engine.diagnostics.mockClear();
    fake.connection.sendDiagnostics.mockClear();

    change(pages[0], PAGE.replace('"fast"', '"faster"'), 2);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(1));
    await pause(400);
    expect(engine.diagnostics.mock.calls.map(([r]) => r.htmlPath)).toEqual([
      pages[0],
    ]);
    // The other pages get Bascik's own revalidation, with their TypeScript errors unchanged, and nothing more.
    for (const page of pages.slice(1)) {
      expect(published(page).length).toBeLessThanOrEqual(1);
      expect(typeScriptOf(page)).toHaveLength(1);
    }
  });

  it("checks every open page when an imported file changes, again for a page whose check was cancelled", async () => {
    let cancelOther = false;
    const engine = recordingEngine((request) => {
      if (cancelOther && request.htmlPath.endsWith("other.html")) {
        cancelOther = false;
        return { status: "cancelled" };
      }
      return { status: "ok", diagnostics: [] };
    });
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    const other = await write("src/pages/other.html", PAGE);
    const helper = await write("src/lib/frother.ts", "export const a = 1;\n");
    open(page, PAGE);
    open(other, PAGE);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
    engine.diagnostics.mockClear();
    cancelOther = true;
    await server.handleWatchedFileChanges([
      { fsPath: helper, type: FileChangeType.Changed },
    ]);
    const callsFor = (file: string) =>
      engine.diagnostics.mock.calls.filter(([r]) => r.htmlPath === file).length;
    await eventually(() => {
      expect(callsFor(page)).toBe(1);
      expect(callsFor(other)).toBe(2);
    });
  });

  it("checks open pages again when the Bascik config changes", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(1));
    await server.handleWatchedFileChanges([
      {
        fsPath: path.join(root, "bascik.config.ts"),
        type: FileChangeType.Changed,
      },
    ]);
    await eventually(() => expect(engine.diagnostics).toHaveBeenCalledTimes(2));
  });

  it("moves TypeScript's errors with an edit above their block, and drops them when the block changes, until checked again", async () => {
    let answered = 0;
    const engine = recordingEngine(async (request) => {
      // Only the first check answers; later ones wait, as a slow check would.
      if (answered++ > 0) await new Promise(() => undefined);
      return errorOnSpeed(request);
    });
    await start({ createTypeScriptEngine: () => engine });
    const page = await write("src/pages/index.html", PAGE);
    open(page, PAGE);
    await eventually(() => expect(typeScriptOf(page)).toHaveLength(1));
    expect(typeScriptOf(page)[0].range.start).toEqual({
      line: 2,
      character: 8,
    });

    const shifted = `<p>Milk frother</p>\n<p>Steam wand</p>\n${PAGE}`;
    change(page, shifted, 2);
    // Bascik's own diagnostic moved two lines down: its check published for the new text.
    await eventually(() =>
      expect(
        latest(page).find((d) => d.code === "unknown-bascik-attribute")?.range
          .start.line,
      ).toBe(2),
    );
    expect(typeScriptOf(page)).toHaveLength(1);
    expect(typeScriptOf(page)[0].range.start).toEqual({
      line: 4,
      character: 8,
    });

    change(page, shifted.replace('"fast"', '"faster"'), 3);
    await eventually(() =>
      expect(
        fake.connection.sendDiagnostics.mock.calls.some(
          ([params]) =>
            (params as { uri: string; version?: number }).uri === uri(page) &&
            (params as { version?: number }).version === 3,
        ),
      ).toBe(true),
    );
    expect(typeScriptOf(page)).toEqual([]);
    expect(latest(page).map((d) => d.code)).toEqual([
      "unknown-bascik-attribute",
    ]);
  });

  it("gives a page outside every workspace folder no TypeScript diagnostics", async () => {
    const engine = recordingEngine();
    await start({ createTypeScriptEngine: () => engine });
    const outside = path.join(os.tmpdir(), "bascik-outside-page.html");
    open(outside, PAGE);
    await pause(400);
    expect(engine.diagnostics).not.toHaveBeenCalled();
  });

  describe("language features in TypeScript blocks", () => {
    const FEATURE_PAGE = `<main>Milk frother</main>
<script type="text/typescript">
  import { froth, frother } from "@/lib/frother.ts";
  import { steamTemperature } from "../lib/steam.ts";
  const rpm: number = frother.speed + steamTemperature;
  function warm(degrees: number): number {
    return degrees + rpm;
  }
  warm(froth(2, ));
  frother.
</script>
<script>
  const plain = "not TypeScript";
</script>
`;
    const FROTHER_TS = `export interface Frother {
  /** Revolutions per minute. */
  speed: number;
}
export const frother: Frother = { speed: 1200 };
/** Froths milk. */
export function froth(level: number, foam = true): string {
  return foam ? "foam" : String(level);
}
`;

    /** The position of `needle` (plus `delta`) in the page. */
    const at = (needle: string, delta = 0) => {
      const offset = FEATURE_PAGE.indexOf(needle) + delta;
      const before = FEATURE_PAGE.slice(0, offset).split("\n");
      return { line: before.length - 1, character: before.at(-1)!.length };
    };

    const setup = async (initializationOptions: Record<string, unknown>) => {
      await start(realEngine, {
        ...withTypeScript6,
        ...initializationOptions,
      });
      const frother = await write("src/lib/frother.ts", FROTHER_TS);
      const steam = await write(
        "src/lib/steam.ts",
        "export const steamTemperature = 65;\n",
      );
      const page = await write("src/pages/index.html", FEATURE_PAGE);
      open(page, FEATURE_PAGE);
      const ask = (
        name: "hover" | "definition" | "completion" | "signatureHelp",
        position: { line: number; character: number },
        context?: Record<string, unknown>,
      ) =>
        fake.handlers.get(name)!({
          textDocument: { uri: uri(page) },
          position,
          ...(context ? { context } : {}),
        });
      return { page, frother, steam, ask };
    };

    it("answers everything for a client without its own TypeScript mode", async () => {
      const { page, frother, steam, ask } = await setup({});
      const hover = await ask("hover", at("froth(2", 1));
      expect(hover.contents.value).toContain("froth(level: number");
      expect(hover.contents.value).toContain("Froths milk.");
      // The page's own name too.
      expect((await ask("hover", at("rpm;"))).contents.value).toContain(
        "const rpm: number",
      );
      expect(await ask("definition", at("froth(2", 1))).toEqual([
        {
          uri: uri(frother),
          range: {
            start: { line: 6, character: 16 },
            end: { line: 6, character: 21 },
          },
        },
      ]);
      const [toSteam] = await ask("definition", at("../lib/steam", 2));
      expect(toSteam.uri).toBe(uri(steam));
      const [toWarm] = await ask("definition", at("warm(froth", 1));
      expect(toWarm).toMatchObject({
        uri: uri(page),
        range: { start: at("warm(degrees", 0) },
      });
      const members = await ask("completion", at("frother.\n", 8), {
        triggerKind: 2,
        triggerCharacter: ".",
      });
      expect(members.map((item: { label: string }) => item.label)).toContain(
        "speed",
      );
      const speed = members.find(
        (item: { label: string }) => item.label === "speed",
      );
      expect(speed).toMatchObject({
        kind: 5, // Field
        detail: "(property) Frother.speed: number",
        documentation: { kind: "markdown", value: "Revolutions per minute." },
      });
      const help = await ask("signatureHelp", at("froth(2, )", 9));
      expect(help).toMatchObject({
        signatures: [
          {
            label: "froth(level: number, foam?: boolean): string",
            parameters: [{ label: [6, 19] }, { label: [21, 35] }],
          },
        ],
        activeParameter: 1,
      });
    });

    it("answers only what VS Code's own mode cannot, with the editor's flag", async () => {
      const { frother, ask } = await setup({
        editorHasEmbeddedTypeScript: true,
      });
      expect((await ask("hover", at("froth(2", 1))).contents.value).toContain(
        "froth(level: number",
      );
      expect(await ask("hover", at("rpm;"))).toBeUndefined();
      expect(await ask("hover", at("warm(froth"))).toBeUndefined();
      expect((await ask("definition", at("froth(2", 1)))[0].uri).toBe(
        uri(frother),
      );
      expect(await ask("definition", at("warm(froth", 1))).toBeUndefined();
      const members = await ask("completion", at("frother.\n", 8), {
        triggerKind: 2,
        triggerCharacter: ".",
      });
      expect(members.map((item: { label: string }) => item.label)).toEqual([
        "speed",
      ]);
      expect(
        await ask("signatureHelp", at("froth(2, )", 9)),
      ).not.toBeUndefined();
      expect(await ask("signatureHelp", at("warm(froth", 5))).toBeUndefined();
    });

    it("completes @/ import paths, with the trigger only TypeScript blocks use", async () => {
      const { page, ask } = await setup({ editorHasEmbeddedTypeScript: true });
      const text = FEATURE_PAGE.replace('"@/lib/frother.ts"', '"@/lib/"');
      change(page, text, 2);
      const offset = text.indexOf('"@/lib/"') + 7;
      const before = text.slice(0, offset).split("\n");
      const items = await ask(
        "completion",
        { line: before.length - 1, character: before.at(-1)!.length },
        { triggerKind: 2, triggerCharacter: "/" },
      );
      const labels = items.map((item: { label: string }) => item.label);
      expect(labels).toEqual(
        expect.arrayContaining(["frother.ts", "steam.ts"]),
      );
      expect(
        items.find((item: { label: string }) => item.label === "frother.ts"),
      ).toMatchObject({ kind: 17 /* File */ });
    });

    it("answers nothing in markup or a plain script, and keeps Bascik's own answers there", async () => {
      const { ask } = await setup({});
      expect(await ask("hover", at("plain ="))).toBeUndefined();
      expect(await ask("definition", at("plain ="))).toBeUndefined();
      expect(await ask("signatureHelp", at("plain ="))).toBeUndefined();
      // A `.` typed in markup asks TypeScript alone, which has nothing to say there.
      expect(
        await ask("completion", at("Milk frother", 4), {
          triggerKind: 2,
          triggerCharacter: ".",
        }),
      ).toBeUndefined();
      // Bascik's own completion in a script's open tag still answers.
      const items = await ask("completion", at('type="text/typescript"'));
      expect(
        items.some((item: { label: string }) =>
          item.label.startsWith("data-bascik-"),
        ),
      ).toBe(true);
    });

    it("answers nothing when TypeScript is off or unavailable", async () => {
      const engine = recordingEngine();
      await start({ createTypeScriptEngine: () => engine });
      const page = await write("src/pages/index.html", FEATURE_PAGE);
      open(page, FEATURE_PAGE);
      engine.feature.mockResolvedValue({
        status: "unavailable",
        message: "no TypeScript",
      });
      const result = await fake.handlers.get("hover")!({
        textDocument: { uri: uri(page) },
        position: at("froth(2", 1),
      });
      expect(result).toBeUndefined();
      expect(engine.feature).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            kind: "hover",
            crossFileOnly: false,
          }),
        }),
      );
    });

    it("drops an answer for a page edited while TypeScript worked on it", async () => {
      let release: () => void = () => undefined;
      const engine = recordingEngine();
      engine.feature.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                status: "ok",
                answer: { markdown: "stale", start: 0, end: 1 },
              } as never);
          }),
      );
      await start({ createTypeScriptEngine: () => engine });
      const page = await write("src/pages/index.html", FEATURE_PAGE);
      open(page, FEATURE_PAGE);
      const pending = fake.handlers.get("hover")!({
        textDocument: { uri: uri(page) },
        position: at("froth(2", 1),
      });
      await eventually(() => expect(engine.feature).toHaveBeenCalled());
      change(page, FEATURE_PAGE.replace("rpm", "speed"), 2);
      release();
      expect(await pending).toBeUndefined();
    });

    it("logs a TypeScript failure and answers nothing", async () => {
      const engine = recordingEngine();
      engine.feature.mockResolvedValue({ status: "failed", message: "boom" });
      await start({ createTypeScriptEngine: () => engine });
      const page = await write("src/pages/index.html", FEATURE_PAGE);
      open(page, FEATURE_PAGE);
      expect(
        await fake.handlers.get("definition")!({
          textDocument: { uri: uri(page) },
          position: at("froth(2", 1),
        }),
      ).toBeUndefined();
      expect(fake.connection.console.error).toHaveBeenCalledWith(
        expect.stringContaining("boom"),
      );
    });
  });
});

describe("readInitializationOptions", () => {
  it("turns TypeScript on by default and reads the editor's flag", () => {
    expect(readInitializationOptions(undefined)).toEqual({
      typescriptEnabled: true,
      typescriptPath: undefined,
      typescriptEditorPath: undefined,
      typescriptReleaseDelayMs: undefined,
      editorHasEmbeddedTypeScript: false,
    });
    expect(
      readInitializationOptions({
        typescript: {
          enabled: true,
          path: "/ts",
          editorPath: " /editor/ts ",
          releaseDelayMs: 0,
        },
        editorHasEmbeddedTypeScript: true,
      }),
    ).toEqual({
      typescriptEnabled: true,
      typescriptPath: "/ts",
      typescriptEditorPath: "/editor/ts",
      typescriptReleaseDelayMs: 0,
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
        typescriptEditorPath: undefined,
        editorHasEmbeddedTypeScript: false,
      });
    }
    expect(
      readInitializationOptions({
        typescript: {
          enabled: "false",
          path: "   ",
          editorPath: 3,
          releaseDelayMs: "100",
        },
        editorHasEmbeddedTypeScript: "yes",
      }),
    ).toEqual({
      typescriptEnabled: true,
      typescriptPath: undefined,
      typescriptEditorPath: undefined,
      typescriptReleaseDelayMs: undefined,
      editorHasEmbeddedTypeScript: false,
    });
    expect(
      readInitializationOptions({ typescript: { enabled: false, path: 7 } }),
    ).toMatchObject({
      typescriptEnabled: false,
      typescriptPath: undefined,
    });
    for (const releaseDelayMs of [-1, Number.NaN, Infinity])
      expect(
        readInitializationOptions({ typescript: { releaseDelayMs } }),
      ).toMatchObject({ typescriptReleaseDelayMs: undefined });
  });
});
