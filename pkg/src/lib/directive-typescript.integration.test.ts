/**
 * TypeScript in directive scripts and in a page's own `<script src="*.ts">`.
 *
 * A build, routes, server or stream script is TypeScript when its `src=`
 * names a `.ts` / `.mts` file or its tag is marked `type="text/typescript"`.
 * Bascik strips its types (or runs `scripts.typescript`) before running it,
 * and a stack trace still names the TypeScript source's own line. A page's
 * `<script src="name.ts">` is compiled and inlined, as a component's `.ts`
 * companion is. These tests run the REAL CLI from source against temp
 * projects, on the build and on the dev and production servers.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Source entrypoint. Node 24 runs .ts directly, and pkg/dist is gitignored.
const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

const page = (title: string, body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <main>\n${body}\n  </main>\n</body>\n</html>\n`;

type Files = Record<string, string>;

const writeProject = async (files: Files): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-directive-ts-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  BASCIK_BUILD: "0",
  BASCIK_SERVER: "0",
  VITEST: "",
  ...extra,
});

const runBuild = (
  root: string,
): Promise<{ code: number | null; output: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [PKG_ENTRY, "--build", "--site-url", "https://example.com"],
      { cwd: root, env: childEnv({}), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });

/** 1-based line of the first line of `text` that contains `needle`. */
const lineOf = (text: string, needle: string): number =>
  text.split("\n").findIndex((line) => line.includes(needle)) + 1;

const BUILD_TS = `interface Greeting {\n  text: string;\n}\nconst greeting: Greeting = { text: "from build.ts" };\nexport default (): string => \`<p data-testid="build-src">\${greeting.text}</p>\`;\n`;
const ROUTES_TS = `type Route = { params: { slug: string } };\nconst routes: Route[] = [{ params: { slug: "first" } }];\nexport default (): Route[] => routes;\n`;
const SERVER_TS = `export default (request: Request): string => {\n  const path: string = new URL(request.url).pathname;\n  return \`<p data-testid="server-src">server.ts \${path}</p>\`;\n};\n`;
const STREAM_TS = `export default async (): Promise<string> => \`<p data-testid="stream-src">stream.ts</p>\`;\n`;
const PAGE_SCRIPT_TS = `const target: HTMLElement | null = document.querySelector("main");\nif (target) target.dataset.ts = "ran" as string;\n`;

const BUILD_PAGE = page(
  "Build",
  [
    `    <script data-bascik-build src="./build.ts"></script>`,
    `    <script data-bascik-build type="text/typescript">`,
    `      const count: number = 41;`,
    `      export default (): string => \`<p data-testid="build-inline">\${count + 1}</p>\`;`,
    `    </script>`,
    `    <script src="./page-script.ts"></script>`,
  ].join("\n"),
);
const ROUTES_PAGE = page(
  "Post",
  `    <script data-bascik-routes src="./routes.ts"></script>\n    <p data-testid="post">post</p>`,
);
const INLINE_ROUTES_PAGE = page(
  "Doc",
  [
    `    <script data-bascik-routes type="text/typescript">`,
    `      const slugs: string[] = ["one"];`,
    `      export default () => slugs.map((slug: string) => ({ params: { slug } }));`,
    `    </script>`,
    `    <p data-testid="doc">doc</p>`,
  ].join("\n"),
);
const THROWING_PAGE = page(
  "Throws",
  [
    `    <script data-bascik-build type="text/typescript">`,
    `      type Unused = { a: string };`,
    `      const label: string = "typed";`,
    `      export default (): string => {`,
    `        throw new Error("typed build failure " + label);`,
    `      };`,
    `    </script>`,
  ].join("\n"),
);
const THROWING_TS = `type Shape = { side: number };\nconst square: Shape = { side: 2 };\n\nexport default (): string => {\n  throw new Error("typed src failure " + square.side);\n};\n`;

describe("TypeScript build and routes scripts, and a page's .ts script (real `bascik --build`)", () => {
  let root: string;
  let code: number | null;
  let output: string;

  beforeAll(async () => {
    root = await writeProject({
      "bascik.config.ts": `export default { scripts: { onBuildScriptError: "warn" } };\n`,
      "src/pages/index.html": BUILD_PAGE,
      "src/pages/build.ts": BUILD_TS,
      "src/pages/page-script.ts": PAGE_SCRIPT_TS,
      "src/pages/posts/[slug].html": ROUTES_PAGE,
      "src/pages/posts/routes.ts": ROUTES_TS,
      "src/pages/docs/[slug].html": INLINE_ROUTES_PAGE,
      "src/pages/throws.html": THROWING_PAGE,
      "src/pages/throws-src.html": page(
        "Throws src",
        `    <script data-bascik-build src="../lib/throws.ts"></script>`,
      ),
      "src/lib/throws.ts": THROWING_TS,
    });
    ({ code, output } = await runBuild(root));
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds", () => {
    expect(output).not.toMatch(/SyntaxError/);
    expect(code, output).toBe(0);
  });

  it("strips the types of a build script's .ts src and of a marked inline block", async () => {
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain(`<p data-testid="build-src">from build.ts</p>`);
    expect(html).toContain(`<p data-testid="build-inline">42</p>`);
  });

  it("runs a routes script from a .ts src and from a marked inline block", async () => {
    await expect(
      readFile(join(root, "dist/posts/first.html"), "utf8"),
    ).resolves.toContain(`data-testid="post"`);
    await expect(
      readFile(join(root, "dist/docs/one.html"), "utf8"),
    ).resolves.toContain(`data-testid="doc"`);
  });

  it("compiles a page's own <script src> .ts file and inlines it, never shipping TypeScript", async () => {
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).not.toContain('page-script.ts"');
    expect(html).not.toMatch(/HTMLElement \| null|as string/);
    expect(html).toContain(`document.querySelector("main")`);
  });

  it("names the page's own line when a marked inline build script throws", () => {
    const expected = `src/pages/throws.html:${lineOf(THROWING_PAGE, "typed build failure")}:`;
    expect(output).toContain("typed build failure typed");
    expect(output).toContain(expected);
  });

  it("names the .ts file's own line when a build script's src throws", () => {
    expect(output).toContain("typed src failure 2");
    expect(output).toContain(
      `src/lib/throws.ts:${lineOf(THROWING_TS, "typed src failure")}:`,
    );
  });
});

describe("TypeScript the strip cannot handle, and a page .ts script that cannot be inlined as written", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const build = async (files: Files) => {
    const root = await writeProject(files);
    roots.push(root);
    return runBuild(root);
  };

  it("fails a marked inline build script with an enum, naming the file and the enum's own line", async () => {
    const source = page(
      "Enum",
      `    <p>above</p>\n    <script data-bascik-build type="text/typescript">\n      enum Size { Small }\n      export default () => String(Size.Small);\n    </script>`,
    );
    const { code, output } = await build({ "src/pages/index.html": source });
    expect(code).not.toBe(0);
    expect(output).toContain("TypeScript enum is not supported");
    expect(output).toContain("scripts.typescript");
    expect(output).toContain(
      `src/pages/index.html:${lineOf(source, "enum Size")}:7`,
    );
  }, 60_000);

  it("compiles with scripts.typescript when it is a function, telling it the script runs on the server", async () => {
    const { code, output } = await build({
      "bascik.config.ts": [
        `export default {`,
        `  scripts: {`,
        `    typescript: (code: string, context: { runtime: string; kind: string }) =>`,
        `      code.replace("enum Size { Small }", "const Size = { Small: 0 };") +`,
        `      "\\nconsole.log('compiled for ' + " + JSON.stringify(context.runtime + '/' + context.kind) + ");",`,
        `  },`,
        `};`,
      ].join("\n"),
      "src/pages/index.html": page(
        "Enum",
        `    <script data-bascik-build type="text/typescript">\n      enum Size { Small }\n      export default () => "<p>" + Size.Small + "</p>";\n    </script>`,
      ),
    });
    expect(code, output).toBe(0);
    expect(output).toContain("compiled for server/inline");
  }, 60_000);

  it.each(["defer", "async"])(
    "refuses a classic page .ts script with %s, naming the tag's line and what to do",
    async (attribute) => {
      const source = page(
        "Timing",
        `    <p>above</p>\n    <script ${attribute} src="./app.ts"></script>`,
      );
      const { code, output } = await build({
        "src/pages/index.html": source,
        "src/pages/app.ts": PAGE_SCRIPT_TS,
      });
      expect(code).not.toBe(0);
      expect(output).toContain(
        `src/pages/index.html:${lineOf(source, "app.ts")}:5`,
      );
      expect(output).toContain(`type="module"`);
    },
    60_000,
  );

  it("inlines a type=module page .ts script with defer as a module", async () => {
    const root = await writeProject({
      "src/pages/index.html": page(
        "Module",
        `    <script type="module" defer src="./app.ts"></script>`,
      ),
      "src/pages/app.ts": `export const x: number = 1;\nconsole.log(x);\n`,
    });
    roots.push(root);
    const { code, output } = await runBuild(root);
    expect(code, output).toBe(0);
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toMatch(/<script type="module" defer>/);
    expect(html).not.toContain('app.ts"');
  }, 60_000);

  it("names a missing page .ts script and the tag that references it", async () => {
    const source = page("Missing", `    <script src="./missing.ts"></script>`);
    const { code, output } = await build({ "src/pages/index.html": source });
    expect(code).not.toBe(0);
    expect(output).toContain(`"src/pages/missing.ts" could not be read`);
    expect(output).toContain(
      `src/pages/index.html:${lineOf(source, "missing.ts")}:5`,
    );
  }, 60_000);

  it("leaves a remote .ts URL and a page .ts script alone under scripts.typescript: false", async () => {
    const root = await writeProject({
      "bascik.config.ts": `export default { scripts: { typescript: false } };\n`,
      "src/pages/index.html": page(
        "Off",
        `    <script src="./app.ts"></script>\n    <script src="https://cdn.example.com/x.ts"></script>`,
      ),
      "src/pages/app.ts": PAGE_SCRIPT_TS,
    });
    roots.push(root);
    const { code, output } = await runBuild(root);
    expect(code, output).toBe(0);
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain(`src="./app.ts"`);
    expect(html).toContain(`src="https://cdn.example.com/x.ts"`);
  }, 60_000);
});

const SERVER_PAGE = page(
  "Dynamic",
  [
    `    <script data-bascik-server src="./server.ts"></script>`,
    `    <script data-bascik-server type="text/typescript">`,
    `      export default (request: Request): string => {`,
    `        const method: string = request.method;`,
    `        return \`<p data-testid="server-inline">\${method}</p>\`;`,
    `      };`,
    `    </script>`,
    `    <script data-bascik-stream src="./stream.ts"></script>`,
    `    <script data-bascik-stream type="text/typescript">`,
    `      export default async (): Promise<string> => '<p data-testid="stream-inline">streamed</p>';`,
    `    </script>`,
  ].join("\n"),
);
const THROWING_SERVER_PAGE = page(
  "Throws",
  [
    `    <script data-bascik-server type="text/typescript">`,
    `      type Unused = { a: string };`,
    `      export default (request: Request): string => {`,
    `        throw new Error("typed server failure");`,
    `      };`,
    `    </script>`,
  ].join("\n"),
);

describe.each([
  { mode: "dev server", args: [] as string[], build: false, offset: 0 },
  {
    mode: "production server (`bascik --server`)",
    args: ["--server"],
    build: true,
    offset: 100,
  },
])(
  "TypeScript server and stream scripts (real $mode)",
  ({ args, build, offset }) => {
    let root: string;
    let child: ChildProcess;
    let output = "";
    let base: string;

    const waitFor = (pattern: RegExp, timeoutMs = 30_000): Promise<void> =>
      new Promise((resolveWait, reject) => {
        const started = Date.now();
        const check = (): void => {
          if (pattern.test(output)) return resolveWait();
          if (Date.now() - started > timeoutMs)
            return reject(
              new Error(`${pattern} not printed. Output:\n${output}`),
            );
          setTimeout(check, 50);
        };
        check();
      });

    beforeAll(async () => {
      root = await writeProject({
        "src/pages/index.html": SERVER_PAGE,
        "src/pages/server.ts": SERVER_TS,
        "src/pages/stream.ts": STREAM_TS,
        "src/pages/throws.html": THROWING_SERVER_PAGE,
      });
      if (build) {
        const result = await runBuild(root);
        if (result.code !== 0)
          throw new Error(`build exited ${result.code}:\n${result.output}`);
      }
      // 19500-19699: clear of the other suites' ranges and the bad-ports list.
      const port = 19500 + (process.pid % 100) + offset;
      base = `http://localhost:${port}`;
      child = spawn(process.execPath, [PKG_ENTRY, ...args], {
        cwd: root,
        env: childEnv({
          BASCIK_SERVER_PORT: String(port),
          BASCIK_ENABLE_TLS: "false",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (data: Buffer) => (output += data.toString()));
      child.stderr?.on("data", (data: Buffer) => (output += data.toString()));
      await waitFor(/Server running at/);
    }, 120_000);

    afterAll(async () => {
      if (child && child.exitCode === null) {
        await new Promise<void>((done) => {
          child.once("close", () => done());
          child.kill("SIGINT");
        });
      }
      await rm(root, { recursive: true, force: true });
    });

    it("runs .ts src modules and marked inline blocks", async () => {
      const response = await fetch(`${base}/`);
      const html = await response.text();
      expect(response.status, html).toBe(200);
      expect(html).toContain(`<p data-testid="server-src">server.ts /</p>`);
      expect(html).toContain(`<p data-testid="server-inline">GET</p>`);
      expect(html).toContain(`<p data-testid="stream-src">stream.ts</p>`);
      expect(html).toContain(`<p data-testid="stream-inline">streamed</p>`);
    });

    it("names the page's own line when a marked inline server script throws", async () => {
      const response = await fetch(`${base}/throws`);
      expect(response.status).toBe(500);
      await response.text();
      await waitFor(/typed server failure/);
      expect(output).toContain(
        `src/pages/throws.html:${lineOf(THROWING_SERVER_PAGE, "typed server failure")}:`,
      );
    });
  },
);

describe("Where a TypeScript mistake is, and the build failing for it (real `bascik --build`)", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  const build = async (files: Files) => {
    const root = await writeProject(files);
    roots.push(root);
    return runBuild(root);
  };

  it("names the line and column of a syntax error in a build script's .ts src, without the enum hint", async () => {
    const source = [
      `const items: string[] = [];`,
      `const bad = 1;`,
      ``,
      "export default (): string => `<p>${bad} ${items.length) }</p>`;",
      ``,
    ].join("\n");
    const { code, output } = await build({
      "src/pages/index.html": page(
        "Build",
        `    <script data-bascik-build src="@/lib/build.ts"></script>`,
      ),
      "src/lib/build.ts": source,
    });
    expect(code).not.toBe(0);
    expect(output).toMatch(/src\/lib\/build\.ts:4:\d+/);
    expect(output).toContain("4 | export default (): string =>");
    expect(output).not.toContain("enum");
  }, 60_000);

  it("names the page line of a syntax error in a marked inline build script", async () => {
    const source = page(
      "Inline",
      [
        `    <script data-bascik-build type="text/typescript">`,
        `      const label: string = "x";`,
        `      const oops = (;`,
        `      export default () => label;`,
        `    </script>`,
      ].join("\n"),
    );
    const { code, output } = await build({ "src/pages/index.html": source });
    expect(code).not.toBe(0);
    expect(output).toContain(
      `src/pages/index.html:${lineOf(source, "const oops")}:21`,
    );
    expect(output).not.toContain("enum");
  }, 60_000);

  it("fails the build for an enum in a server script's .ts src, naming the file, the line and scripts.typescript", async () => {
    const { code, output } = await build({
      "src/pages/index.html": page(
        "Server",
        `    <script data-bascik-server src="../lib/server.ts"></script>`,
      ),
      "src/lib/server.ts": `const label: string = "x";\nenum Color { Red }\nexport default (): string => label + Color.Red;\n`,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("src/lib/server.ts:2:1");
    expect(output).toContain("scripts.typescript");
  }, 60_000);

  it.each(["server", "stream"])(
    "fails the build for an enum in a marked inline %s script, naming the page line",
    async (kind) => {
      const source = page(
        "Inline server",
        [
          `    <p>above</p>`,
          `    <script data-bascik-${kind} type="text/typescript">`,
          `      enum Mode { A, B }`,
          `      export default (): string => String(Mode.A);`,
          `    </script>`,
        ].join("\n"),
      );
      const { code, output } = await build({ "src/pages/index.html": source });
      expect(code).not.toBe(0);
      expect(output).toContain(
        `src/pages/index.html:${lineOf(source, "enum Mode")}:7`,
      );
      expect(output).toContain("scripts.typescript");
    },
    60_000,
  );

  it("fails the build for a syntax error in a marked inline server script, naming the page line", async () => {
    const source = page(
      "Inline server",
      [
        `    <script data-bascik-server type="text/typescript">`,
        `      const n: number = 1;`,
        `      const oops = (;`,
        `      export default (): string => String(n);`,
        `    </script>`,
      ].join("\n"),
    );
    const { code, output } = await build({ "src/pages/index.html": source });
    expect(code).not.toBe(0);
    expect(output).toContain(
      `src/pages/index.html:${lineOf(source, "const oops")}:21`,
    );
  }, 60_000);

  it("fails a page module .ts that imports another file, naming the tag, the import and esbuild", async () => {
    const source = page(
      "Module",
      `    <p>above</p>\n    <script type="module" src="./mod.ts"></script>`,
    );
    const { code, output } = await build({
      "src/pages/index.html": source,
      "src/pages/mod.ts": `import { shout } from "./util.ts";\nconst text: string = shout("hi");\nconsole.log(text);\n`,
      "src/pages/util.ts": `export const shout = (s: string): string => s.toUpperCase();\n`,
    });
    expect(code).not.toBe(0);
    expect(output).toContain(
      `src/pages/index.html:${lineOf(source, "mod.ts")}:5`,
    );
    expect(output).toContain(`"./util.ts"`);
    expect(output).toContain("esbuild");
  }, 60_000);

  it("fails a component's .ts module companion that imports another file, naming the file and the import", async () => {
    const { code, output } = await build({
      "src/pages/index.html": page("Comp", `    <x-box></x-box>`),
      "src/components/x-box/x-box.html": `<div data-testid="x-box">box</div>\n<script type="module" src="x-box.ts"></script>\n`,
      "src/components/x-box/x-box.ts": `import { shout } from "./util.ts";\nconsole.log(shout("box" as string));\n`,
      "src/components/x-box/util.ts": `export const shout = (s: string): string => s.toUpperCase();\n`,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("src/components/x-box/x-box.ts");
    expect(output).toContain(`"./util.ts"`);
    expect(output).toContain("esbuild");
  }, 60_000);

  it("builds a page module .ts that imports only a published URL", async () => {
    const { code, output } = await build({
      "src/pages/index.html": page(
        "Module",
        `    <script type="module" src="./mod.ts"></script>`,
      ),
      "src/pages/mod.ts": `import { shout } from "/js/util.js";\nconsole.log(shout("hi" as string));\n`,
      "src/pages/js/util.js": `export const shout = (s) => s.toUpperCase();\n`,
    });
    expect(code, output).toBe(0);
  }, 60_000);
});

describe("Editing a page's own .ts script in dev (real dev server)", () => {
  let root: string;
  let child: ChildProcess;
  let output = "";
  let base: string;

  beforeAll(async () => {
    root = await writeProject({
      "src/pages/index.html": page(
        "Client",
        `    <script src="./client.ts"></script>`,
      ),
      "src/pages/client.ts": `const label: string = "page-ts-v1";\ndocument.title = label;\n`,
    });
    const port = 19700 + (process.pid % 100);
    base = `http://localhost:${port}`;
    child = spawn(process.execPath, [PKG_ENTRY], {
      cwd: root,
      env: childEnv({
        BASCIK_SERVER_PORT: String(port),
        BASCIK_ENABLE_TLS: "false",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr?.on("data", (data: Buffer) => (output += data.toString()));
    const started = Date.now();
    while (!/Server running at/.test(output)) {
      if (Date.now() - started > 60_000)
        throw new Error(`dev server did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 120_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      await new Promise<void>((done) => {
        child.once("close", () => done());
        child.kill("SIGINT");
      });
    }
    await rm(root, { recursive: true, force: true });
  });

  it("rebuilds the page when the .ts file changes", async () => {
    await expect((await fetch(`${base}/`)).text()).resolves.toContain(
      "page-ts-v1",
    );
    const transpiles = (output.match(/transpiled: /g) ?? []).length;
    await writeFile(
      join(root, "src/pages/client.ts"),
      `const label: string = "page-ts-v2";\ndocument.title = label;\n`,
    );
    const started = Date.now();
    let html = "";
    while (Date.now() - started < 20_000) {
      html = await (await fetch(`${base}/`)).text();
      if (html.includes("page-ts-v2")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(html, output).toContain("page-ts-v2");
    expect((output.match(/transpiled: /g) ?? []).length).toBeGreaterThan(
      transpiles,
    );
  }, 60_000);
});
