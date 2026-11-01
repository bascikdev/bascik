import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleExtension,
  bundledPackageFolders,
  bundleServer,
  NOTICES_FILE,
  thirdPartyNotices,
  // @ts-expect-error build.mjs is plain JavaScript with no declaration file.
} from "../build.mjs";

interface Metafile {
  inputs: Record<string, unknown>;
}
interface BuildResult {
  metafile: Metafile;
}

/**
 * Both bundles inline MIT, ISC and Blue Oak licensed packages, and those licenses require their notices to
 * travel with every copy. The build writes them to dist/THIRD-PARTY-NOTICES.txt from the packages esbuild
 * actually bundled, so a new dependency cannot ship without its notice.
 */
describe("third-party notices", () => {
  let work: string;
  let folders: string[];
  let notices: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "bascik-ext-notices-"));
    // Bundled outside the extension folder, so the test never depends on (or overwrites) a prior build.
    const results = (await Promise.all([
      bundleExtension(join(work, "dist/extension.js")),
      bundleServer(join(work, "dist/server.js")),
    ])) as BuildResult[];
    folders = bundledPackageFolders(results.map((result) => result.metafile));
    notices = thirdPartyNotices(folders);
  }, 30_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("is written beside the bundles", () => {
    expect(NOTICES_FILE).toBe("THIRD-PARTY-NOTICES.txt");
  });

  it("lists every package the bundles inline, with the license text it ships", () => {
    const names = folders.map((folder) => basename(folder));
    for (const name of [
      "vscode-languageclient",
      "vscode-languageserver",
      "vscode-languageserver-protocol",
      "vscode-languageserver-types",
      "vscode-languageserver-textdocument",
      "vscode-jsonrpc",
    ]) {
      expect(names).toContain(name);
    }
    for (const folder of folders) {
      expect(notices).toContain(`${basename(folder)}@`);
    }
    expect(notices).toContain("Copyright (c) Microsoft Corporation");
    expect(notices).toContain("Permission is hereby granted, free of charge");
  });

  it("lists a package once when both bundles inline it", () => {
    const count = (name: string) =>
      notices.split("\n").filter((line) => line.startsWith(`${name}@`)).length;
    expect(count("vscode-languageserver-protocol")).toBe(1);
    expect(count("vscode-jsonrpc")).toBe(1);
  });

  it("leaves out the extension's own sources and the language server's", () => {
    expect(
      bundledPackageFolders([
        {
          inputs: {
            "src/extension.ts": {},
            "../../lsp/src/start.ts": {},
          },
        },
      ]),
    ).toEqual([]);
  });

  it("finds nested and scoped packages, with either path separator", () => {
    const found: string[] = bundledPackageFolders(
      [
        {
          inputs: {
            "../../node_modules/minimatch/node_modules/brace-expansion/index.js":
              {},
            "..\\..\\node_modules\\@scope\\pkg\\lib\\main.js": {},
          },
        },
      ],
      "/repo/extensions/vscode-bascik",
    );
    expect(found.map((folder) => folder.replace(/\\/g, "/"))).toEqual([
      expect.stringMatching(
        /\/repo\/node_modules\/minimatch\/node_modules\/brace-expansion$/,
      ),
      expect.stringMatching(/\/repo\/node_modules\/@scope\/pkg$/),
    ]);
  });

  it("fails the build, naming the package, when a bundled package has no license file", async () => {
    const folder = join(work, "node_modules/no-license-here");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ name: "no-license-here", version: "1.2.3" }),
    );
    expect(() => thirdPartyNotices([folder])).toThrow(
      /no-license-here@1\.2\.3.*no license file.*no-license-here/s,
    );
  });
});
