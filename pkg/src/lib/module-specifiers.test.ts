import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  LeadingSlashSpecifierError,
  classifySpecifier,
  findModuleSpecifiers,
  rewriteModuleSpecifiers,
  rewriteRelativeModuleSpecifiers,
  resolveScriptSrcPath,
  resolveSpecifierPath,
} from "./module-specifiers.ts";

const baseDir = resolve(process.cwd(), "src/pages/nested");
const importRoot = resolve(process.cwd(), "src");
const rootUrl = (rel: string) => pathToFileURL(resolve(importRoot, rel)).href;
const baseUrl = (rel: string) => pathToFileURL(resolve(baseDir, rel)).href;
const rewrite = (source: string) => rewriteModuleSpecifiers(source, baseDir, { importRoot });

describe("classifySpecifier", () => {
  it.each(["./a.ts", "../a.ts", "./", "../"])("classifies %s as relative", (value) => {
    expect(classifySpecifier(value)).toBe("relative");
  });

  it.each(["@/lib/a.ts", "@/"])("classifies %s as root", (value) => {
    expect(classifySpecifier(value)).toBe("root");
  });

  it.each(["/lib/a.ts", "/a", "/"])("classifies %s as root-slash (rejected, not an alias)", (value) => {
    expect(classifySpecifier(value)).toBe("root-slash");
  });

  it.each([
    "@scope/pkg",
    "@scope",
    "@",
    "marked",
    "node:fs",
    "file:///tmp/x.ts",
    "https://example.com/x.mjs",
    "data:text/javascript,export default 1",
    "lib/a.ts",
    ".hidden",
  ])("classifies %s as external", (value) => {
    expect(classifySpecifier(value)).toBe("external");
  });
});

describe("rewriteModuleSpecifiers with an import root", () => {
  it("rewrites @/ static imports against the import root", () => {
    expect(rewrite("import { a } from '@/lib/a.ts';")).toBe(`import { a } from '${rootUrl("lib/a.ts")}';`);
  });

  it("rejects a leading-slash static import with a did-you-mean pointing at @/", () => {
    expect(() => rewrite("import { a } from '/lib/a.ts';")).toThrow(LeadingSlashSpecifierError);
    expect(() => rewrite("import { a } from '/lib/a.ts';")).toThrow("'/lib/a.ts'");
    expect(() => rewrite("import { a } from '/lib/a.ts';")).toThrow("@/lib/a.ts");
  });

  it("rejects leading-slash dynamic and export-from specifiers too", () => {
    expect(() => rewrite("const m = await import('/lib/a.ts');")).toThrow(LeadingSlashSpecifierError);
    expect(() => rewrite("export { a } from '/lib/a.ts';")).toThrow(LeadingSlashSpecifierError);
  });

  it("resolveSpecifierPath throws for a leading slash and the message names the fix", () => {
    expect(() => resolveSpecifierPath("/lib/a.ts", baseDir, importRoot)).toThrow(LeadingSlashSpecifierError);
    expect(() => resolveSpecifierPath("/lib/a.ts", baseDir, importRoot)).toThrow(/@\/lib\/a\.ts/);
    expect(() => resolveSpecifierPath("/lib/a.ts", baseDir, importRoot)).toThrow(/\.\/lib\/a\.ts/);
  });

  it("rewrites dynamic, export-from, and bare side-effect alias imports", () => {
    const source = [
      "const m = await import('@/lib/a.ts');",
      "export { a } from '@/lib/a.ts';",
      "import '@/setup.ts';",
    ].join("\n");
    expect(rewrite(source)).toBe([
      `const m = await import('${rootUrl("lib/a.ts")}');`,
      `export { a } from '${rootUrl("lib/a.ts")}';`,
      `import '${rootUrl("setup.ts")}';`,
    ].join("\n"));
  });

  it("keeps ./ and ../ resolved against baseDir, not the import root", () => {
    const source = "import a from './a.ts';\nimport b from '../b.ts';";
    expect(rewrite(source)).toBe(
      `import a from '${baseUrl("a.ts")}';\nimport b from '${baseUrl("../b.ts")}';`,
    );
  });

  it.each([
    "import x from '@scope/pkg';",
    "import x from '@scope/pkg/sub';",
    "import { marked } from 'marked';",
    "import { readFile } from 'node:fs/promises';",
    "import x from 'file:///abs/x.ts';",
    "import x from 'https://example.com/x.mjs';",
    "import x from 'data:text/javascript,export default 1';",
  ])("leaves %s byte-for-byte unchanged", (source) => {
    expect(rewrite(source)).toBe(source);
  });

  it("leaves alias text in comments, strings, template raw text, and regex literals unchanged", () => {
    // Leading-slash text inside comments, strings, and template raw text must
    // not be classified either: it is never a genuine specifier.
    const source = [
      "// import '@/comment.ts'",
      "/* import '/block.ts' */",
      "const quoted = \"import('@/quoted.ts')\";",
      "const raw = `import('/raw.ts') ${import('@/expression.ts')}`;",
      "const matcher = /import\\('@\\/regex\\.ts'\\)/;",
      "obj.import('@/method.ts');",
    ].join("\n");
    const rewritten = rewrite(source);
    expect(rewritten).toContain("// import '@/comment.ts'");
    expect(rewritten).toContain("/* import '/block.ts' */");
    expect(rewritten).toContain("\"import('@/quoted.ts')\"");
    expect(rewritten).toContain("`import('/raw.ts') ${import('file:");
    expect(rewritten).toContain(`import('${rootUrl("expression.ts")}')`);
    expect(rewritten).toContain("/import\\('@\\/regex\\.ts'\\)/");
    expect(rewritten).toContain("obj.import('@/method.ts')");
  });

  it("inserts replacement values literally even when the import root contains $ tokens", () => {
    const dollarRoot = resolve(process.cwd(), "src/$&/$1/$`");
    const rewritten = rewriteModuleSpecifiers("import a from '@/lib/a.ts';", baseDir, { importRoot: dollarRoot });
    expect(rewritten).toBe(`import a from '${pathToFileURL(resolve(dollarRoot, "lib/a.ts")).href}';`);
  });

  it("supports an import root outside the project (monorepo shared folder)", () => {
    const sharedRoot = resolve(process.cwd(), "../shared");
    const rewritten = rewriteModuleSpecifiers("import a from '@/lib/a.ts';", baseDir, { importRoot: sharedRoot });
    expect(rewritten).toBe(`import a from '${pathToFileURL(resolve(process.cwd(), "../shared/lib/a.ts")).href}';`);
  });

  it("keeps the legacy export name as an alias", () => {
    expect(rewriteRelativeModuleSpecifiers).toBe(rewriteModuleSpecifiers);
  });
});

describe("resolveScriptSrcPath", () => {
  const containingDir = resolve(process.cwd(), "src/pages/nested");

  it("resolves ./ and ../ against the containing directory", () => {
    expect(resolveScriptSrcPath("./x.ts", containingDir, importRoot)).toBe(resolve(containingDir, "x.ts"));
    expect(resolveScriptSrcPath("../x.ts", containingDir, importRoot)).toBe(resolve(containingDir, "../x.ts"));
  });

  it("resolves bare paths against the containing directory (unchanged behavior)", () => {
    expect(resolveScriptSrcPath("lib/x.ts", containingDir, importRoot)).toBe(resolve(containingDir, "lib/x.ts"));
  });

  it("resolves @/ against the import root", () => {
    expect(resolveScriptSrcPath("@/lib/x.ts", containingDir, importRoot)).toBe(resolve(importRoot, "lib/x.ts"));
  });

  it("rejects a leading-slash src with a did-you-mean pointing at @/", () => {
    expect(() => resolveScriptSrcPath("/lib/x.ts", containingDir, importRoot)).toThrow(LeadingSlashSpecifierError);
    expect(() => resolveScriptSrcPath("/lib/x.ts", containingDir, importRoot)).toThrow("@/lib/x.ts");
  });
});

describe("findModuleSpecifiers", () => {
  it.each([
    `if (ready) /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `{ markReady(); } /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `if (ready) /import('fake-package')/.test(source);`,
    `{ markReady(); } /import('fake-package')/.test(source);`,
  ])("ignores import-like text in a regex after a statement boundary", (source) => {
    expect(findModuleSpecifiers(source)).toEqual([]);
  });
});