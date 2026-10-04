/**
 * example.test.ts
 *
 * Boundary: real HTTP download from a local server -> real streaming tar parse -> real file system
 * writes in a temp directory. Only the host differs from production (`archiveBase`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  ExampleError,
  archiveUrl,
  assertDestinationFree,
  extractExample,
  installExample,
  nodeSatisfies,
  readProjectManifest,
  readTemplateInfo,
  safeSegments,
} from "./example.js";
import { type FixtureServer, githubArchive, startFixtureServer, tarGz } from "./archive-fixtures.js";

let server: FixtureServer;
let work: string;

beforeEach(async () => {
  server = await startFixtureServer();
  work = await mkdtemp(join(tmpdir(), "create-bascik-example-test-"));
});

afterEach(async () => {
  await server.close();
  await rm(work, { recursive: true, force: true });
});

const source = (path = "", ref: string | null = "main") => ({ kind: "github" as const, owner: "o", repo: "r", ref, path, label: "o/r" });
const route = (ref = "main") => `/o/r/tar.gz/${ref}`;
const serve = (body: Buffer, ref = "main") => server.routes.set(route(ref), { body });
const staging = async () => {
  const dir = join(work, "staging");
  await mkdir(dir);
  return dir;
};
const names = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

describe("safeSegments", () => {
  it("drops empty and . segments", () => {
    expect(safeSegments("a//b/./c/")).toEqual(["a", "b", "c"]);
  });

  it.each(["../x", "a/../x", "a/..", "/etc/passwd", "C:/x", "c:\\x", "a\\b", "a\0b", "//server/share"])("rejects %j", (path) => {
    expect(() => safeSegments(path)).toThrow(ExampleError);
  });
});

describe("archiveUrl", () => {
  it("uses codeload and encodes every part", () => {
    expect(archiveUrl(source("", "v1.0.0"))).toBe("https://codeload.github.com/o/r/tar.gz/v1.0.0");
    expect(archiveUrl(source("", null))).toBe("https://codeload.github.com/o/r/tar.gz/HEAD");
    expect(archiveUrl({ ...source(), owner: "a b" }, "http://x.test/")).toBe("http://x.test/a%20b/r/tar.gz/main");
  });
});

describe("extractExample", () => {
  it("extracts the chosen folder without its wrapper and prefix", async () => {
    serve(githubArchive({ "README.md": "root", "apps/web/package.json": "{}", "apps/web/src/index.html": "hi", "apps/other/x.txt": "no" }));
    const dir = await staging();
    const result = await extractExample(source("apps/web"), dir, { archiveBase: server.base });
    expect(result.files).toBe(2);
    expect(await names(dir)).toEqual(["package.json", "src", "src/index.html"]);
    expect(await readFile(join(dir, "src/index.html"), "utf8")).toBe("hi");
  });

  it("extracts the whole repository when no folder is given", async () => {
    serve(githubArchive({ "package.json": "{}", "a/b.txt": "b" }));
    const dir = await staging();
    await extractExample(source(""), dir, { archiveBase: server.base });
    expect(await names(dir)).toEqual(["a", "a/b.txt", "package.json"]);
  });

  it("does not confuse a folder with a longer name for the chosen folder", async () => {
    serve(githubArchive({ "app/package.json": "{}", "app-old/package.json": "{}", "application.txt": "x" }));
    const dir = await staging();
    await extractExample(source("app"), dir, { archiveBase: server.base });
    expect(await names(dir)).toEqual(["package.json"]);
  });

  it("requests the pinned ref", async () => {
    serve(githubArchive({ "package.json": "{}" }), "v2.0.0");
    await extractExample(source("", "v2.0.0"), await staging(), { archiveBase: server.base });
    expect(server.requests).toEqual(["/o/r/tar.gz/v2.0.0"]);
  });

  it("keeps the executable bit and strips every other mode bit", async () => {
    serve(
      tarGz([
        { path: "r-main", type: "dir" },
        { path: "r-main/run.sh", type: "file", content: "#!/bin/sh\n", mode: 0o4755 },
        { path: "r-main/data.txt", type: "file", content: "x", mode: 0o666 },
      ]),
    );
    const dir = await staging();
    await extractExample(source(""), dir, { archiveBase: server.base });
    expect((await stat(join(dir, "run.sh"))).mode & 0o7777).toBe(0o755 & ~process.umask());
    expect((await stat(join(dir, "data.txt"))).mode & 0o7777).toBe(0o644 & ~process.umask());
  });

  it("extracts empty folders and empty files", async () => {
    serve(tarGz([{ path: "r-main", type: "dir" }, { path: "r-main/empty", type: "dir" }, { path: "r-main/blank.txt", type: "file", content: "" }]));
    const dir = await staging();
    await extractExample(source(""), dir, { archiveBase: server.base });
    expect(await names(dir)).toEqual(["blank.txt", "empty"]);
  });

  describe("malicious archives", () => {
    const attack = async (entries: Parameters<typeof tarGz>[0], pattern: RegExp, folder = "") => {
      serve(tarGz([{ path: "r-main", type: "dir" }, ...entries]));
      const dir = await staging();
      await expect(extractExample(source(folder), dir, { archiveBase: server.base })).rejects.toThrow(pattern);
      return dir;
    };

    it("rejects a path that climbs out with ..", async () => {
      await attack([{ path: "r-main/../../escape.txt", type: "file", content: "x" }], /climbs out/);
      await expect(lstat(join(work, "escape.txt"))).rejects.toThrow();
    });

    it("rejects an absolute path", async () => {
      await attack([{ path: "/tmp/create-bascik-abs-test.txt", type: "file", content: "x" }], /absolute path/);
      await expect(lstat("/tmp/create-bascik-abs-test.txt")).rejects.toThrow();
    });

    it("rejects a backslash path", async () => {
      await attack([{ path: "r-main/a\\b.txt", type: "file", content: "x" }], /backslash/);
    });

    it("rejects a Windows drive path", async () => {
      await attack([{ path: "C:/x.txt", type: "file", content: "x" }], /absolute path/);
    });

    it("rejects a symbolic link, and writes nothing through it", async () => {
      const dir = await attack(
        [
          { path: "r-main/link", type: "symlink", target: work },
          { path: "r-main/link/pwned.txt", type: "file", content: "x" },
        ],
        /symbolic link/,
      );
      await expect(lstat(join(work, "pwned.txt"))).rejects.toThrow();
      expect(await names(dir)).not.toContain("link");
    });

    it("rejects a symbolic link to a file inside the folder too", async () => {
      await attack([{ path: "r-main/a.txt", type: "file", content: "x" }, { path: "r-main/b", type: "symlink", target: "a.txt" }], /symbolic link/);
    });

    it("rejects a hard link", async () => {
      await attack([{ path: "r-main/a.txt", type: "file", content: "x" }, { path: "r-main/b.txt", type: "hardlink", target: "r-main/a.txt" }], /hard link/);
    });

    it("rejects a link anywhere under the chosen folder, but ignores one outside it", async () => {
      await attack([{ path: "r-main/app/package.json", type: "file", content: "{}" }, { path: "r-main/app/deep/l", type: "symlink", target: "/etc" }], /symbolic link/, "app");
      serve(tarGz([{ path: "r-main", type: "dir" }, { path: "r-main/app/package.json", type: "file", content: "{}" }, { path: "r-main/other/l", type: "symlink", target: "/etc" }]), "other");
      const dir = join(work, "second");
      await mkdir(dir);
      await extractExample(source("app", "other"), dir, { archiveBase: server.base });
      expect(await names(dir)).toEqual(["package.json"]);
    });

    it("refuses to overwrite a file already in the staging directory", async () => {
      serve(githubArchive({ "package.json": "{}" }));
      const dir = await staging();
      await writeFile(join(dir, "package.json"), "mine");
      await expect(extractExample(source(""), dir, { archiveBase: server.base })).rejects.toThrow();
      expect(await readFile(join(dir, "package.json"), "utf8")).toBe("mine");
    });

    it("enforces the entry limit before writing everything", async () => {
      serve(githubArchive(Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`f${index}.txt`, "x"]))));
      await expect(extractExample(source(""), await staging(), { archiveBase: server.base, limits: { maxEntries: 10 } })).rejects.toThrow(/more than 10 entries/);
    });

    it("enforces the per-file limit", async () => {
      serve(githubArchive({ "big.txt": "x".repeat(2000) }));
      await expect(extractExample(source(""), await staging(), { archiveBase: server.base, limits: { maxFileBytes: 1000 } })).rejects.toThrow(/larger than/);
    });

    it("enforces the total written limit", async () => {
      serve(githubArchive({ "a.txt": "x".repeat(600), "b.txt": "x".repeat(600) }));
      await expect(extractExample(source(""), await staging(), { archiveBase: server.base, limits: { maxWrittenBytes: 1000 } })).rejects.toThrow(/larger than/);
    });

    it("enforces the expanded-archive limit even for entries that are not selected", async () => {
      serve(githubArchive({ "skipped/huge.txt": "x".repeat(5000), "app/package.json": "{}" }));
      await expect(extractExample(source("app"), await staging(), { archiveBase: server.base, limits: { maxArchiveBytes: 1000 } })).rejects.toThrow(/expands to more than/);
    });

    it("enforces the download limit on compressed bytes", async () => {
      serve(githubArchive({ "a.bin": randomBytes(4000) }));
      await expect(extractExample(source(""), await staging(), { archiveBase: server.base, limits: { maxDownloadBytes: 500 } })).rejects.toThrow(/download is larger/);
    });

    it("leaves nothing written after the first violation is reported", async () => {
      serve(tarGz([{ path: "r-main", type: "dir" }, { path: "r-main/../x", type: "file", content: "x" }, { path: "r-main/after.txt", type: "file", content: "x" }]));
      const dir = await staging();
      await expect(extractExample(source(""), dir, { archiveBase: server.base })).rejects.toThrow(ExampleError);
      await new Promise((accept) => setTimeout(accept, 50));
      expect(await names(dir)).not.toContain("x");
    });
  });

  describe("failures", () => {
    it("explains a missing repository or ref", async () => {
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(/no archive for o\/r at "main"/);
    });

    it("says an official example may not be published yet", async () => {
      await expect(extractExample({ ...source(), kind: "official" }, await staging(), { archiveBase: server.base })).rejects.toThrow(/may not be published yet/);
    });

    it("explains rate limiting", async () => {
      server.routes.set(route(), { status: 429, body: "slow down" });
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(/rate limited/);
    });

    it("reports other server errors with the status", async () => {
      server.routes.set(route(), { status: 502, body: "bad gateway" });
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(/HTTP 502/);
    });

    it("explains a connection that cannot be made", async () => {
      await server.close();
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(/Could not reach 127\.0\.0\.1.*internet connection/);
      server = await startFixtureServer();
    });

    it("times out a server that never answers", async () => {
      server.routes.set(route(), { hang: true });
      await expect(extractExample(source(), await staging(), { archiveBase: server.base, limits: { timeoutMs: 150 } })).rejects.toThrow(/timed out/);
    });

    it("times out a download that stalls halfway", async () => {
      const body = githubArchive({ "package.json": "{}", "big.bin": "x".repeat(50_000) });
      server.routes.set(route(), { body, truncateAfter: 30, headers: { "content-length": String(body.length) } });
      await expect(extractExample(source(), await staging(), { archiveBase: server.base, limits: { timeoutMs: 400 } })).rejects.toThrow(ExampleError);
    });

    it("reports a connection that drops mid-download", async () => {
      server.routes.set(route(), { reset: true });
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(ExampleError);
    });

    it("reports a response that is not a tar.gz", async () => {
      serve(Buffer.from("<html>not an archive</html>"));
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(/could not be read|contains no files|does not exist|empty/);
    });

    it("reports a gzip stream cut short", async () => {
      const full = githubArchive({ "package.json": "{}", "a.txt": "x".repeat(10_000) });
      serve(full.subarray(0, Math.floor(full.length / 2)));
      await expect(extractExample(source(), await staging(), { archiveBase: server.base })).rejects.toThrow(ExampleError);
    });

    it("reports a folder that is not in the archive", async () => {
      serve(githubArchive({ "package.json": "{}" }));
      await expect(extractExample(source("missing"), await staging(), { archiveBase: server.base })).rejects.toThrow(/folder "missing" does not exist in o\/r at "main"/);
    });

    it("reports a chosen folder that is a file", async () => {
      serve(githubArchive({ "notes": "x" }));
      await expect(extractExample(source("notes"), await staging(), { archiveBase: server.base })).rejects.toThrow(/is a file, not a folder|does not exist|contains no files/);
    });

    it("reports an empty folder", async () => {
      serve(tarGz([{ path: "r-main", type: "dir" }, { path: "r-main/app", type: "dir" }]));
      await expect(extractExample(source("app"), await staging(), { archiveBase: server.base })).rejects.toThrow(/contains no files/);
    });

    it("reports an empty archive", async () => {
      serve(gzipSync(Buffer.alloc(1024)));
      await expect(extractExample(source(""), await staging(), { archiveBase: server.base })).rejects.toThrow(/empty/);
    });

    it("refuses a redirect to another host when talking to GitHub", async () => {
      const fake = {
        ok: true,
        status: 200,
        url: "https://evil.test/o/r.tar.gz",
        body: new Response("x").body,
      } as unknown as Response;
      await expect(extractExample(source(), await staging(), { fetchImpl: async () => fake })).rejects.toThrow(/redirected to an unexpected host \(evil\.test\)/);
    });
  });
});

describe("destination", () => {
  it("accepts a missing path and an empty folder", async () => {
    await assertDestinationFree(join(work, "new"));
    await mkdir(join(work, "empty"));
    await assertDestinationFree(join(work, "empty"));
  });

  it("refuses a folder with files, and a file", async () => {
    await mkdir(join(work, "full"));
    await writeFile(join(work, "full", "keep.txt"), "mine");
    await expect(assertDestinationFree(join(work, "full"))).rejects.toThrow(/not empty/);
    await writeFile(join(work, "file"), "x");
    await expect(assertDestinationFree(join(work, "file"))).rejects.toThrow(/not a folder/);
  });
});

describe("manifest and template info", () => {
  it("requires a package.json that is a JSON object", async () => {
    const dir = await staging();
    await expect(readProjectManifest(dir)).rejects.toThrow(/no package.json/);
    await writeFile(join(dir, "package.json"), "{ nope");
    await expect(readProjectManifest(dir)).rejects.toThrow(/not a valid JSON object/);
    await writeFile(join(dir, "package.json"), "[]");
    await expect(readProjectManifest(dir)).rejects.toThrow(/not a valid JSON object/);
    await writeFile(join(dir, "package.json"), '{"name":"x"}');
    expect(await readProjectManifest(dir)).toEqual({ name: "x" });
  });

  it("reads license, requirements, and a minimum Node version from template.json", async () => {
    const dir = await staging();
    await writeFile(join(dir, "template.json"), JSON.stringify({ license: "MIT", requirements: ["a", 3, "b"], requires: { node: ">=24.0.0", bascik: "^1.0.0" } }));
    expect(await readTemplateInfo(dir)).toEqual({ license: "MIT", requirements: ["a", "b"], minNode: "24.0.0", bascikRange: "^1.0.0" });
  });

  it("works without template.json, ignores odd fields, and rejects broken JSON", async () => {
    const dir = await staging();
    expect(await readTemplateInfo(dir)).toEqual({ requirements: [] });
    await writeFile(join(dir, "template.json"), JSON.stringify({ license: 5, requires: { node: "^24", bascik: 1 }, requirements: "x" }));
    expect(await readTemplateInfo(dir)).toEqual({ requirements: [] });
    await writeFile(join(dir, "template.json"), "{");
    await expect(readTemplateInfo(dir)).rejects.toThrow(/not valid JSON/);
  });

  it.each([
    ["v24.0.0", "24.0.0", true],
    ["v24.1.0", "24.0.0", true],
    ["v25.0.0", "24.9.9", true],
    ["v22.18.0", "24.0.0", false],
    ["v24.0.0", "24.0.1", false],
    ["v24.0.0", "24", true],
    ["v24.0.0", "24.1", false],
  ])("nodeSatisfies(%s, %s) is %s", (version, minimum, expected) => {
    expect(nodeSatisfies(version, minimum)).toBe(expected);
  });
});

describe("installExample", () => {
  const files = { "package.json": JSON.stringify({ name: "original", version: "1.0.0" }), "src/pages/index.html": "<h1>hi</h1>", "template.json": JSON.stringify({ license: "MIT", requires: { node: ">=20.0.0" } }) };
  const leftovers = async () => (await readdir(work)).filter((name) => name.startsWith(".create-bascik-"));

  it("installs into a new folder, renames the package, and leaves no staging directory", async () => {
    serve(githubArchive(files));
    const destination = join(work, "my-app");
    const result = await installExample(source(""), destination, "my-app", { archiveBase: server.base });
    expect(result.files).toBe(3);
    expect(result.info.license).toBe("MIT");
    expect(JSON.parse(await readFile(join(destination, "package.json"), "utf8"))).toEqual({ name: "my-app", version: "1.0.0" });
    expect(await readFile(join(destination, "src/pages/index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect(await leftovers()).toEqual([]);
  });

  it("does not add a name to a package.json that had none", async () => {
    serve(githubArchive({ "package.json": '{"private":true}' }));
    await installExample(source(""), join(work, "x"), "x", { archiveBase: server.base });
    expect(await readFile(join(work, "x/package.json"), "utf8")).toBe('{"private":true}');
  });

  it("installs into an existing empty folder", async () => {
    serve(githubArchive(files));
    await mkdir(join(work, "empty"));
    await installExample(source(""), join(work, "empty"), "empty", { archiveBase: server.base });
    expect(await readFile(join(work, "empty/src/pages/index.html"), "utf8")).toBe("<h1>hi</h1>");
  });

  it("refuses a non-empty destination before any request, and keeps the user's files", async () => {
    await mkdir(join(work, "mine"));
    await writeFile(join(work, "mine", "notes.txt"), "keep me");
    await expect(installExample(source(""), join(work, "mine"), "mine", { archiveBase: server.base })).rejects.toThrow(/not empty/);
    expect(server.requests).toEqual([]);
    expect(await readFile(join(work, "mine", "notes.txt"), "utf8")).toBe("keep me");
    expect(await leftovers()).toEqual([]);
  });

  it("creates nothing at the destination when the download fails", async () => {
    await expect(installExample(source(""), join(work, "never"), "never", { archiveBase: server.base })).rejects.toThrow(/no archive/);
    await expect(lstat(join(work, "never"))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("removes staging and creates nothing when the folder is not a project", async () => {
    serve(githubArchive({ "README.md": "x" }));
    await expect(installExample(source(""), join(work, "never"), "never", { archiveBase: server.base })).rejects.toThrow(/no package.json/);
    await expect(lstat(join(work, "never"))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("removes staging when the archive is malicious, and does not touch an existing empty destination", async () => {
    serve(tarGz([{ path: "r-main", type: "dir" }, { path: "r-main/package.json", type: "file", content: "{}" }, { path: "r-main/l", type: "symlink", target: "/etc" }]));
    await mkdir(join(work, "empty"));
    await expect(installExample(source(""), join(work, "empty"), "empty", { archiveBase: server.base })).rejects.toThrow(/symbolic link/);
    expect(await readdir(join(work, "empty"))).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it("refuses an example that needs a newer Node, naming both versions", async () => {
    serve(githubArchive({ ...files, "template.json": JSON.stringify({ requires: { node: ">=99.0.0" } }) }));
    await expect(installExample(source(""), join(work, "x"), "x", { archiveBase: server.base, nodeVersion: "v24.1.0" })).rejects.toThrow(/needs Node 99\.0\.0 or later, and you are running v24\.1\.0/);
    await expect(lstat(join(work, "x"))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it("notices a destination that was filled while the download ran", async () => {
    serve(githubArchive(files));
    const destination = join(work, "race");
    const pending = installExample(source(""), destination, "race", {
      archiveBase: server.base,
      onStaging: () => {
        void mkdir(destination).then(() => writeFile(join(destination, "late.txt"), "user data"));
      },
    });
    await expect(pending).rejects.toThrow(/not empty/);
    expect(await readFile(join(destination, "late.txt"), "utf8")).toBe("user data");
    expect(await leftovers()).toEqual([]);
  });
});
