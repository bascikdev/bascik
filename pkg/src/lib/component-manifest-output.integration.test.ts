/**
 * What a real process prints when a component manifest build, which builds
 * components concurrently and holds each one's output until its turn, is
 * cut short: a crash, an unhandled rejection, `process.exit` or Ctrl-C
 * inside a component that is not the turn yet.
 *
 * A one-at-a-time build printed the crash message and everything before it,
 * and the running component's progress up to an interrupt. Held output must
 * not swallow any of that: each case runs the sources in a child process.
 *
 * Misuse lens: a custom `minify.css` function that leaves a throwing timer
 * or a rejected promise behind, gives up with `process.exit`, or is slow
 * enough that the user presses Ctrl-C.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCES = fileURLToPath(new URL("./", import.meta.url));

/** `minify.css` bodies by mode; `name` is the component letter. */
const MODES: Record<string, string> = {
  crash: `if (name === "a") await sleep(1500);
    else if (name === "b") setTimeout(() => { throw new Error("crash from b minifier timer"); }, 10);`,
  reject: `if (name === "a") await sleep(1500);
    else if (name === "b") Promise.reject(new Error("unhandled from b minifier"));`,
  exit: `if (name === "a") await sleep(1500);
    else if (name === "b") { console.warn("giving up in b"); process.exit(3); }`,
  progress: `console.log("start " + name);
    await sleep(name === "a" ? 8000 : 10);
    console.log("end " + name);`,
};

/** The project config: `minify.css` runs the body for `PROBE`. */
const CONFIG = `const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = process.env.PROBE;
export default {
  minify: {
    css: async (code) => {
      const name = /shell-([a-z]+)/.exec(code)?.[1];
${Object.entries(MODES)
  .map(
    ([mode, body]) =>
      `      if (mode === ${JSON.stringify(mode)}) {\n    ${body}\n      }`,
  )
  .join("\n")}
      return code;
    },
  },
};
`;

const PROBE = `
const SRC = ${JSON.stringify(SOURCES)};
const { installProcessCrashHandlers } = await import(SRC + "crash-net.ts");
installProcessCrashHandlers();
const { BascikConfig } = await import(SRC + "config.ts");
const { buildComponentManifest } = await import(SRC + "component-manifest.ts");
const cards = Object.fromEntries(["a", "b", "c"].map((name) => [name + "-card", {
  fileName: "src/components/" + name + "-card.html",
  fileContent: '<div class="shell-' + name + '">x</div>',
  cssFileContent: ".shell-" + name + " { margin: 0 }",
}]));
await buildComponentManifest(cards, BascikConfig);
console.log("RESULT ok");
`;

let root: string;

beforeAll(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "bascik-manifest-output-")),
  );
  await mkdir(join(root, "src", "components"), { recursive: true });
  await mkdir(join(root, "src", "pages"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "probe", type: "module", private: true }),
  );
  await writeFile(join(root, "bascik.config.js"), CONFIG);
  await writeFile(join(root, "probe.mjs"), PROBE);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run one probe; `onStdout` may interrupt it once it has printed enough. */
const run = (
  mode: string,
  onStdout?: (stdout: string, interrupt: () => void) => void,
): Promise<Outcome> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "probe.mjs")], {
      cwd: root,
      env: { ...process.env, PROBE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      onStdout?.(stdout, () => child.kill("SIGINT"));
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, stderr });
    });
  });

describe("a manifest build cut short prints what a one-at-a-time build would", () => {
  it("misuse: a throw from a timer a later component left behind prints the fatal message and exits 1", async () => {
    const outcome = await run("crash");
    expect(outcome.stderr).toContain(
      "[bascik] Fatal uncaught exception: Error: crash from b minifier timer",
    );
    expect(outcome.code).toBe(1);
  }, 30_000);

  it("misuse: an unhandled rejection in a later component prints the fatal message and exits 1", async () => {
    const outcome = await run("reject");
    expect(outcome.stderr).toContain(
      "[bascik] Fatal unhandled promise rejection: Error: unhandled from b minifier",
    );
    expect(outcome.code).toBe(1);
  }, 30_000);

  it("misuse: process.exit inside a later component writes what it printed first", async () => {
    const outcome = await run("exit");
    expect(outcome.stderr).toContain("giving up in b");
    expect(outcome.code).toBe(3);
  }, 30_000);

  it("misuse: Ctrl-C during a long first component keeps the progress it already printed", async () => {
    let interrupted = false;
    let seenAfter = Infinity;
    const started = performance.now();
    const outcome = await run("progress", (stdout, interrupt) => {
      if (!interrupted && stdout.includes("start a")) {
        interrupted = true;
        seenAfter = performance.now() - started;
        interrupt();
      }
    });
    expect(interrupted).toBe(true);
    // Printed while a was still running (it sleeps 8 s), not held until it
    // finished.
    expect(seenAfter).toBeLessThan(6000);
    expect(outcome.stdout).toContain("start a");
    expect(outcome.stdout).not.toContain("RESULT ok");
  }, 30_000);
});
