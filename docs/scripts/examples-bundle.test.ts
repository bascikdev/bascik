// Unit tests for the examples bundle (examples-bundle.ts), the page helpers (src/lib/examples.ts), and a guard that
// every example component is documented and exercised. Browser behavior is in e2e/examples.spec.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLE_VERSION,
  DOCUMENTED_WITH,
  componentDescription,
  componentTagsIn,
  createExamplesBundle,
  readmeDescription,
  titleOf,
} from "./examples-bundle.ts";
import { fileTree, githubUrl } from "../src/lib/examples.ts";
import { testIdAdvisory } from "../../skills/bascik/scripts/lib/testids.mjs";
import { NAV } from "../src/lib/nav.ts";

const docsRoot = fileURLToPath(new URL("..", import.meta.url));
const examplesDir = join(docsRoot, "../examples");
const componentNames = readdirSync(join(examplesDir, "components")).sort();

describe("examples-bundle helpers", () => {
  it("titles names and reads descriptions from @bascik comments and READMEs", () => {
    expect(titleOf("tab-group")).toBe("Tab Group");
    expect(
      componentDescription(
        "<!-- @bascik\n  Shows tabs.\n  Two lines.\n\n  More.\n  @prop x -->",
      ),
    ).toBe("Shows tabs. Two lines.");
    expect(componentDescription("<div></div>")).toBe("");
    expect(
      readmeDescription(
        "# Title\n\n```sh\nx\n```\n\nA site\nwith posts.\n\nMore.",
      ),
    ).toBe("A site with posts.");
  });

  it("finds component tags in markup, ignoring comments, unknown tags, and the component itself", () => {
    const names = new Set(["tab-group", "copy-button"]);
    const source =
      "<!-- <copy-button> --><tab-group></tab-group><other-thing></other-thing><copy-button>";
    expect(componentTagsIn(source, names)).toEqual([
      "copy-button",
      "tab-group",
    ]);
    expect(componentTagsIn(source, names, "tab-group")).toEqual([
      "copy-button",
    ]);
  });
});

describe("examples page helpers", () => {
  it("prints folders before files at each level", () => {
    expect(
      fileTree("site", ["b.txt", "src/z.ts", "a.txt", "src/lib/x.ts"]),
    ).toBe(
      [
        "site/",
        "  src/",
        "    lib/",
        "      x.ts",
        "    z.ts",
        "  a.txt",
        "  b.txt",
      ].join("\n"),
    );
  });

  it("links to the example on GitHub", () => {
    expect(githubUrl("components/tab-group")).toBe(
      "https://github.com/bascikdev/bascik/tree/main/examples/components/tab-group",
    );
  });
});

describe("the published bundle", async () => {
  const bundle = await createExamplesBundle(examplesDir);
  const byName = new Map(
    bundle.examples.map((example) => [example.name, example]),
  );

  it("has every component and site, each with a description and files", () => {
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(
      bundle.examples.filter((e) => e.kind === "component").map((e) => e.name),
    ).toEqual(componentNames);
    expect(byName.get("starter-site")).toMatchObject({
      kind: "site",
      docs: "https://github.com/bascikdev/bascik/tree/main/examples/starter-site",
    });
    expect(byName.get("theme-init")?.docs).toBe(
      "/example-components/theme-toggle",
    );
    for (const example of bundle.examples) {
      expect(example.description, example.name).not.toBe("");
      expect(example.files.length, example.name).toBeGreaterThan(0);
    }
  });

  it("records the components a site file uses, including components from the site itself", () => {
    const contact = byName
      .get("starter-site")!
      .files.find((file) => file.path === "src/pages/contact.html")!;
    expect(contact.uses).toContain("contact-form");
    expect(contact.uses).toContain("site-head");
  });

  it("never ships build output or dependencies", () => {
    const paths = bundle.examples.flatMap((example) =>
      example.files.map((file) => `${example.name}/${file.path}`),
    );
    expect(
      paths.filter((path) => /(^|\/)(node_modules|dist|\.[^/]+)\//.test(path)),
    ).toEqual([]);
  });
});

describe("every example component is documented and exercised", () => {
  const navHrefs = new Set(
    NAV.flatMap((section) => section.pages.map((page) => page.href)),
  );
  const testPage = readFileSync(
    join(docsRoot, "e2e/fixtures/example-components.html"),
    "utf8",
  );

  it.each(componentNames)("%s", (name) => {
    const page = DOCUMENTED_WITH[name] ?? name;
    expect(
      existsSync(join(docsRoot, `src/pages/example-components/${page}.html`)),
      `add src/pages/example-components/${page}.html`,
    ).toBe(true);
    expect(
      existsSync(join(docsRoot, `content/example-components/${page}.md`)),
      `add content/example-components/${page}.md`,
    ).toBe(true);
    expect(
      navHrefs.has(`/example-components/${page}`),
      `add /example-components/${page} to nav.ts`,
    ).toBe(true);
    if (!DOCUMENTED_WITH[name]) {
      const instances =
        testPage.match(new RegExp(`<${name}\\b`, "g"))?.length ?? 0;
      expect(
        instances,
        `put two <${name}> instances in e2e/fixtures/example-components.html`,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});

// The house rule for examples (.github/copilot-instructions.md): a data-testid on every component root and
// interactive part, named after the component, and a root that is the element the HTML standard defines for the job.
describe("example components follow the test id and semantic root rules", () => {
  const starterSite = join(examplesDir, "starter-site");
  // The starter site's own config lists both component folders; the advisory reads the same list.
  const config = {
    default: { directory: { components: ["src/components", "../components"] } },
  };
  const componentFile = (name: string) =>
    readFileSync(join(examplesDir, `components/${name}/${name}.html`), "utf8");
  /** The first element of a component that is not a style, script, link, meta, or template tag, or a comment. */
  const rootTagOf = (source: string) =>
    source
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(style|script|template)\b[\s\S]*?<\/\1>/g, "")
      .match(/<(?!\/|link\b|meta\b)([a-z][a-z0-9-]*)/)?.[1];

  it("has a data-testid on every component root, interactive part, form, dialog, and landmark, and on every starter page's <main>", () => {
    const gaps = testIdAdvisory(starterSite, config).map(
      (gap: { file: string; line: number; message: string }) =>
        `${gap.file}:${gap.line} ${gap.message}`,
    );
    expect(gaps).toEqual([]);
  });

  it.each(componentNames)("%s names every data-testid after itself", (name) => {
    const ids = [
      ...componentFile(name).matchAll(/\bdata-testid="([^"]*)"/g),
    ].map((match) => match[1]);
    const misnamed = ids.filter(
      (id) => id !== name && !id.startsWith(`${name}-`),
    );
    expect(misnamed, `test ids in ${name} start with "${name}"`).toEqual([]);
    expect(new Set(ids).size, `duplicate test ids in ${name}`).toBe(ids.length);
  });

  it("roots each component in the element that fits its job", () => {
    expect(
      Object.fromEntries(
        componentNames.map((name) => [name, rootTagOf(componentFile(name))]),
      ),
    ).toEqual({
      "contact-form": "form",
      // An inline group: the button and its status message flow with the surrounding text.
      "copy-button": "span",
      // A list and its <search> controls; no element groups a search with its results.
      "filter-list": "div",
      // A fragment: the trigger in the page flow, then the <dialog> it opens.
      "modal-dialog": "button",
      "popover-menu": "button",
      "site-footer": "footer",
      // The skip link is the header's first child, so the <header> is the one root.
      "site-header": "header",
      // HTML has no tabs element: the root groups the tablist and its panels.
      "tab-group": "div",
      // Head-only: a <meta> and a script, no body root.
      "theme-init": undefined,
      "theme-toggle": "button",
    });
  });

  it("misuse: the root check reads past comments, styles, and head tags", () => {
    expect(
      rootTagOf(
        '<!-- <div> -->\n<style>.a { b: c }</style>\n<meta name="x" />\n<nav class="n"></nav>\n<script>x</script>',
      ),
    ).toBe("nav");
    expect(rootTagOf("<link rel=icon />\n<script>x</script>")).toBe(undefined);
  });
});
