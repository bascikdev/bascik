// Unit tests for the examples bundle (examples-bundle.ts), the page helpers (src/lib/examples.ts), and a guard that
// every example component is documented and exercised. Browser behavior is in e2e/examples.spec.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
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

type ParsedElement = DefaultTreeAdapterTypes.Element;
const isParsedElement = (
  node: DefaultTreeAdapterTypes.ChildNode,
): node is ParsedElement => "tagName" in node;
/** Every element under `parent` in document order, `<template>` contents included. */
const parsedElementsOf = (
  parent: DefaultTreeAdapterTypes.ParentNode,
): ParsedElement[] =>
  parent.childNodes
    .filter(isParsedElement)
    .flatMap((element) => [
      element,
      ...parsedElementsOf(
        element.tagName === "template"
          ? (element as DefaultTreeAdapterTypes.Template).content
          : element,
      ),
    ]);

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
  /** Tags that are never a component's root: head content and inert or raw-text elements. */
  const NOT_ROOTS = new Set(["style", "script", "template", "link", "meta"]);
  /** The first element of a component that is not a style, script, link, meta, or template tag, as the parser reads it. */
  const rootTagOf = (source: string) =>
    parseFragment(source).childNodes.find(
      (node): node is ParsedElement =>
        isParsedElement(node) && !NOT_ROOTS.has(node.tagName),
    )?.tagName;

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

  it("misuse: a comment opener inside a script does not hide the root after it", () => {
    expect(
      rootTagOf(
        '<script>const open = "<!--";</script>\n<nav data-testid="x"></nav>\n<!-- note -->',
      ),
    ).toBe("nav");
    expect(rootTagOf("<template><div></div></template>\n<form></form>")).toBe(
      "form",
    );
  });
});

// TypeScript by default (.github/copilot-instructions.md): every script in the examples, browser or build time,
// is TypeScript, so a copied example starts typed. An unmarked inline block runs as JavaScript.
describe("example scripts are TypeScript", () => {
  const htmlFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".html") &&
          !/[\\/](node_modules|dist)([\\/]|$)/.test(entry.parentPath),
      )
      .map((entry) => join(entry.parentPath, entry.name));
  /** Script open tags, as written, that would run as JavaScript: no TypeScript type, no .ts src, and not a data block. */
  const javaScriptTags = (source: string): string[] =>
    parsedElementsOf(parse(source, { sourceCodeLocationInfo: true }))
      .filter((element) => {
        if (element.tagName !== "script") return false;
        const attribute = (name: string) =>
          element.attrs.find((attr) => attr.name === name)?.value;
        const type = attribute("type")?.toLowerCase();
        if (type === "text/typescript") return false;
        if (type && type !== "module" && !type.includes("javascript"))
          return false;
        return !/\.m?ts$/i.test(attribute("src") ?? "");
      })
      .map((element) => {
        const { startOffset, endOffset } =
          element.sourceCodeLocation!.startTag!;
        return source.slice(startOffset, endOffset);
      });

  it("marks every inline script in the example components and the starter site as TypeScript", () => {
    const untyped = htmlFiles(examplesDir).flatMap((file) =>
      javaScriptTags(readFileSync(file, "utf8")).map(
        (tag) => `${relative(examplesDir, file)}: ${tag}`,
      ),
    );
    expect(untyped).toEqual([]);
  });

  it("misuse: counts a build script, a module, and a JavaScript src as JavaScript, and skips data blocks and comments", () => {
    expect(
      javaScriptTags(
        [
          "<script data-bascik-build>x</script>",
          '<script type="module">x</script>',
          '<script src="/app.js"></script>',
          '<script type="text/typescript" data-bascik-build>x</script>',
          '<script data-bascik-build src="./nav.ts"></script>',
          '<script type="application/ld+json">{}</script>',
          "<!-- <script>old</script> -->",
        ].join("\n"),
      ),
    ).toEqual([
      "<script data-bascik-build>",
      '<script type="module">',
      '<script src="/app.js">',
    ]);
  });

  it("misuse: finds a script after a comment opener written inside another script, and one inside a template", () => {
    expect(
      javaScriptTags(
        [
          '<script type="text/typescript">document.write("<!--");</script>',
          '<script src="/app.js"></script>',
          "<!-- note -->",
          "<template><script>inTemplate()</script></template>",
        ].join("\n"),
      ),
    ).toEqual(['<script src="/app.js">', "<script>"]);
  });
});
