/**
 * Tag names end where a browser ends them, in a real build and a real
 * production server (2026-10-29; unit cases in browser-tag-names.test.ts).
 *
 * `<style-guide>`, `<script-loader>` and `<textarea-field>` are custom
 * elements, so the component tags after them are expanded even when a real
 * `</style>`, `</script>` or `</textarea>` follows. `<my-card.foo>`,
 * `<my-card</p>` and `<my-card:x>` are other tags, so they are left as the
 * author wrote them. The same holds for a server script's output, expanded at
 * request time. Each page is checked against parse5: no `my-card` element is
 * left in the output where the browser would have built one, and every
 * look-alike survives.
 *
 * Second pass (same day): a raw-text opener written inside another tag
 * (`<p title="Add a <script> tag">`, `<p<style>`) opens nothing, so a page
 * with a later real `</script>` or `</style>` keeps its body (the build used
 * to fail with "Page does not contain a non-empty <body> element"); a closer
 * with attributes (`</style/>`, `</script x>`) ends its element; and a name
 * inside another tag or a bogus comment (`<p<my-card>`, `<!x<my-card>`) is
 * no usage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG_ENTRY = join(PKG, "src/index.ts");

const page = (body: string): string =>
  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <title>t</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

/** Custom elements named like raw-text tags, each followed by a card and a real raw-text element. */
const RAW_LOOKALIKES = [
  `<style-guide><my-card data-testid="after-style-guide"></my-card></style-guide>`,
  `<style>.x { color: red }</style>`,
  `<script-loader><my-card data-testid="after-script-loader"></my-card></script-loader>`,
  `<script>console.log("real")</script>`,
  `<textarea-field><my-card data-testid="after-textarea-field"></my-card></textarea-field>`,
  `<textarea>t</textarea>`,
].join("\n");

/** Tags whose names only start with a component name, then one real usage. */
const NAME_LOOKALIKES = [
  `<my-card.foo>dot</my-card.foo>`,
  `<p><my-card</p>`,
  `<my-card:x>colon</my-card:x>`,
  `<my-card data-testid="real"></my-card>`,
].join("\n");

/** Raw-text openers inside other tags, each followed by a card and a real raw-text element. */
const OPENERS_IN_TAGS = [
  `<p title="Add a <script> tag" data-testid="script-tip">tip</p><my-card data-testid="after-script-attr"></my-card><script>console.log(1)</script>`,
  `<p title="<style>" data-testid="style-tip">tip</p><my-card data-testid="after-style-attr"></my-card><style>.a{}</style>`,
  `<p<style>x<my-card data-testid="after-p-style"></my-card><style>.b{}</style>`,
].join("\n");

/** Closers with attributes, each followed by a card and a real raw-text element. */
const ATTRIBUTE_CLOSERS = [
  `<style>.c{}</style/><my-card data-testid="after-style-slash"></my-card><style>.d{}</style>`,
  `<script>x()</script x><my-card data-testid="after-script-attr-close"></my-card><script>y()</script>`,
].join("\n");

/** Names inside other tags and bogus comments, then one real usage. */
const NAMES_IN_TAGS = [
  `<p<my-card>a</p>`,
  `<!x<my-card>`,
  `<my-card data-testid="real"></my-card>`,
].join("\n");

const SITE: Record<string, string> = {
  "src/components/my-card/my-card.html": `<div class="card" data-testid="my-card">CARD</div>\n`,
  "src/pages/raw.html": page(RAW_LOOKALIKES),
  "src/pages/names.html": page(NAME_LOOKALIKES),
  "src/pages/attr.html": page(OPENERS_IN_TAGS),
  // A page whose only later raw-text element follows the attribute: the build
  // used to find no body at all.
  "src/pages/body.html": page(
    `<p title="<style>">tip</p><p>x</p><style>.a{}</style>`,
  ),
  "src/pages/closers.html": page(ATTRIBUTE_CLOSERS),
  "src/pages/in-tags.html": page(NAMES_IN_TAGS),
  "src/pages/request-tags.html": page(`<script data-bascik-server>
export default () => ${JSON.stringify(
    `${OPENERS_IN_TAGS}\n${ATTRIBUTE_CLOSERS}\n${NAMES_IN_TAGS}`,
  ).replaceAll("</", "<\\/")};
</script>`),
  "src/pages/request.html": page(`<script data-bascik-server>
export default () => ${
    // `<\/` so the script's own body has no `</script>` that would end it.
    JSON.stringify(`${RAW_LOOKALIKES}\n${NAME_LOOKALIKES}`).replaceAll(
      "</",
      "<\\/",
    )
  };
</script>`),
};

type Node = DefaultTreeAdapterTypes.ChildNode;

/** Tag names of the elements parse5 builds from a document, in order. */
const parsedElementNames = (html: string): string[] => {
  const names: string[] = [];
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (!("tagName" in node)) continue;
      names.push(node.tagName);
      visit(node.childNodes);
    }
  };
  visit(parse(html).childNodes);
  return names;
};

const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  BASCIK_BUILD: "0",
  BASCIK_SERVER: "0",
  VITEST: "",
  ...extra,
});

const run = (
  root: string,
  args: string[],
): Promise<{ code: number | null; output: string }> =>
  new Promise((done, reject) => {
    const child = spawn(process.execPath, [PKG_ENTRY, ...args], {
      cwd: root,
      env: childEnv({}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => done({ code, output }));
  });

const freePort = (): Promise<number> =>
  new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

describe("tag names end where the browser ends them (real build and production server)", () => {
  let root: string;
  let server: ChildProcess | undefined;
  let base = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "bascik-browser-tag-names-"));
    for (const [path, content] of Object.entries(SITE)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "tag-names-site", type: "module", private: true }),
    );
    const { code, output } = await run(root, [
      "--build",
      "--site-url",
      "https://example.com",
    ]);
    if (code !== 0) throw new Error(`build exited ${code}:\n${output}`);
    const port = await freePort();
    let log = "";
    server = spawn(process.execPath, [PKG_ENTRY, "--server"], {
      cwd: root,
      env: childEnv({
        BASCIK_SERVER_PORT: String(port),
        BASCIK_ENABLE_TLS: "false",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d: Buffer) => (log += d.toString()));
    server.stderr?.on("data", (d: Buffer) => (log += d.toString()));
    const started = Date.now();
    while (!/Server running at/.test(log)) {
      if (server.exitCode !== null || Date.now() - started > 60_000)
        throw new Error(`server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    base = `http://localhost:${port}`;
  }, 180_000);

  afterAll(async () => {
    if (server && server.exitCode === null)
      await new Promise<void>((done) => {
        server!.once("close", () => done());
        server!.kill("SIGINT");
      });
    if (root) await rm(root, { recursive: true, force: true });
  });

  const built = (name: string) => readFile(join(root, "dist", name), "utf8");
  const served = async (path: string) => {
    const response = await fetch(new URL(path, base));
    expect(response.status).toBe(200);
    return response.text();
  };

  it("expands a card after each custom element named like a raw-text tag", async () => {
    for (const html of [await built("raw.html"), await served("/raw")]) {
      expect(count(html, ">CARD</div>")).toBe(3);
      expect(parsedElementNames(html)).not.toContain("my-card");
      expect(html).toContain("<style-guide>");
      expect(html).toContain("<script-loader>");
      expect(html).toContain("<textarea-field>");
    }
  });

  it("leaves tags whose names only start with a component name as written", async () => {
    for (const html of [await built("names.html"), await served("/names")]) {
      expect(count(html, ">CARD</div>")).toBe(1);
      expect(parsedElementNames(html)).not.toContain("my-card");
      expect(html).toContain("<my-card.foo>dot</my-card.foo>");
      expect(html).toContain("<my-card</p>");
      expect(html).toContain("<my-card:x>colon</my-card:x>");
    }
  });

  it("keeps the page and expands the cards after a raw-text opener inside another tag", async () => {
    for (const html of [await built("attr.html"), await served("/attr")]) {
      expect(count(html, ">CARD</div>")).toBe(3);
      expect(parsedElementNames(html)).not.toContain("my-card");
      expect(html).toContain('title="Add a <script> tag"');
      expect(html).toContain("console.log(1)");
    }
    const body = await built("body.html");
    expect(body).toContain('<p title="<style>">tip</p>');
    expect(body).toContain("<p>x</p>");
  });

  it("ends a raw-text element at a closer with attributes", async () => {
    for (const html of [
      await built("closers.html"),
      await served("/closers"),
    ]) {
      expect(count(html, ">CARD</div>")).toBe(2);
      expect(parsedElementNames(html)).not.toContain("my-card");
    }
  });

  it("leaves a component name inside another tag or a bogus comment as written", async () => {
    for (const html of [
      await built("in-tags.html"),
      await served("/in-tags"),
    ]) {
      expect(count(html, ">CARD</div>")).toBe(1);
      expect(html).toContain("<p<my-card>a</p>");
      expect(html).toContain("<!x<my-card>");
    }
  });

  it("reads tags inside tags and closers with attributes at request time the same way", async () => {
    const html = await served("/request-tags");
    expect(count(html, ">CARD</div>")).toBe(6);
    expect(html).toContain("<p<my-card>a</p>");
  });

  it("reads a server script's output at request time the same way", async () => {
    const html = await served("/request");
    expect(count(html, ">CARD</div>")).toBe(4);
    expect(parsedElementNames(html)).not.toContain("my-card");
    expect(html).toContain("<my-card.foo>dot</my-card.foo>");
    expect(html).toContain("<my-card:x>colon</my-card:x>");
  });
});
