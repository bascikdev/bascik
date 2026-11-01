import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runCliCheck } from "./cli.js";

describe("runCliCheck", () => {
  let tempDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-cli-test-"));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 0 when checking clean files", async () => {
    const pageHtml =
      "<!DOCTYPE html><html><head><title>Test</title></head><body><p>Hello</p></body></html>";
    const filePath = path.join(tempDir, "clean.html");
    fs.writeFileSync(filePath, pageHtml);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("No Bascik diagnostics found"),
    );
  });

  it("reports errors and returns 1 when checking a file with errors", async () => {
    // A misplaced script directive on a non-script element produces an error
    const pageHtml =
      "<!DOCTYPE html><html><head><title>Test</title></head><body><div data-bascik-build></div></body></html>";
    const filePath = path.join(tempDir, "error.html");
    fs.writeFileSync(filePath, pageHtml);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("only valid on <script> tags"),
    );
  });

  it("returns 0 when a file has warnings but no errors", async () => {
    // Unknown data-bascik-preserve token is a warning, not an error
    const html = '<div data-bascik-preserve="invalid"></div>';
    const filePath = path.join(tempDir, "warning.html");
    fs.writeFileSync(filePath, html);

    const exitCode = await runCliCheck([filePath]);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("Found 0 errors, 1 warning."),
    );
  });

  describe("component roots outside the project", () => {
    // A monorepo site lists a shared folder as a component root: directory.components: ['src/components', '../shared'].
    const slotted =
      '<style>\n  .box { padding: 1rem; }\n</style>\n<div class="box"><div data-bascik-slot></div></div>\n';
    const setup = () => {
      const site = path.join(tempDir, "sites", "a");
      const shared = path.join(tempDir, "shared");
      fs.mkdirSync(path.join(site, "src", "components"), { recursive: true });
      fs.mkdirSync(path.join(shared, "slot-box"), { recursive: true });
      fs.writeFileSync(
        path.join(site, "bascik.config.ts"),
        "export default { directory: { components: ['src/components', '../../shared'] } };\n",
      );
      fs.writeFileSync(path.join(shared, "slot-box", "slot-box.html"), slotted);
      return { site, shared };
    };

    it("lints a shared root as component files with --project", async () => {
      const { site, shared } = setup();
      const exitCode = await runCliCheck([shared, "--project", site]);
      expect(exitCode).toBe(0);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("No Bascik diagnostics found"),
      );
    });

    it("accepts --project=<dir>", async () => {
      const { site, shared } = setup();
      expect(await runCliCheck([`--project=${site}`, shared])).toBe(0);
    });

    it("uses the project in the working directory when the target is one of its component roots", async () => {
      const { site, shared } = setup();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(site);
      try {
        expect(await runCliCheck([shared])).toBe(0);
      } finally {
        cwd.mockRestore();
      }
    });

    it("still treats a folder that belongs to no project as plain HTML", async () => {
      const { shared } = setup();
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(tempDir);
      try {
        expect(await runCliCheck([shared])).toBe(1);
        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining("only valid inside a Bascik component body"),
        );
      } finally {
        cwd.mockRestore();
      }
    });

    it("fails when --project does not exist", async () => {
      const { shared } = setup();
      expect(
        await runCliCheck([shared, "--project", path.join(tempDir, "missing")]),
      ).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Project directory does not exist"),
      );
    });
  });

  it("checks every path it is given, not only the last", async () => {
    const components = path.join(tempDir, "components");
    const pages = path.join(tempDir, "pages");
    fs.mkdirSync(components);
    fs.mkdirSync(pages);
    fs.writeFileSync(
      path.join(components, "broken.html"),
      "<div data-bascik-build></div>",
    );
    fs.writeFileSync(path.join(pages, "clean.html"), "<p>Milk frother</p>");

    expect(await runCliCheck([components, pages])).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken.html"),
    );
    consoleLogSpy.mockClear();
    expect(await runCliCheck([pages, components])).toBe(1);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("broken.html"),
    );
  });

  it.each([
    [["--fixx"], "Unknown option: --fixx"],
    [["-f"], "Unknown option: -f"],
    [["--project"], "--project needs a directory"],
    [["--project", "--fix"], "--project needs a directory"],
    [["--project="], "--project needs a directory"],
  ])(
    "rejects %j with a usage error instead of ignoring it",
    async (args, message) => {
      const filePath = path.join(tempDir, "clean.html");
      fs.writeFileSync(filePath, "<p>Hello</p>");
      expect(await runCliCheck([filePath, ...args])).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(message),
      );
      expect(consoleLogSpy).not.toHaveBeenCalled();
    },
  );

  it("still accepts the transport flag an editor may pass", async () => {
    const filePath = path.join(tempDir, "clean.html");
    fs.writeFileSync(filePath, "<p>Hello</p>");
    expect(await runCliCheck(["--stdio", filePath])).toBe(0);
  });

  it("returns 1 when target path does not exist", async () => {
    const nonExistent = path.join(tempDir, "does-not-exist.html");
    const exitCode = await runCliCheck([nonExistent]);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Path does not exist"),
    );
  });
});
