import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeComponent } from "./catalog.ts";

// What a consumer gets. This builds dist/ (through `prepack`), packs the
// package exactly as `yarn npm publish` would, unpacks the tarball into a
// project's node_modules, and uses it from there with plain `node`: the
// source tree's `src/` exports, which only this repository can run, are not
// what is published.

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const repository = join(root, "..");
const windows = process.platform === "win32";

type Manifest = {
  name: string;
  version: string;
  files: string[];
  bascik: { components: string };
  peerDependencies: Record<string, string>;
  publishConfig: {
    access: string;
    types: string;
    exports: Record<string, { types: string; default: string }>;
  };
  exports: Record<string, { types: string; default: string }>;
  types: string;
};

const manifest = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as Manifest;

let work = "";
let consumer = "";
let installed = "";
let packed: Manifest;
let files: string[] = [];

async function listFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await listFiles(path)));
    else found.push(path);
  }
  return found;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "bascik-genui-pack-"));
  const tarball = join(work, "genui.tgz");
  // `yarn pack` runs `prepack` (build + LICENSE) and applies `publishConfig`,
  // which is what turns the exports into dist/.
  await run("yarn", ["pack", "--out", tarball], {
    cwd: root,
    shell: windows,
    maxBuffer: 64 * 1024 * 1024,
  });

  consumer = join(work, "consumer");
  installed = join(consumer, "node_modules", "@bascik", "genui");
  await mkdir(installed, { recursive: true });
  // The tarball's files sit under `package/`.
  await run("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);

  // The peers an install would bring: this repository's own copies.
  for (const peer of Object.keys(manifest.peerDependencies)) {
    const target = join(consumer, "node_modules", peer);
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(
      join(repository, "node_modules", peer),
      target,
      windows ? "junction" : "dir",
    );
  }

  packed = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  ) as Manifest;
  files = (await listFiles(installed)).map((file) =>
    relative(installed, file).split(sep).join("/"),
  );
});

afterAll(async () => {
  if (work) await rm(work, { recursive: true, force: true });
});

describe("the packed package", () => {
  it("publishes dist/ for every entry, not the source the repository runs", async () => {
    expect(packed.name).toBe("@bascik/genui");
    expect(packed.version).toBe(manifest.version);
    expect(packed.exports).toEqual(manifest.publishConfig.exports);
    expect(packed.types).toBe(manifest.publishConfig.types);
    expect(Object.keys(packed.exports)).toEqual(Object.keys(manifest.exports));
    for (const [entry, target] of Object.entries(packed.exports)) {
      for (const path of [target.default, target.types]) {
        expect(path, entry).toMatch(/^\.\/dist\//);
        expect(await exists(join(installed, path)), `${entry}: ${path}`).toBe(
          true,
        );
      }
      expect(target.default, entry).toMatch(/\.js$/);
      expect(target.types, entry).toMatch(/\.d\.ts$/);
    }
  });

  it("imports every entry with plain node, with its peers resolvable", async () => {
    for (const entry of Object.keys(packed.exports)) {
      const specifier =
        entry === "." ? packed.name : `${packed.name}/${entry.slice(2)}`;
      const { stdout } = await run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `const m = await import(${JSON.stringify(specifier)});
           console.log(JSON.stringify(Object.keys(m)));`,
        ],
        { cwd: consumer },
      );
      const names = JSON.parse(stdout.trim()) as string[];
      expect(names.length, specifier).toBeGreaterThan(0);
    }
  });

  it("ships components that describe themselves", async () => {
    const folder = join(installed, manifest.bascik.components);
    expect(packed.files).toContain("components/");
    const components = (await listFiles(folder)).filter((file) =>
      file.endsWith(".html"),
    );
    expect(components.length).toBeGreaterThan(15);
    for (const file of components) {
      const described = describeComponent(file, await readFile(file, "utf8"));
      expect(described, file).not.toBeNull();
      expect(described!.description, file).not.toBe("");
    }
  });

  it("ships the license and the npm README, and nothing a user did not ask for", () => {
    expect(files).toContain("package.json");
    expect(files).toContain("LICENSE");
    expect(files).toContain("README.md");
    expect(files).not.toContain("NOTES.md");
    const tops = new Set(files.map((file) => file.split("/")[0]));
    expect([...tops].sort()).toEqual(
      ["LICENSE", "README.md", "components", "dist", "package.json"].sort(),
    );
    const unwanted = files.filter(
      (file) =>
        /\.test\.|\.spec\.|\.test-helper\./.test(file) ||
        /(^|\/)(demo|e2e|stress|src|fixtures)\//.test(file) ||
        /(^|\/)(NOTES\.md|playwright\.config|vite\.config|tsconfig[^/]*)/.test(
          file,
        ),
    );
    expect(unwanted).toEqual([]);
  });
});
