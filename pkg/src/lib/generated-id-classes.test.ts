/**
 * The site-wide generated `#id` class collision check (prompt 158-R3-15),
 * through `listComponents` on real component files in a temp directory.
 *
 * `#btn` in `site-nav_x` and `#x_btn` in `site-nav` both compile to
 * `b_id_site-nav_x_btn`, so each rule would style the other component's
 * element. The build must stop with a located error naming both pairs; the
 * same pair seen twice, a markup id without a rule, and the per-instance names
 * a component gets with `url(#id)` or `deduplicateCss: false` are not
 * collisions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { configState } = vi.hoisted(() => ({
  configState: {
    directory: { pages: "", components: [] as string[], out: "" },
    scoping: {
      attributes: { class: true, id: true, name: false },
      deduplicateCss: true,
      preserve: [] as string[],
    },
    minify: { html: false, css: false, js: false, identifiers: false },
    scripts: { cache: { enabled: false } },
    logging: { level: "info" },
    base: "/",
  },
}));

vi.mock("./config.js", () => ({
  BascikConfig: configState,
  shouldLog: () => false,
}));

vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn(async (html: string) => html),
}));

import { listComponents, invalidateComponentListCache } from "./components.ts";
import {
  GeneratedIdClassCollisionError,
  findGeneratedIdClassCollisions,
} from "./generated-id-classes.ts";
import { idSelectorClassName } from "./styles.ts";

let base: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

const write = (path: string, content: string) => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
};

const collisionOf = async (): Promise<GeneratedIdClassCollisionError> => {
  const error = await listComponents().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GeneratedIdClassCollisionError);
  return error as GeneratedIdClassCollisionError;
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-id-classes-")));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(base);
  configState.directory.components = [join(base, "src/components")];
  configState.scoping.attributes.class = true;
  configState.scoping.attributes.id = true;
  configState.scoping.deduplicateCss = true;
  configState.minify.identifiers = false;
  mkdirSync(join(base, "src/components"), { recursive: true });
  invalidateComponentListCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  cwdSpy.mockRestore();
  invalidateComponentListCache();
  rmSync(base, { recursive: true, force: true });
});

describe("generated #id class collisions", () => {
  it("fails with both components, both ids, their lines and the fix", async () => {
    write(
      "src/components/site-nav_x.html",
      '<nav><button id="btn">Menu</button></nav>\n',
    );
    write(
      "src/components/site-nav_x.css",
      "nav { display: flex; }\n\n#btn { color: red; }\n",
    );
    write(
      "src/components/site-nav.html",
      '<nav>\n  <a id="x_btn">Home</a>\n</nav>\n<style>\n  #x_btn { color: blue; }\n</style>\n',
    );

    const error = await collisionOf();
    expect(error.collisions).toHaveLength(1);
    expect(error.message).toContain(
      "both generate the class b_id_site-nav_x_btn",
    );
    expect(error.message).toContain("<site-nav_x> #btn");
    expect(error.message).toContain("<site-nav> #x_btn");
    // The rule's own file and position: the paired .css, and a <style> in the markup.
    expect(error.message).toContain(
      "src/components/site-nav_x.css:3:1  #btn in <site-nav_x>",
    );
    expect(error.message).toContain(
      "src/components/site-nav.html:5:3  #x_btn in <site-nav>",
    );
    // The fix renames the id with the underscore or the component with one.
    expect(error.message).toContain(
      "Rename #x_btn in <site-nav> (for example #x-btn)",
    );
    expect(error.message).toContain(
      "rename <site-nav_x> with hyphens (for example site-nav-x.html)",
    );
  });

  it("fails under minify.identifiers too, where both pairs give one hash", async () => {
    configState.minify.identifiers = true;
    write("src/components/my_card.html", '<p id="btn">a</p>');
    write("src/components/my_card.css", "#btn { color: red }");
    write("src/components/my.html", '<p id="card_btn">b</p>');
    write("src/components/my.css", "#card_btn { color: blue }");

    expect(idSelectorClassName("my_card", "btn")).toBe(
      idSelectorClassName("my", "card_btn"),
    );
    const error = await collisionOf();
    expect(error.message).toContain("b_id_my_card_btn");
  });

  it("reports every collision, each against the first pair that made the name", async () => {
    write("src/components/a.html", '<p id="b_c_d">a</p>');
    write("src/components/a.css", "#b_c_d { color: red }");
    write("src/components/a_b.html", '<p id="c_d">b</p>');
    write("src/components/a_b.css", "#c_d { color: red }");
    write("src/components/a_b_c.html", '<p id="d">c</p>');
    write("src/components/a_b_c.css", "#d { color: red }");

    const error = await collisionOf();
    expect(error.collisions.map((c) => c.className)).toEqual([
      "b_id_a_b_c_d",
      "b_id_a_b_c_d",
    ]);
    expect(error.message.match(/^error: /gm)).toHaveLength(2);
  });

  it("reads CRLF line endings as one line each", async () => {
    write("src/components/one_two.html", '<p id="three">a</p>');
    write(
      "src/components/one_two.css",
      "p {}\r\n\r\n  #three { color: red }\r\n",
    );
    write("src/components/one.html", '<p id="two_three">b</p>');
    write("src/components/one.css", "#two_three { color: blue }");

    const error = await collisionOf();
    expect(error.message).toContain("src/components/one_two.css:3:3");
    expect(error.message).toContain("src/components/one.css:1:1");
  });

  it("names the component file without a line when the rule comes from an @import", async () => {
    write("src/styles/shared.css", "#x_btn { color: red }");
    write("src/components/site-nav.html", '<a id="x_btn">a</a>');
    write("src/components/site-nav.css", '@import "../styles/shared.css";');
    write("src/components/site-nav_x.html", '<a id="btn">b</a>');
    write("src/components/site-nav_x.css", "#btn { color: red }");

    const error = await collisionOf();
    expect(error.message).toMatch(
      /^ {2}src\/components\/site-nav\.html {2}#x_btn in <site-nav>$/m,
    );
  });
});

describe("what is not a generated #id class collision", () => {
  it("one component naming the same id in several rules and stylesheets", async () => {
    write(
      "src/components/site_nav.html",
      '<nav id="menu_btn">x</nav><style>#menu_btn:hover { color: red }</style>',
    );
    write(
      "src/components/site_nav.css",
      "#menu_btn { color: red }\n@media (width > 1px) { #menu_btn { color: blue } }",
    );

    await expect(listComponents()).resolves.toHaveProperty("site_nav");
  });

  it("the same id in two components whose names hold no underscore", async () => {
    write("src/components/site-nav.html", '<a id="btn">a</a>');
    write("src/components/site-nav.css", "#btn { color: red }");
    write("src/components/site-footer.html", '<a id="btn">b</a>');
    write("src/components/site-footer.css", "#btn { color: red }");

    await expect(listComponents()).resolves.toHaveProperty("site-footer");
  });

  it("an id that only one of the two components styles", async () => {
    // site-nav declares x_btn in markup but has no #x_btn rule, so it gets no class.
    write("src/components/site-nav.html", '<a id="x_btn">a</a>');
    write("src/components/site-nav.css", "a { color: red }");
    write("src/components/site-nav_x.html", '<a id="btn">b</a>');
    write("src/components/site-nav_x.css", "#btn { color: red }");

    await expect(listComponents()).resolves.toHaveProperty("site-nav_x");
  });

  it("a hash in a value, a string, a comment or an attribute selector", async () => {
    write("src/components/site-nav.html", '<a id="x_btn">a</a>');
    write(
      "src/components/site-nav.css",
      'a { color: #abc; background: url(#x_btn); content: "#x_btn {" }\n' +
        '/* #x_btn { } */ a[href="#x_btn"] { color: red }',
    );
    write("src/components/site-nav_x.html", '<a id="btn">b</a>');
    write("src/components/site-nav_x.css", "#btn { color: red }");

    await expect(listComponents()).resolves.toHaveProperty("site-nav");
  });

  it("a component whose stylesheet references its own id with url(#id), which gets per-instance names", async () => {
    write(
      "src/components/glow_card.html",
      '<svg><filter id="glow"></filter></svg><div id="box">x</div>',
    );
    write("src/components/glow_card.css", "#box { filter: url(#glow); }");
    write("src/components/glow.html", '<div id="card_box">y</div>');
    write("src/components/glow.css", "#card_box { color: red }");

    await expect(listComponents()).resolves.toHaveProperty("glow_card");
  });

  it("any pair with scoping.deduplicateCss off or class scoping off", async () => {
    write("src/components/my_card.html", '<p id="btn">a</p>');
    write("src/components/my_card.css", "#btn { color: red }");
    write("src/components/my.html", '<p id="card_btn">b</p>');
    write("src/components/my.css", "#card_btn { color: blue }");

    configState.scoping.deduplicateCss = false;
    await expect(listComponents()).resolves.toHaveProperty("my");
    configState.scoping.deduplicateCss = true;
    configState.scoping.attributes.class = false;
    invalidateComponentListCache();
    await expect(listComponents()).resolves.toHaveProperty("my");
  });
});

describe("findGeneratedIdClassCollisions", () => {
  it("skips an empty component and one without a stylesheet", () => {
    expect(
      findGeneratedIdClassCollisions({
        my_card: {
          fileName: "src/components/my_card.html",
          fileContent: "",
          cssFileContent: "#btn { color: red }",
        },
        my: {
          fileName: "src/components/my.html",
          fileContent: '<p id="card_btn">b</p>',
          cssFileContent: "#card_btn { color: blue }",
        },
        my_x: {
          fileName: "src/components/my_x.html",
          fileContent: '<p id="btn">c</p>',
        },
      }),
    ).toEqual([]);
  });
});
