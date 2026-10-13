/**
 * Script errors name the line and column in the file the script was written in.
 *
 * Each directive script runs as a module of its own, in a child process (build
 * and routes scripts) or in-process (server and stream scripts), so V8 numbers
 * its lines from 1. These tests run the REAL CLI from source against a temp
 * project and read what it prints, because that is the boundary where the
 * mapping used to break: lines were counted from the start of the script, the
 * child's error was printed twice, and the runner's and Bascik's own frames
 * were mixed into the user's stack.
 *
 * Every fixture puts the script below other content (markup, an inline
 * `<style>`, a routes script) because each of those is removed or moved before
 * the script runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Source entrypoint. Node 24 runs .ts directly, and pkg/dist is gitignored.
const PKG_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");

const page = (title: string, body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <main>\n    <h1>${title}</h1>\n${body}\n  </main>\n</body>\n</html>\n`;

/** A component with markup and a multi-line `<style>` above its script, which Bascik extracts. */
const component = (directive: string, message: string): string =>
  `<div class="card">\n  <p>card</p>\n</div>\n<style>\n  .card { color: red; }\n</style>\n<script ${directive}>\n  export default () => {\n    throw new Error("${message}");\n  };\n</script>\n`;

/** 1-based line and column of `needle` in `text`. */
const locationOf = (text: string, needle: string): string => {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  return `${index + 1}:${lines[index].indexOf(needle) + 1}`;
};

/** The files of a fixture project, by path. */
type Files = Record<string, string>;

const writeProject = async (files: Files): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-script-errors-"));
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
  // Never inherit a mode flag from the vitest environment.
  BASCIK_BUILD: "0",
  BASCIK_SERVER: "0",
  VITEST: "",
  ...extra,
});

const runBuild = (root: string): Promise<{ code: number | null; output: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [PKG_ENTRY, "--build", "--site-url", "https://example.com"], {
      cwd: root,
      env: childEnv({}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });

/** The lines of `output` from `header` up to the next blank line or `[bascik]` header. */
const reportFor = (output: string, header: string): string => {
  const start = output.indexOf(header);
  if (start === -1) throw new Error(`"${header}" not printed. Output:\n${output}`);
  const rest = output.slice(start + header.length);
  const end = rest.search(/\n(?:\[bascik\]|transpiled:|generated:|copied|✓)/);
  return rest.slice(0, end === -1 ? undefined : end);
};

/** No frame of the runner, the temp module, Bascik itself, or Node internals. */
const expectOnlyUserFrames = (report: string): void => {
  expect(report).not.toMatch(/runner\.mjs|bascik-handler-|node_modules\/\.cache\/bascik|build-\d+-|routes-\d+-/);
  expect(report).not.toMatch(/node:internal|\/pkg\/(?:src|dist)\/lib\/|Command failed|Node\.js v\d/);
};

const BUILD_PAGE = page("Build", `    <script data-bascik-build>\n      const unused = 1;\n\n      export default () => {\n        throw new Error("page build failure");\n      };\n    </script>`);
const SYNTAX_PAGE = page("Syntax", `    <script data-bascik-build>\n      export default () => {\n        return "x" +;\n      };\n    </script>`);
const ROUTES_TEMPLATE = page("Routes", `    <script data-bascik-routes>\n      export default () => {\n        throw new Error("routes failure");\n      };\n    </script>`);
const BUILD_COMPONENT = component("data-bascik-build", "component build failure");
const HELPER = `export const unused = 1;\n\nexport const explode = () => {\n  throw new Error("helper failure");\n};\n`;
const SRC_PAGE = page("Src", `    <script data-bascik-build src="../lib/explode.ts"></script>`);

describe("build-time script errors (real `bascik --build`)", () => {
  let root: string;
  let output: string;

  beforeAll(async () => {
    root = await writeProject({
      "bascik.config.ts": `export default { scripts: { onBuildScriptError: "warn", onRoutesScriptError: "warn" } };\n`,
      "src/pages/index.html": page("Home", "    <p>ok</p>"),
      "src/pages/build.html": BUILD_PAGE,
      "src/pages/syntax.html": SYNTAX_PAGE,
      "src/pages/blog/[slug].html": ROUTES_TEMPLATE,
      "src/pages/card.html": page("Card", "    <failing-card></failing-card>"),
      "src/components/failing-card/failing-card.html": BUILD_COMPONENT,
      "src/lib/explode.ts": `import { explode } from "./helper.ts";\nexport default () => explode();\n`,
      "src/lib/helper.ts": HELPER,
      "src/pages/src.html": SRC_PAGE,
    });
    ({ output } = await runBuild(root));
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the page file's line and column for a page build script, once", () => {
    const header = `[bascik] build script error in "src/pages/build.html" at (line 9, column 5):`;
    const report = reportFor(output, header);

    expect(report).toContain(`at Module.default (src/pages/build.html:${locationOf(BUILD_PAGE, "new Error")})`);
    expectOnlyUserFrames(report);
    expect(output.split("page build failure").length - 1).toBe(1);
  });

  it("names the component file's line, below the <style> Bascik extracts, once", () => {
    const header = `[bascik] build script error in "src/components/failing-card/failing-card.html" at (line 7, column 1):`;
    const report = reportFor(output, header);

    expect(report).toContain(
      `at Module.default (src/components/failing-card/failing-card.html:${locationOf(BUILD_COMPONENT, "new Error")})`,
    );
    expectOnlyUserFrames(report);
    expect(output.split("component build failure").length - 1).toBe(1);
  });

  it("locates a syntax error, which Node reports with no location when it is caught", () => {
    const report = reportFor(output, `[bascik] build script error in "src/pages/syntax.html" at (line 9, column 5):`);
    const [line, column] = locationOf(SYNTAX_PAGE, "+;").split(":").map(Number);

    // Node's own report: the file and line, the source line, and a caret under the token.
    expect(report).toContain(`src/pages/syntax.html:${line}\n        return "x" +;\n${" ".repeat(column)}^`);
    expect(report).toContain("SyntaxError: Unexpected token ';'");
    expectOnlyUserFrames(report);
  });

  it("names the template's line for a routes script, once", () => {
    const report = reportFor(output, `[bascik] routes script error in "src/pages/blog/[slug].html" at (line 9, column 5):`);

    expect(report).toContain(`at Module.default (src/pages/blog/[slug].html:${locationOf(ROUTES_TEMPLATE, "new Error")})`);
    expectOnlyUserFrames(report);
    expect(output.split("routes failure").length - 1).toBe(1);
  });

  it("names a src= script's own files and lines, not the page", () => {
    const report = reportFor(output, `[bascik] build script error in "src/pages/src.html" at (line 9, column 5):`);

    expect(report).toMatch(new RegExp(`at explode \\(file://\\S+/src/lib/helper\\.ts:${locationOf(HELPER, "new Error")}\\)`));
    expect(report).toContain("at Module.default (src/lib/explode.ts:2:");
    expectOnlyUserFrames(report);
  });
});

const SERVER_PAGE = page("Server", `    <script data-bascik-server>\n      const unused = 1;\n\n      export default () => {\n        throw new Error("page server failure");\n      };\n    </script>`);
const SERVER_COMPONENT = component("data-bascik-server", "component server failure");
const STREAM_PAGE = page("Stream", `    <p>loading</p>\n    <script data-bascik-stream>\n      export default async () => {\n        throw new Error("page stream failure");\n      };\n    </script>`);
const SERVER_SYNTAX_PAGE = page("Server syntax", `    <script data-bascik-server>\n      export default () => {\n        return "x" +;\n      };\n    </script>`);
/** Windows line endings: lines are counted by `\n`, and a `\r` never shifts a column. */
const CRLF_SERVER_PAGE = page("CRLF", `    <script data-bascik-server>\n      export default () => {\n        throw new Error("crlf server failure");\n      };\n    </script>`).replace(/\n/g, "\r\n");
const CRLF_BUILD_PAGE = page("CRLF build", `    <script data-bascik-build>\n      export default () => {\n        throw new Error("crlf build failure");\n      };\n    </script>`).replace(/\n/g, "\r\n");

describe("build-time script errors in a file with CRLF line endings", () => {
  let root: string;
  let output: string;

  beforeAll(async () => {
    root = await writeProject({
      "bascik.config.ts": `export default { scripts: { onBuildScriptError: "warn" } };\n`,
      "src/pages/index.html": page("Home", "    <p>ok</p>"),
      "src/pages/crlf.html": CRLF_BUILD_PAGE,
    });
    ({ output } = await runBuild(root));
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names the same line and column as an LF file", () => {
    const report = reportFor(output, `[bascik] build script error in "src/pages/crlf.html" at (line 9, column 5):`);
    expect(report).toContain(`at Module.default (src/pages/crlf.html:${locationOf(CRLF_BUILD_PAGE, "new Error")})`);
    expectOnlyUserFrames(report);
  });
});

/** How each server mode is started: the dev server from source, or the production server from a build. */
const SERVER_MODES = [
  { mode: "dev server (`bascik`)", args: [] as string[], build: false, portOffset: 0 },
  { mode: "production server (`bascik --server`)", args: ["--server"], build: true, portOffset: 1 },
];

describe.each(SERVER_MODES)("request-time script errors (real $mode)", ({ args, build, portOffset }) => {
  let root: string;
  let child: ChildProcess;
  let output = "";
  let base: string;

  const waitFor = (pattern: RegExp, timeoutMs = 30_000): Promise<void> =>
    new Promise((resolveWait, reject) => {
      const started = Date.now();
      const check = (): void => {
        if (pattern.test(output)) return resolveWait();
        if (Date.now() - started > timeoutMs) return reject(new Error(`${pattern} not printed. Output:\n${output}`));
        setTimeout(check, 50);
      };
      check();
    });

  beforeAll(async () => {
    root = await writeProject({
      "src/pages/index.html": page("Home", "    <p>ok</p>"),
      "src/pages/server.html": SERVER_PAGE,
      "src/pages/server-card.html": page("Server card", "    <server-card></server-card>"),
      "src/components/server-card/server-card.html": SERVER_COMPONENT,
      "src/pages/stream.html": STREAM_PAGE,
      "src/pages/server-syntax.html": SERVER_SYNTAX_PAGE,
      "src/pages/crlf.html": CRLF_SERVER_PAGE,
    });
    // The production server reads the sidecar the build wrote, so the recorded
    // line and column have to survive the build to be right here.
    if (build) {
      const { code, output: buildOutput } = await runBuild(root);
      if (code !== 0) throw new Error(`build exited ${code}:\n${buildOutput}`);
    }
    const port = 9800 + (process.pid % 150) + portOffset * 150;
    base = `http://localhost:${port}`;
    child = spawn(process.execPath, [PKG_ENTRY, ...args], {
      cwd: root,
      env: childEnv({ BASCIK_SERVER_PORT: String(port), BASCIK_ENABLE_TLS: "false" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer) => { output += data.toString(); });
    child.stderr?.on("data", (data: Buffer) => { output += data.toString(); });
    await waitFor(/Server running at/);
  }, 120_000);

  afterAll(async () => {
    if (child.exitCode === null) {
      await new Promise<void>((done) => {
        child.once("close", () => done());
        child.kill("SIGINT");
      });
    }
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ["/server", "page server failure", "src/pages/server.html", SERVER_PAGE, 500],
    ["/server-card", "component server failure", "src/components/server-card/server-card.html", SERVER_COMPONENT, 500],
    ["/crlf", "crlf server failure", "src/pages/crlf.html", CRLF_SERVER_PAGE, 500],
    // Headers are committed before a stream script runs, so it cannot become a 500.
    ["/stream", "page stream failure", "src/pages/stream.html", STREAM_PAGE, 200],
  ])("reports %s once, at the line in %s", async (path, message, file, source, status) => {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(status);
    await response.text();
    await waitFor(new RegExp(message));
    // Give a second report the time it would take to arrive.
    await new Promise((done) => setTimeout(done, 300));

    const report = reportFor(output, `[bascik] server script error at "${path}":`);
    expect(report).toContain(`at default (${file}:${locationOf(source, "new Error")})`);
    expectOnlyUserFrames(report);
    expect(report).not.toMatch(/Promise\.all|processTicksAndRejections/);
    expect(output.split(message).length - 1).toBe(1);
  });

  it("names the file and the line the script starts on for a syntax error, which Node reports with no location", async () => {
    const response = await fetch(`${base}/server-syntax`);
    expect(response.status).toBe(500);
    await response.text();
    await waitFor(/Unexpected token ';'/);

    const report = reportFor(output, `[bascik] server script error at "/server-syntax":`);
    expect(report).toContain("SyntaxError: Unexpected token ';'");
    expect(report).toContain(`in the script that starts at src/pages/server-syntax.html:${locationOf(SERVER_SYNTAX_PAGE, "export default")}`);
    expectOnlyUserFrames(report);
  });
});
