import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTypeScript } from "./typescript-loader.js";
import {
  createFixture,
  type Fixture,
  TYPESCRIPT_6_DIR,
  TYPESCRIPT_7_DIR,
} from "./typescript.test.util.js";

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.remove();
});

function fixture(files: Record<string, string> = {}): Fixture {
  const created = createFixture(files);
  fixtures.push(created);
  return created;
}

/** A package named typescript that loads but has only the given library files beside it (none by default). */
function typescriptWithoutLibFiles(
  root: Fixture,
  libFiles: string[] = [],
): string {
  root.write(
    "broken-typescript/package.json",
    JSON.stringify({ name: "typescript", version: "6.0.0", main: "index.js" }),
  );
  root.write(
    "broken-typescript/index.js",
    'module.exports = { version: "6.0.0", createLanguageService() {}, getDefaultLibFilePath: () => __dirname + "/lib/lib.d.ts" };\n',
  );
  for (const name of libFiles)
    root.write(`broken-typescript/lib/${name}`, "// library\n");
  return root.file("broken-typescript");
}

describe("resolveTypeScript", () => {
  it("uses the path the client passes first, even when the project has its own", () => {
    const root = fixture();
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = resolveTypeScript({
      clientPath: TYPESCRIPT_6_DIR,
      projectRoot: root.root,
    });
    expect(result).toMatchObject({
      ok: true,
      source: "client",
      version: "6.0.3",
    });
  });

  it("accepts a client path that names the package's lib folder, as typescript.tsdk does", () => {
    const root = fixture();
    const result = resolveTypeScript({
      clientPath: path.join(TYPESCRIPT_6_DIR, "lib"),
      projectRoot: root.root,
    });
    expect(result).toMatchObject({
      ok: true,
      source: "client",
      packageDir: TYPESCRIPT_6_DIR,
    });
  });

  it("falls back to the project's typescript when the client path is not a typescript package, and says so", () => {
    const root = fixture();
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = resolveTypeScript({
      clientPath: root.file("no/such/typescript"),
      projectRoot: root.root,
    });
    expect(result).toMatchObject({ ok: true, source: "project" });
    expect(result.skipped.join("\n")).toContain(
      "is not a typescript package folder",
    );
  });

  it("misuse: rejects TypeScript 7, which has no language service, from the client and from the project", () => {
    const root = fixture();
    root.link("node_modules/typescript", TYPESCRIPT_7_DIR);
    const result = resolveTypeScript({
      clientPath: TYPESCRIPT_7_DIR,
      projectRoot: root.root,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(
      'TypeScript checks of type="text/typescript" scripts are off',
    );
    expect(result.message).toMatch(
      /TypeScript 7\.\d+\.\d+ in .* has no language service/,
    );
    expect(result.message).toContain("npm install --save-dev typescript@6");
    // Tried once even though the client path and the project name the same copy.
    expect(result.skipped).toHaveLength(1);
  });

  it("misuse: with no typescript anywhere, checks are off with one line that says how to turn them on", () => {
    const root = fixture();
    const result = resolveTypeScript({ projectRoot: root.root });
    expect(result).toEqual({
      ok: false,
      message: `TypeScript checks of type="text/typescript" scripts are off: no usable typescript was found from ${root.root}. Install TypeScript 5 or 6 with: npm install --save-dev typescript@6`,
      skipped: [],
    });
    expect(result.ok || result.message.includes("\n")).toBe(false);
  });

  it("misuse: rejects a copy whose library files are missing, naming the file", () => {
    const root = fixture();
    const result = resolveTypeScript({
      clientPath: typescriptWithoutLibFiles(root),
      projectRoot: root.root,
    });
    expect(result.ok).toBe(false);
    expect(result.skipped[0]).toContain("is missing library files");
    expect(result.skipped[0]).toContain(path.join("broken-typescript", "lib"));
    expect(result.skipped[0]).toContain("lib.es5.d.ts");
  });

  it("misuse: rejects a copy missing only the DOM library, which every browser block needs", () => {
    const root = fixture();
    const result = resolveTypeScript({
      clientPath: typescriptWithoutLibFiles(root, [
        "lib.es5.d.ts",
        "lib.es2022.d.ts",
        "lib.dom.iterable.d.ts",
        "lib.webworker.d.ts",
        "lib.webworker.iterable.d.ts",
      ]),
      projectRoot: root.root,
    });
    expect(result.ok).toBe(false);
    expect(result.skipped[0]).toMatch(
      /is missing library files .*: lib\.dom\.d\.ts$/,
    );
  });

  it("misuse: a client path that throws on load is skipped, not thrown", () => {
    const root = fixture();
    root.write(
      "throwing/package.json",
      JSON.stringify({
        name: "typescript",
        version: "6.0.0",
        main: "index.js",
      }),
    );
    root.write("throwing/index.js", 'throw new Error("broken install");\n');
    const result = resolveTypeScript({
      clientPath: root.file("throwing"),
      projectRoot: root.root,
    });
    expect(result.ok).toBe(false);
    expect(result.skipped[0]).toContain("broken install");
  });

  it("finds an installed peer beside this package after the project", () => {
    const root = fixture();
    const elsewhere = fixture();
    elsewhere.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = resolveTypeScript({
      projectRoot: root.root,
      fallbackFrom: pathToFileURL(elsewhere.file("lsp/dist/check.js")).href,
    });
    expect(result).toMatchObject({
      ok: true,
      source: "project",
      packageDir: TYPESCRIPT_6_DIR,
    });
  });

  it("resolves a relative project root from the current directory", () => {
    const root = fixture();
    root.link("node_modules/typescript", TYPESCRIPT_6_DIR);
    const result = resolveTypeScript({
      projectRoot: path.relative(process.cwd(), root.root),
    });
    expect(result).toMatchObject({ ok: true, source: "project" });
  });
});
