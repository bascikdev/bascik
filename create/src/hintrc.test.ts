import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SOURCE_DIRECTORIES,
  HINT_SOURCE_ONLY,
  hintDistJson,
  hintReportLines,
  hintrcJson,
  mergeHintrc,
  parseJsonc,
  sourceUrlPattern,
  writeHintFiles,
} from "./vscode-settings.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

interface Hintrc {
  extends?: string[];
  hints?: Record<string, unknown>;
  ignoredUrls?: Array<{ domain: string; hints: string[] }>;
}

/** Whether webhint skips `hint` for a file, the way its engine tests `ignoredUrls`. */
function ignores(config: Hintrc, hint: string, fileUrl: string): boolean {
  return (config.ignoredUrls ?? []).some(
    (entry) =>
      (entry.hints.includes(hint) || entry.hints.includes("*")) &&
      new RegExp(entry.domain, "i").test(fileUrl),
  );
}

const DEFAULT_PATTERN = sourceUrlPattern(DEFAULT_SOURCE_DIRECTORIES)!;
const created = parseJsonc(hintrcJson(DEFAULT_SOURCE_DIRECTORIES)) as Hintrc;

describe("the .hintrc a Bascik project ships with", () => {
  it("extends webhint's development config and explains itself in a comment", () => {
    const text = hintrcJson(DEFAULT_SOURCE_DIRECTORIES);
    expect(created.extends).toEqual(["development"]);
    expect(text).toContain("//");
    expect(text).toContain("https://bascik.dev/testing/linting");
    expect(text).toContain(".hintrc.dist.json");
  });

  it("turns off the document title and image alt checks a build script or prop fills in", () => {
    expect(created.hints).toEqual({
      "axe/text-alternatives": [
        "default",
        { "document-title": "off", "image-alt": "off" },
      ],
    });
  });

  it("skips the charset and viewport hints on source pages and components only", () => {
    for (const hint of HINT_SOURCE_ONLY) {
      expect(
        ignores(created, hint, "file:///home/me/site/src/pages/index.html"),
      ).toBe(true);
      expect(
        ignores(
          created,
          hint,
          "file:///home/me/site/src/components/site-head/site-head.html",
        ),
      ).toBe(true);
      expect(
        ignores(created, hint, "file:///c:/Users/me/site/src/pages/a/b.html"),
      ).toBe(true);
    }
  });

  it("keeps every hint on for the built site in dist/", () => {
    for (const hint of HINT_SOURCE_ONLY) {
      expect(
        ignores(created, hint, "file:///home/me/site/dist/index.html"),
      ).toBe(false);
    }
  });

  it("misuse: a project under a folder named dist, e2e or coverage is still checked", () => {
    // The old repo pattern ".*(e2e|dist|...).*" matched the whole absolute path.
    expect(
      ignores(
        created,
        "meta-viewport",
        "file:///home/me/distro-site/dist/a.html",
      ),
    ).toBe(false);
    expect(
      ignores(
        created,
        "button-type",
        "file:///home/me/coverage/src/pages/a.html",
      ),
    ).toBe(false);
  });

  it("misuse: does not match a folder whose name only starts like the pages folder", () => {
    expect(
      ignores(
        created,
        "meta-viewport",
        "file:///home/me/site/src/pages-old/a.html",
      ),
    ).toBe(false);
    expect(
      ignores(created, "meta-viewport", "file:///home/me/site/src/pages/a.css"),
    ).toBe(false);
  });

  it("is valid JSON once its comments are removed, as webhint's jsonc reader sees it", () => {
    expect(created).toBeTypeOf("object");
  });

  it("says plainly that the editor no longer flags an <img> with no alt, and where it is caught", () => {
    const text = hintrcJson(DEFAULT_SOURCE_DIRECTORIES);
    expect(text).toContain("<img> with no alt");
    expect(text).toContain(".hintrc.dist.json");
  });

  it("builds the built-site command from the output folder", () => {
    expect(hintrcJson(DEFAULT_SOURCE_DIRECTORIES)).toContain(
      "npx hint -c .hintrc.dist.json $(find dist -name '*.html')",
    );
    const custom = hintrcJson({ ...DEFAULT_SOURCE_DIRECTORIES, out: "build" });
    expect(custom).toContain("$(find build -name '*.html')");
    expect(custom).not.toContain("find dist");
  });

  it("misuse: tidies an output folder written with ./, a trailing slash or a space", () => {
    expect(
      hintrcJson({ ...DEFAULT_SOURCE_DIRECTORIES, out: "./public/" }),
    ).toContain("$(find public -name '*.html')");
    expect(
      hintrcJson({ ...DEFAULT_SOURCE_DIRECTORIES, out: "site out" }),
    ).toContain("$(find 'site out' -name '*.html')");
  });
});

describe("sourceUrlPattern", () => {
  it("covers a custom pages folder and every components root", () => {
    const pattern = sourceUrlPattern({
      pages: "pages",
      components: ["src/components", "../shared/components"],
    })!;
    const re = new RegExp(pattern, "i");
    expect(re.test("file:///p/site/pages/index.html")).toBe(true);
    expect(re.test("file:///p/site/src/components/a/a.html")).toBe(true);
    expect(re.test("file:///p/shared/components/a/a.html")).toBe(true);
    expect(re.test("file:///p/site/dist/index.html")).toBe(false);
    // The pattern runs on the absolute URL, so "pages" also matches any other
    // folder named pages, such as src/pages. The docs say so.
    expect(re.test("file:///p/site/src/pages/index.html")).toBe(true);
  });

  it("misuse: escapes regex characters in folder names and accepts Windows separators", () => {
    const pattern = sourceUrlPattern({
      pages: ".\\site.v2\\pages",
      components: ["src/(ui)+"],
    })!;
    const re = new RegExp(pattern, "i");
    expect(re.test("file:///p/site.v2/pages/a.html")).toBe(true);
    expect(re.test("file:///p/siteXv2/pages/a.html")).toBe(false);
    expect(re.test("file:///p/src/(ui)+/a/a.html")).toBe(true);
  });

  it("misuse: drops a trailing slash and a leading ./", () => {
    expect(sourceUrlPattern({ pages: "./src/pages/", components: [] })).toBe(
      sourceUrlPattern({ pages: "src/pages", components: [] }),
    );
  });

  it("misuse: returns undefined when the pages folder is the project root", () => {
    expect(sourceUrlPattern({ pages: ".", components: [] })).toBeUndefined();
  });
});

describe("mergeHintrc", () => {
  it("writes the full file when there is none", () => {
    expect(mergeHintrc(undefined, DEFAULT_SOURCE_DIRECTORIES)).toEqual({
      status: "created",
      text: hintrcJson(DEFAULT_SOURCE_DIRECTORIES),
    });
    expect(mergeHintrc(" \n", DEFAULT_SOURCE_DIRECTORIES).status).toBe(
      "created",
    );
  });

  it("misuse: adds only what is missing to an existing file and keeps its comments and hints", () => {
    const existing = `{
  // team config
  "extends": ["web-recommended"],
  "hints": {
    "button-type": "off",
  },
}
`;
    const result = mergeHintrc(existing, DEFAULT_SOURCE_DIRECTORIES);
    expect(result.status).toBe("updated");
    expect(result.text).toContain("// team config");
    const parsed = parseJsonc(result.text) as Hintrc;
    expect(parsed.extends).toEqual(["web-recommended"]);
    expect(parsed.hints).toEqual({
      "axe/text-alternatives": [
        "default",
        { "document-title": "off", "image-alt": "off" },
      ],
      "button-type": "off",
    });
    expect(parsed.ignoredUrls).toEqual([
      { domain: DEFAULT_PATTERN, hints: HINT_SOURCE_ONLY },
    ]);
  });

  it("misuse: keeps the user's own axe/text-alternatives value and adds to their ignoredUrls", () => {
    const existing = JSON.stringify(
      {
        hints: { "axe/text-alternatives": "error" },
        ignoredUrls: [{ domain: "/e2e/", hints: ["*"] }],
      },
      null,
      2,
    );
    const parsed = parseJsonc(
      mergeHintrc(existing, DEFAULT_SOURCE_DIRECTORIES).text,
    ) as Hintrc;
    expect(parsed.hints).toEqual({ "axe/text-alternatives": "error" });
    expect(parsed.ignoredUrls).toEqual([
      { domain: DEFAULT_PATTERN, hints: HINT_SOURCE_ONLY },
      { domain: "/e2e/", hints: ["*"] },
    ]);
  });

  it("adds hints and ignoredUrls to an empty object", () => {
    const parsed = parseJsonc(
      mergeHintrc("{}", DEFAULT_SOURCE_DIRECTORIES).text,
    ) as Hintrc;
    expect(Object.keys(parsed).sort()).toEqual(["hints", "ignoredUrls"]);
  });

  it("fills an empty hints object and an empty ignoredUrls list", () => {
    const parsed = parseJsonc(
      mergeHintrc(
        '{ "hints": {}, "ignoredUrls": [] }',
        DEFAULT_SOURCE_DIRECTORIES,
      ).text,
    ) as Hintrc;
    expect(Object.keys(parsed.hints!)).toEqual(["axe/text-alternatives"]);
    expect(parsed.ignoredUrls).toHaveLength(1);
  });

  it("leaves a file that already has both entries alone, so running twice changes nothing", () => {
    const once = mergeHintrc(
      '{ "extends": ["development"] }',
      DEFAULT_SOURCE_DIRECTORIES,
    );
    expect(mergeHintrc(once.text, DEFAULT_SOURCE_DIRECTORIES)).toEqual({
      status: "unchanged",
      text: once.text,
    });
    const fresh = hintrcJson(DEFAULT_SOURCE_DIRECTORIES);
    expect(mergeHintrc(fresh, DEFAULT_SOURCE_DIRECTORIES).status).toBe(
      "unchanged",
    );
  });

  it("keeps a CRLF file on CRLF", () => {
    const result = mergeHintrc(
      '{\r\n  "extends": ["development"]\r\n}\r\n',
      DEFAULT_SOURCE_DIRECTORIES,
    );
    expect(result.text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("treats a file of only comments as empty and keeps the comments", () => {
    const result = mergeHintrc("// later\n", DEFAULT_SOURCE_DIRECTORIES);
    expect(result.status).toBe("updated");
    expect(result.text.startsWith("// later\n")).toBe(true);
    expect((parseJsonc(result.text) as Hintrc).extends).toEqual([
      "development",
    ]);
  });

  it("misuse: does not touch a file it cannot read as JSON, or an array", () => {
    expect(mergeHintrc("{ nope", DEFAULT_SOURCE_DIRECTORIES).status).toBe(
      "invalid",
    );
    expect(mergeHintrc("[]", DEFAULT_SOURCE_DIRECTORIES).status).toBe(
      "invalid",
    );
  });

  it("misuse: leaves hints or ignoredUrls of the wrong shape as they are and says what to add by hand", () => {
    const existing = '{ "hints": ["a"], "ignoredUrls": "x" }';
    const result = mergeHintrc(existing, DEFAULT_SOURCE_DIRECTORIES);
    expect(result.status).toBe("unchanged");
    expect(result.text).toBe(existing);
    expect(result.notes).toHaveLength(2);
    expect(result.notes![0]).toContain('"hints"');
    expect(result.notes![0]).toContain("axe/text-alternatives");
    expect(result.notes![1]).toContain('"ignoredUrls"');
    expect(result.notes![1]).toContain(JSON.stringify(DEFAULT_PATTERN));
  });

  it("misuse: adds the part it can to webhint's list form of hints, and notes the rest", () => {
    const result = mergeHintrc(
      '{ "hints": ["button-type"] }',
      DEFAULT_SOURCE_DIRECTORIES,
    );
    expect(result.status).toBe("updated");
    expect((parseJsonc(result.text) as Hintrc).ignoredUrls).toEqual([
      { domain: DEFAULT_PATTERN, hints: HINT_SOURCE_ONLY },
    ]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes![0]).toContain("axe/text-alternatives");
  });

  it("misuse: notes the charset and viewport hints an old config turned off for every file", () => {
    // The .hintrc the Bascik docs recommended before the scoped exceptions.
    const old = `{
  "extends": ["development"],
  "hints": { "meta-viewport": "off", "meta-charset-utf-8": ["off", {}] },
  "ignoredUrls": [
    { "domain": ".*(e2e|dist|test-results|coverage|hint-report).*", "hints": ["*"] }
  ]
}
`;
    const result = mergeHintrc(old, DEFAULT_SOURCE_DIRECTORIES);
    expect(result.status).toBe("updated");
    expect(result.notes).toHaveLength(1);
    expect(result.notes![0]).toContain("meta-viewport");
    expect(result.notes![0]).toContain("meta-charset-utf-8");
    expect(
      mergeHintrc(
        '{ "hints": { "meta-viewport": 0 } }',
        DEFAULT_SOURCE_DIRECTORIES,
      ).notes![0],
    ).toContain("meta-viewport");
    expect(
      mergeHintrc(
        '{ "hints": { "meta-viewport": "error" } }',
        DEFAULT_SOURCE_DIRECTORIES,
      ).notes,
    ).toBeUndefined();
  });

  it("adds to a one-line hints object without a double space", () => {
    const result = mergeHintrc(
      '{ "hints": { "button-type": "off" } }',
      DEFAULT_SOURCE_DIRECTORIES,
    );
    expect(result.text).toContain(
      '"hints": { "axe/text-alternatives": ["default", { "document-title": "off", "image-alt": "off" }], "button-type": "off" }',
    );
    expect(result.text).not.toMatch(/,  "/);
  });

  it("misuse: adds no ignoredUrls entry when the pages folder is the project root", () => {
    const parsed = parseJsonc(
      mergeHintrc(undefined, { pages: ".", components: [] }).text,
    ) as Hintrc;
    expect(parsed.ignoredUrls).toBeUndefined();
    expect(parsed.hints).toBeDefined();
  });
});

/**
 * The config webhint ends up with: local `./` parents first, their arrays
 * joined, the way webhint's composeConfig merges an `extends` chain.
 */
function composeLikeWebhint(
  config: Hintrc,
  local: Record<string, Hintrc>,
): Hintrc {
  const parents = (config.extends ?? [])
    .filter((name) => name.startsWith("./"))
    .map((name) => composeLikeWebhint(local[name.slice(2)], local));
  return [...parents, config].reduce<Hintrc>(
    (merged, next) => ({
      hints: { ...merged.hints, ...next.hints },
      ignoredUrls: [...(merged.ignoredUrls ?? []), ...(next.ignoredUrls ?? [])],
    }),
    {},
  );
}

describe("hintDistJson", () => {
  const dist = parseJsonc(hintDistJson()) as Hintrc & { formatters?: string[] };

  it("checks the built site on its own, with no source exceptions and no report folder", () => {
    expect(dist.extends).toEqual(["development"]);
    expect(dist.ignoredUrls).toBeUndefined();
    expect(dist.hints).toBeUndefined();
    // The development config adds the html formatter, which writes hint-report/.
    expect(dist.formatters).toEqual(["stylish"]);
    expect(hintDistJson()).toContain("//");
  });

  it("misuse: a built route named after a custom source folder is still checked", () => {
    const dirs = { pages: "pages", components: ["../components"] };
    const editor = parseJsonc(hintrcJson(dirs)) as Hintrc;
    const card = "file:///p/site/dist/components/card.html";
    // The editor pattern runs on the absolute URL, so it matches this route...
    expect(ignores(editor, "meta-viewport", card)).toBe(true);
    // ...and the dist check must not inherit it.
    const composed = composeLikeWebhint(dist, { ".hintrc": editor });
    for (const hint of HINT_SOURCE_ONLY) {
      expect(ignores(composed, hint, card)).toBe(false);
      expect(ignores(composed, hint, "file:///p/site/dist/pages/x.html")).toBe(
        false,
      );
    }
  });

  it("misuse: an old .hintrc that skips every hint in dist/ does not reach the dist check", () => {
    const old: Hintrc = {
      hints: { "meta-viewport": "off" },
      ignoredUrls: [
        {
          domain: ".*(e2e|dist|test-results|coverage|hint-report).*",
          hints: ["*"],
        },
      ],
    };
    const composed = composeLikeWebhint(dist, { ".hintrc": old });
    expect(
      ignores(composed, "button-type", "file:///p/site/dist/index.html"),
    ).toBe(false);
    expect(composed.hints).not.toHaveProperty("meta-viewport");
  });
});

describe("writeHintFiles", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  const temp = async () => {
    const dir = await mkdtemp(join(tmpdir(), "bascik-hintrc-"));
    dirs.push(dir);
    return dir;
  };

  it("creates .hintrc and .hintrc.dist.json in a new folder", async () => {
    const root = await temp();
    expect(await writeHintFiles(root)).toEqual({
      file: ".hintrc",
      config: "created",
      dist: "created",
    });
    expect(await readFile(join(root, ".hintrc"), "utf8")).toBe(
      hintrcJson(DEFAULT_SOURCE_DIRECTORIES),
    );
    expect(await readFile(join(root, ".hintrc.dist.json"), "utf8")).toBe(
      hintDistJson(),
    );
  });

  it("misuse: merges into an existing .hintrc and keeps an existing .hintrc.dist.json", async () => {
    const root = await temp();
    await writeFile(
      join(root, ".hintrc"),
      '{\n  // mine\n  "extends": ["development"]\n}\n',
    );
    await writeFile(
      join(root, ".hintrc.dist.json"),
      '{ "extends": ["web-recommended"] }\n',
    );
    expect(await writeHintFiles(root)).toEqual({
      file: ".hintrc",
      config: "updated",
      dist: "unchanged",
    });
    expect(await readFile(join(root, ".hintrc"), "utf8")).toContain("// mine");
    expect(await readFile(join(root, ".hintrc.dist.json"), "utf8")).toBe(
      '{ "extends": ["web-recommended"] }\n',
    );
  });

  it("misuse: merges into .hintrc.json instead of writing a .hintrc that would hide it", async () => {
    const root = await temp();
    await writeFile(
      join(root, ".hintrc.json"),
      '{ "extends": ["development"] }',
    );
    const report = await writeHintFiles(root);
    expect(report).toEqual({
      file: ".hintrc.json",
      config: "updated",
      dist: "created",
    });
    await expect(readFile(join(root, ".hintrc"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, ".hintrc.dist.json"), "utf8")).toBe(
      hintDistJson(),
    );
  });

  it("misuse: leaves a .hintrc.js or a package.json hintConfig alone, says so, and still writes the dist config", async () => {
    const js = await temp();
    await writeFile(join(js, ".hintrc.js"), "module.exports = {};\n");
    expect(await writeHintFiles(js)).toEqual({
      file: ".hintrc.js",
      config: "elsewhere",
      dist: "created",
    });
    expect(await readFile(join(js, ".hintrc.dist.json"), "utf8")).toBe(
      hintDistJson(),
    );
    const pkg = await temp();
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "x", hintConfig: { extends: ["development"] } }),
    );
    expect(await writeHintFiles(pkg)).toEqual({
      file: "package.json",
      config: "elsewhere",
      dist: "created",
    });
    await expect(readFile(join(pkg, ".hintrc"), "utf8")).rejects.toThrow();
  });

  it("a package.json without hintConfig does not stop .hintrc", async () => {
    const root = await temp();
    await writeFile(join(root, "package.json"), '{ "name": "x" }');
    expect((await writeHintFiles(root)).config).toBe("created");
  });

  it("misuse: leaves a broken .hintrc as it is, skips the dist file, and reports it", async () => {
    const root = await temp();
    await writeFile(join(root, ".hintrc"), "{ oops");
    expect(await writeHintFiles(root)).toEqual({
      file: ".hintrc",
      config: "invalid",
      dist: "skipped",
    });
    expect(await readFile(join(root, ".hintrc"), "utf8")).toBe("{ oops");
  });

  it("scopes the source hints to a custom pages folder", async () => {
    const root = await temp();
    await writeHintFiles(root, {
      pages: "site/pages",
      components: ["site/ui"],
    });
    const config = parseJsonc(
      await readFile(join(root, ".hintrc"), "utf8"),
    ) as Hintrc;
    expect(
      ignores(config, "meta-viewport", "file:///p/site/pages/a.html"),
    ).toBe(true);
    expect(ignores(config, "meta-viewport", "file:///p/src/pages/a.html")).toBe(
      false,
    );
  });

  it("misuse: passes on what the merge could not add", async () => {
    const root = await temp();
    await writeFile(join(root, ".hintrc"), '{ "hints": ["button-type"] }');
    const report = await writeHintFiles(root);
    expect(report.config).toBe("updated");
    expect(report.notes).toHaveLength(1);
    expect(hintReportLines(report)).toHaveLength(2);
  });

  it("misuse: reports, rather than throws, when .hintrc is a folder", async () => {
    const root = await temp();
    await mkdir(join(root, ".hintrc"));
    const report = await writeHintFiles(root);
    expect(report.config).toBe("failed");
    expect(report.dist).toBe("skipped");
  });
});

describe("hintReportLines", () => {
  it("stays quiet when the files were written fresh or already right", () => {
    expect(
      hintReportLines({ file: ".hintrc", config: "created", dist: "created" }),
    ).toEqual([]);
    expect(
      hintReportLines({
        file: ".hintrc",
        config: "unchanged",
        dist: "unchanged",
      }),
    ).toEqual([]);
  });

  it("names what it added to an existing file", () => {
    expect(
      hintReportLines({ file: ".hintrc", config: "updated", dist: "created" }),
    ).toEqual([
      ".hintrc: added the Bascik source-file exceptions (https://bascik.dev/testing/linting#editor-linters-read-source)",
    ]);
  });

  it("misuse: points at the docs when it could not or would not write the config", () => {
    const [invalid] = hintReportLines({
      file: ".hintrc",
      config: "invalid",
      dist: "skipped",
    });
    expect(invalid).toContain(
      ".hintrc: left as is because it is not valid JSON",
    );
    expect(invalid).toContain("#editor-linters-read-source");
    const [elsewhere] = hintReportLines({
      file: "package.json",
      config: "elsewhere",
      dist: "skipped",
    });
    expect(elsewhere).toContain('package.json "hintConfig"');
    expect(elsewhere).toContain("#editor-linters-read-source");
  });
});

describe("hintReportLines notes", () => {
  it("adds each note after the status line, and shows notes for an unchanged file too", () => {
    expect(
      hintReportLines({
        file: ".hintrc",
        config: "updated",
        dist: "created",
        notes: ["note a"],
      }),
    ).toEqual([
      ".hintrc: added the Bascik source-file exceptions (https://bascik.dev/testing/linting#editor-linters-read-source)",
      ".hintrc: note a",
    ]);
    expect(
      hintReportLines({
        file: ".hintrc",
        config: "unchanged",
        dist: "unchanged",
        notes: ["note b"],
      }),
    ).toEqual([".hintrc: note b"]);
  });
});

describe("the starter site example", () => {
  it("ships the .hintrc and .hintrc.dist.json npm create bascik writes", () => {
    const starter = resolve(HERE, "../../examples/starter-site");
    const config = parseJsonc(
      readFileSync(join(starter, ".hintrc"), "utf8"),
    ) as Hintrc;
    expect(config).toEqual(created);
    expect(readFileSync(join(starter, ".hintrc.dist.json"), "utf8")).toBe(
      hintDistJson(),
    );
  });
});
