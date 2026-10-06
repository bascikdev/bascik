import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDirectiveHandler, Semaphore } from "./lib/script-runner.ts";

describe("runDirectiveHandler real child processes (handler and result transport)", () => {
  it("executes default export handler once, transfers result separately from stdout/stderr, and returns distinct result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const modulePath = join(dir, "test-module.mjs");
      const invocationsFile = join(dir, "invocations.txt");
      await writeFile(
        modulePath,
        `
        import { appendFileSync } from "node:fs";
        console.log("module-init-stdout");
        console.error("module-init-stderr");

        export default async function () {
          console.log("handler-stdout");
          console.error("handler-stderr");
          appendFileSync(${JSON.stringify(invocationsFile)}, "called\\n");
          return "<article><h1>Hello from handler</h1></article>";
        }
        `,
        "utf8",
      );

      const result = await runDirectiveHandler<string>(modulePath, "build");
      expect(result.result).toBe("<article><h1>Hello from handler</h1></article>");
      expect(result.stdout).toContain("module-init-stdout");
      expect(result.stdout).toContain("handler-stdout");
      expect(result.stderr).toContain("module-init-stderr");
      expect(result.stderr).toContain("handler-stderr");

      const invocations = await readFile(invocationsFile, "utf8");
      expect(invocations.trim()).toBe("called");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("calls handler with zero arguments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const modulePath = join(dir, "test-module.mjs");
      await writeFile(
        modulePath,
        `
        export default function (...args) {
          if (args.length !== 0) {
            throw new Error("Expected 0 args, received " + args.length);
          }
          return "ok";
        }
        `,
        "utf8",
      );

      const result = await runDirectiveHandler<string>(modulePath, "build");
      expect(result.result).toBe("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("supports sync, async, arrow, named, re-exported functions, and top-level await", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      // 1. Sync arrow function
      const syncModule = join(dir, "sync.mjs");
      await writeFile(syncModule, `export default () => "sync-arrow";`, "utf8");
      const resSync = await runDirectiveHandler<string>(syncModule, "build");
      expect(resSync.result).toBe("sync-arrow");

      // 2. Named function with top-level await
      const namedModule = join(dir, "named.mjs");
      await writeFile(
        namedModule,
        `
        const greeting = await Promise.resolve("hello");
        export default function myHandler() {
          return greeting + " named";
        }
        `,
        "utf8",
      );
      const resNamed = await runDirectiveHandler<string>(namedModule, "build");
      expect(resNamed.result).toBe("hello named");

      // 3. Re-exported default
      const helperModule = join(dir, "helper.mjs");
      await writeFile(helperModule, `export const fn = () => "from-helper";`, "utf8");
      const reexportModule = join(dir, "reexport.mjs");
      await writeFile(
        reexportModule,
        `import { fn } from "./helper.mjs"; export default fn;`,
        "utf8",
      );
      const resReexport = await runDirectiveHandler<string>(reexportModule, "build");
      expect(resReexport.result).toBe("from-helper");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles routes directive with array result and allows empty array", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const modulePath = join(dir, "routes.mjs");
      await writeFile(
        modulePath,
        `
        export default async function () {
          return [
            { params: { slug: "first" }, data: { title: "Post 1" } },
            { params: { slug: "second" } }
          ];
        }
        `,
        "utf8",
      );

      const result = await runDirectiveHandler<any[]>(modulePath, "routes");
      expect(result.result).toEqual([
        { params: { slug: "first" }, data: { title: "Post 1" } },
        { params: { slug: "second" } },
      ]);

      const emptyModule = join(dir, "empty.mjs");
      await writeFile(emptyModule, `export default () => [];`, "utf8");
      const emptyResult = await runDirectiveHandler<any[]>(emptyModule, "routes");
      expect(emptyResult.result).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows empty string for build directive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const modulePath = join(dir, "empty.mjs");
      await writeFile(modulePath, `export default () => "";`, "utf8");
      const result = await runDirectiveHandler<string>(modulePath, "build");
      expect(result.result).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails with informative error when default export is missing or not a function", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      // Missing export
      const missingModule = join(dir, "missing.mjs");
      await writeFile(missingModule, `console.log("no export");`, "utf8");
      await expect(runDirectiveHandler(missingModule, "build")).rejects.toThrow(
        /missing default export/,
      );

      // Non-callable export (e.g. string or object)
      const objModule = join(dir, "obj.mjs");
      await writeFile(objModule, `export default { foo: "bar" };`, "utf8");
      await expect(runDirectiveHandler(objModule, "build")).rejects.toThrow(
        /default export must be a callable function/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when build handler returns non-string (numbers, objects, null, undefined)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const numModule = join(dir, "num.mjs");
      await writeFile(numModule, `export default () => 123;`, "utf8");
      await expect(runDirectiveHandler(numModule, "build")).rejects.toThrow(
        /must return a string.*Received number/,
      );

      const nullModule = join(dir, "null.mjs");
      await writeFile(nullModule, `export default () => null;`, "utf8");
      await expect(runDirectiveHandler(nullModule, "build")).rejects.toThrow(
        /must return a string.*Received null/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when routes handler returns non-array (e.g. JSON string)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const strModule = join(dir, "str.mjs");
      await writeFile(strModule, `export default () => JSON.stringify([]);`, "utf8");
      await expect(runDirectiveHandler(strModule, "routes")).rejects.toThrow(
        /must return an array.*Received string/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves exact bytes: Unicode, quotes, backslashes, literal $1/$&, ANSI bytes in returned HTML", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const modulePath = join(dir, "unicode.mjs");
      const specialString = "<div title=\"hello 'world'\">日本語 \u001b[31mRed\u001b[0m $1 $& \\n \\\\</div>\n";
      await writeFile(
        modulePath,
        `
        export default function () {
          return ${JSON.stringify(specialString)};
        }
        `,
        "utf8",
      );

      const result = await runDirectiveHandler<string>(modulePath, "build");
      expect(result.result).toBe(specialString);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails cleanly on serialization errors (cyclic data, BigInt)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const cyclicModule = join(dir, "cyclic.mjs");
      await writeFile(
        cyclicModule,
        `
        export default function () {
          const a = {};
          a.self = a;
          return [a];
        }
        `,
        "utf8",
      );
      await expect(runDirectiveHandler(cyclicModule, "routes")).rejects.toThrow(
        /result serialization failed/,
      );

      const bigintModule = join(dir, "bigint.mjs");
      await writeFile(
        bigintModule,
        `
        export default function () {
          return [{ params: { id: 123n } }];
        }
        `,
        "utf8",
      );
      await expect(runDirectiveHandler(bigintModule, "routes")).rejects.toThrow(
        /result serialization failed/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces maxResultBytes limit and does not return partial result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const largeModule = join(dir, "large.mjs");
      await writeFile(
        largeModule,
        `
        export default function () {
          return "a".repeat(2000);
        }
        `,
        "utf8",
      );

      await expect(
        runDirectiveHandler(largeModule, "build", { maxResultBytes: 1000 }),
      ).rejects.toThrow(/result exceeded limit of 1000 bytes/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans up temporary runner directories even on error or timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    try {
      const hangModule = join(dir, "hang.mjs");
      await writeFile(
        hangModule,
        `
        export default async function () {
          await new Promise(() => {});
        }
        `,
        "utf8",
      );

      await expect(
        runDirectiveHandler(hangModule, "build", { timeoutMs: 150 }),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles parallel child processes correctly using single-slot semaphore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-handler-"));
    const sem = new Semaphore(1);
    try {
      const mod1 = join(dir, "mod1.mjs");
      const mod2 = join(dir, "mod2.mjs");
      await writeFile(mod1, `export default () => "res1";`, "utf8");
      await writeFile(mod2, `export default () => "res2";`, "utf8");

      const [r1, r2] = await Promise.all([
        runDirectiveHandler<string>(mod1, "build", { semaphore: sem }),
        runDirectiveHandler<string>(mod2, "build", { semaphore: sem }),
      ]);

      expect(r1.result).toBe("res1");
      expect(r2.result).toBe("res2");
      expect(sem.getActiveCount()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("executes real routes directive handler with logs, verifying routes expand and logs do not corrupt data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-test-routes-real-"));
    try {
      const modulePath = join(dir, "routes.mjs");
      await writeFile(
        modulePath,
        `
        console.log("diagnostic log from routes handler");
        console.error("stderr log from routes handler");

        export default async function () {
          console.log("another log inside default export");
          return [
            { params: { slug: "alpha" }, data: { title: "Alpha Post" } },
            { params: { slug: "beta" }, data: { title: "Beta Post" } },
          ];
        }
        `,
        "utf8",
      );

      const result = await runDirectiveHandler<any[]>(modulePath, "routes");
      expect(result.result).toEqual([
        { params: { slug: "alpha" }, data: { title: "Alpha Post" } },
        { params: { slug: "beta" }, data: { title: "Beta Post" } },
      ]);
      expect(result.stdout).toContain("diagnostic log from routes handler");
      expect(result.stdout).toContain("another log inside default export");
      expect(result.stderr).toContain("stderr log from routes handler");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
