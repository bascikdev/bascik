/**
 * The generated `#id` class collision check through a real `bascik --build`
 * (prompt 158-R3-15; unit cases in generated-id-classes.test.ts).
 *
 * `#btn` in `<site-nav_x>` and `#x_btn` in `<site-nav>` both compile to
 * `b_id_site-nav_x_btn`. The build stops with exit code 1 and the located
 * error, on the main thread and with `pipeline.workers: true` alike, before
 * any page or the request-time component manifest is written. A component
 * used on many pages, and a pair whose readable names only look alike because
 * one component gets per-instance names (`url(#id)`), still build.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Each case spawns a real build.
const BUILD_TIMEOUT_MS = 60_000;
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Source entrypoint. Node 24 runs .ts directly, and pkg/dist is gitignored.
const PKG_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../index.ts",
);

const page = (title: string, body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>${title}</title>\n</head>\n<body>\n  <main>\n${body}\n  </main>\n</body>\n</html>\n`;

const writeProject = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bascik-id-class-collision-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

const runBuild = (
  root: string,
): Promise<{ code: number | null; output: string }> =>
  new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [PKG_ENTRY, "--build", "--site-url", "https://example.com"],
      {
        cwd: root,
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          BASCIK_BUILD: "0",
          BASCIK_SERVER: "0",
          VITEST: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data: Buffer) => (output += data.toString()));
    child.stderr.on("data", (data: Buffer) => (output += data.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });

const COLLIDING: Record<string, string> = {
  "src/components/site-nav_x.html":
    '<nav><button id="btn">Menu</button></nav>\n',
  "src/components/site-nav_x.css":
    "nav { display: flex; }\n#btn { color: red; }\n",
  "src/components/site-nav.html":
    '<nav>\n  <a id="x_btn" href="/">Milk frother</a>\n</nav>\n<style>\n  #x_btn { color: blue; }\n</style>\n',
  "src/pages/index.html": page("Home", "<site-nav></site-nav>"),
  "src/pages/about.html": page("About", "<site-nav_x></site-nav_x>"),
  // A server script page makes the build write the request-time manifest.
  "src/pages/live.html": page(
    "Live",
    `<script data-bascik-server>\nexport default () => "<site-nav></site-nav>";\n</script>`,
  ),
};

const expectCollisionReport = (output: string) => {
  expect(output).toContain(
    "error: <site-nav> #x_btn and <site-nav_x> #btn both generate the class b_id_site-nav_x_btn",
  );
  // Component name order, so the same on every file system.
  expect(output).toContain(
    "  src/components/site-nav.html:5:3  #x_btn in <site-nav>\n" +
      "  src/components/site-nav_x.css:2:1  #btn in <site-nav_x>\n",
  );
  expect(output).toContain("Rename #x_btn in <site-nav> (for example #x-btn)");
};

describe("bascik --build with two components whose #id rules generate one class", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it(
    "fails with exit code 1 and the located error, writing no page and no component manifest",
    async () => {
      const root = await writeProject(COLLIDING);
      roots.push(root);
      const { code, output } = await runBuild(root);
      expect(code).toBe(1);
      expectCollisionReport(output);
      expect(existsSync(join(root, "dist/index.html"))).toBe(false);
      expect(existsSync(join(root, ".bascik/dist/components.json"))).toBe(
        false,
      );
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    "fails the same way with pipeline.workers: true",
    async () => {
      const root = await writeProject({
        ...COLLIDING,
        "bascik.config.ts": "export default { pipeline: { workers: true } };\n",
      });
      roots.push(root);
      const { code, output } = await runBuild(root);
      expect(code).toBe(1);
      expectCollisionReport(output);
      // Reported once, by the main thread.
      expect(output.match(/both generate the class/g)).toHaveLength(1);
    },
    BUILD_TIMEOUT_MS,
  );
});

describe("bascik --build with generated #id classes that do not collide", () => {
  let root: string;
  let result: { code: number | null; output: string };

  beforeAll(async () => {
    root = await writeProject({
      // The same component on many pages is one (component, id) pair.
      "src/components/site-nav.html":
        '<nav><a id="x_btn" href="/">Home</a></nav>\n',
      "src/components/site-nav.css": "#x_btn { color: blue; }\n",
      // glow_card references its own id with url(#id), so every one of its
      // generated classes carries the instance id: b_id_glow_card__<id>_box,
      // never glow's b_id_glow_card_box.
      "src/components/glow_card.html":
        '<svg><filter id="glow"></filter></svg><div id="box">Glow</div>\n',
      "src/components/glow_card.css": "#box { filter: url(#glow); }\n",
      "src/components/glow.html": '<div id="card_box">Plain</div>\n',
      "src/components/glow.css": "#card_box { color: red; }\n",
      "src/pages/index.html": page(
        "Home",
        "<site-nav></site-nav><glow_card></glow_card><glow></glow>",
      ),
      "src/pages/a.html": page("A", "<site-nav></site-nav>"),
      "src/pages/b.html": page(
        "B",
        "<site-nav></site-nav><site-nav></site-nav>",
      ),
      "bascik.config.ts":
        "export default { minify: { identifiers: false } };\n",
    });
    result = await runBuild(root);
  }, BUILD_TIMEOUT_MS);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds, and the per-instance and shared classes really differ", async () => {
    expect(result.code, result.output).toBe(0);
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain("b_id_glow_card_box");
    expect(html).toMatch(/b_id_glow_card__[0-9a-f]+_box/);
    // Only glow's element carries the shared name.
    expect(html.match(/class="[^"]*\bb_id_glow_card_box\b/g)).toHaveLength(1);
  });
});
