import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addComponents } from "./add.ts";
import { recursivelyTranspile } from "./processing.ts";

describe("bascik add", () => {
  let testDir: string;
  let componentsDir: string;
  let nodeModulesDir: string;
  let prevCwd: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    testDir = join(
      tmpdir(),
      `bascik-add-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    componentsDir = join(testDir, "src", "components");
    nodeModulesDir = join(testDir, "node_modules");

    await mkdir(componentsDir, { recursive: true });
    await mkdir(nodeModulesDir, { recursive: true });
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  const setupFixturePackage = async (
    pkgName: string,
    packageJsonContent: Record<string, unknown>,
    files: Record<string, string>,
  ) => {
    const pkgDir = join(nodeModulesDir, ...pkgName.split("/"));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify(packageJsonContent, null, 2),
      "utf8",
    );
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(pkgDir, relPath);
      await mkdir(join(fullPath, ".."), { recursive: true });
      await writeFile(fullPath, content, "utf8");
    }
    return pkgDir;
  };

  // 1. bascik add @acme/ui copies every component from a fixture package.
  it("copies every component from a fixture package", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button><slot></slot></button>",
        "components/button.css": "button { color: red; }",
        "components/card.html": "<div class=\"card\"><slot></slot></div>",
      },
    );

    const result = await addComponents(["@acme/ui"], { cwd: testDir });
    expect(result.copiedFiles.length).toBe(3);

    const buttonHtml = await readFile(
      join(componentsDir, "button.html"),
      "utf8",
    );
    expect(buttonHtml).toBe("<button><slot></slot></button>");
    const buttonCss = await readFile(
      join(componentsDir, "button.css"),
      "utf8",
    );
    expect(buttonCss).toBe("button { color: red; }");
    const cardHtml = await readFile(join(componentsDir, "card.html"), "utf8");
    expect(cardHtml).toBe("<div class=\"card\"><slot></slot></div>");
  });

  // 2. bascik add @acme/ui/card copies one.
  it("copies a single component when specified as @pkg/comp", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button><slot></slot></button>",
        "components/card.html": "<div class=\"card\"><slot></slot></div>",
        "components/card.css": ".card { border: 1px solid black; }",
      },
    );

    const result = await addComponents(["@acme/ui/card"], { cwd: testDir });
    expect(result.copiedFiles.length).toBe(2);

    const cardHtml = await readFile(join(componentsDir, "card.html"), "utf8");
    expect(cardHtml).toBe("<div class=\"card\"><slot></slot></div>");
    const cardCss = await readFile(join(componentsDir, "card.css"), "utf8");
    expect(cardCss).toBe(".card { border: 1px solid black; }");

    // Button should not have been copied
    await expect(
      readFile(join(componentsDir, "button.html"), "utf8"),
    ).rejects.toThrow();
  });

  // 3. A package with no bascik.components field fails with a publisher-actionable message.
  it("fails with a publisher-actionable message when package has no bascik.components field", async () => {
    await setupFixturePackage(
      "@acme/no-field",
      {
        name: "@acme/no-field",
        version: "1.0.0",
      },
      {
        "index.js": "export default {}",
      },
    );

    await expect(
      addComponents(["@acme/no-field"], { cwd: testDir }),
    ).rejects.toThrow(
      /package "@acme\/no-field" is missing a "bascik\.components" field in its package\.json/,
    );
  });

  // 4. A malformed field fails clearly.
  it("fails clearly when bascik.components field is malformed", async () => {
    await setupFixturePackage(
      "@acme/bad-shape",
      {
        name: "@acme/bad-shape",
        version: "1.0.0",
        bascik: { components: 123 },
      },
      {},
    );

    await expect(
      addComponents(["@acme/bad-shape"], { cwd: testDir }),
    ).rejects.toThrow(
      /"bascik\.components" field in "@acme\/bad-shape" must be a string/,
    );
  });

  // 5. A package that is not installed fails with an install hint.
  it("fails with an install hint when package is not installed", async () => {
    await expect(
      addComponents(["@acme/missing-pkg"], { cwd: testDir }),
    ).rejects.toThrow(
      /Package "@acme\/missing-pkg" is not installed\. Please install it first/,
    );
  });

  // 6. A name collision with an existing component refuses, naming both paths, and writes nothing.
  it("refuses when a component name collides with an existing component, naming both paths, and writes nothing", async () => {
    await writeFile(
      join(componentsDir, "card.html"),
      "<div>local card</div>",
      "utf8",
    );

    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/card.html": "<div>pkg card</div>",
        "components/button.html": "<button>btn</button>",
      },
    );

    await expect(
      addComponents(["@acme/ui"], { cwd: testDir }),
    ).rejects.toThrow(/error: component name collision for <card>/);

    // Assert button was not copied (atomic refusal, nothing written)
    await expect(
      readFile(join(componentsDir, "button.html"), "utf8"),
    ).rejects.toThrow();

    // Assert local card was not modified
    const cardContent = await readFile(join(componentsDir, "card.html"), "utf8");
    expect(cardContent).toBe("<div>local card</div>");
  });

  // 7. The collision check uses listComponents' derivation, proven by a subfolder case where naive basename logic would disagree.
  it("uses listComponents derivation for collision check in subfolder case", async () => {
    // In Bascik, src/components/marketing/card.html derives tag <card>
    const subfolder = join(componentsDir, "marketing");
    await mkdir(subfolder, { recursive: true });
    await writeFile(
      join(subfolder, "card.html"),
      "<div>marketing card</div>",
      "utf8",
    );

    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/admin/card.html": "<div>admin card</div>",
      },
    );

    // Naive relative path collision would check "admin/card.html" vs "marketing/card.html" (no file path collision)
    // But listComponents derives <card> for both, which must collide!
    await expect(
      addComponents(["@acme/ui"], { cwd: testDir }),
    ).rejects.toThrow(/collision for <card>/);
  });

  // 8. The lockfile records package, version, files, and per-file hashes.
  it("records package, version, files, and per-file hashes in lockfile", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.2.3",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>Click</button>",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir });

    const lockRaw = await readFile(join(testDir, "bascik-lock.json"), "utf8");
    const lock = JSON.parse(lockRaw);

    expect(lock.components).toBeDefined();
    expect(lock.components["@acme/ui"]).toBeDefined();
    expect(lock.components["@acme/ui"].version).toBe("1.2.3");
    expect(lock.components["@acme/ui"].files["button.html"]).toBeDefined();
    expect(lock.components["@acme/ui"].files["button.html"].hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  // 9. Re-adding an unmodified file overwrites cleanly.
  it("overwrites cleanly when re-adding an unmodified file", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v1</button>",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir });

    // Update package to v2 with updated file
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "2.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v2</button>",
      },
    );

    // Re-add without force: local file was not modified since v1 add, so it should cleanly update
    await addComponents(["@acme/ui"], { cwd: testDir });
    const buttonHtml = await readFile(
      join(componentsDir, "button.html"),
      "utf8",
    );
    expect(buttonHtml).toBe("<button>v2</button>");
  });

  // 10. Re-adding a locally modified file refuses, naming it.
  it("refuses when re-adding a locally modified file without --force, naming the file", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v1</button>",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir });

    // Modify local file
    await writeFile(
      join(componentsDir, "button.html"),
      "<button>customized</button>",
      "utf8",
    );

    // Update package to v2
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "2.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v2</button>",
      },
    );

    await expect(
      addComponents(["@acme/ui"], { cwd: testDir }),
    ).rejects.toThrow(/button\.html.*modified locally/);

    const buttonHtml = await readFile(
      join(componentsDir, "button.html"),
      "utf8",
    );
    expect(buttonHtml).toBe("<button>customized</button>");
  });

  // 11. --force overwrites a modified file.
  it("overwrites a locally modified file when --force is used", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v1</button>",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir });

    // Modify local file
    await writeFile(
      join(componentsDir, "button.html"),
      "<button>customized</button>",
      "utf8",
    );

    // Update package to v2
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "2.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>v2</button>",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir, force: true });
    const buttonHtml = await readFile(
      join(componentsDir, "button.html"),
      "utf8",
    );
    expect(buttonHtml).toBe("<button>v2</button>");
  });

  // 12. --dry-run writes nothing and lists everything.
  it("writes nothing and lists operations when --dry-run is specified", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/button.html": "<button>Click</button>",
      },
    );

    const result = await addComponents(["@acme/ui"], {
      cwd: testDir,
      dryRun: true,
    });
    expect(result.copiedFiles.length).toBe(1);

    await expect(
      readFile(join(componentsDir, "button.html"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(testDir, "bascik-lock.json"), "utf8"),
    ).rejects.toThrow();
  });

  // 13. A ../ in a package file path is rejected and nothing is written outside the components directory.
  it("rejects path traversal with ../ in package file path and writes nothing", async () => {
    await setupFixturePackage(
      "@acme/evil",
      {
        name: "@acme/evil",
        version: "1.0.0",
        bascik: { components: "../../outside" },
      },
      {},
    );

    await expect(
      addComponents(["@acme/evil"], { cwd: testDir }),
    ).rejects.toThrow(/Path traversal detected/);

    await expect(readFile(join(testDir, "evil.html"), "utf8")).rejects.toThrow();
  });

  // 14. A mid-copy failure leaves no partial state.
  it("leaves no partial state if a failure occurs mid-copy", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/btn.html": "<button>1</button>",
        "components/card.html": "<div>2</div>",
      },
    );

    // Make card destination a directory so writing to card.html fails with EISDIR
    await mkdir(join(componentsDir, "card.html"), { recursive: true });

    await expect(
      addComponents(["@acme/ui"], { cwd: testDir }),
    ).rejects.toThrow();

    // btn.html must NOT remain on disk
    await expect(
      readFile(join(componentsDir, "btn.html"), "utf8"),
    ).rejects.toThrow();

    // Lockfile must NOT be written
    await expect(
      readFile(join(testDir, "bascik-lock.json"), "utf8"),
    ).rejects.toThrow();
  });

  // 15. Non-TTY execution never blocks on stdin.
  it("executes without prompting or blocking on stdin in non-TTY mode", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/badge.html": "<span>badge</span>",
      },
    );

    // Call without force/yes in non-interactive environment - should succeed or fail without hanging
    const result = await addComponents(["@acme/ui"], {
      cwd: testDir,
      isTTY: false,
    });
    expect(result.copiedFiles.length).toBe(1);
  });

  // 16. After a successful add, bascik --build succeeds and the copied component renders.
  it("succeeds in bascik --build after an add and renders the copied component", async () => {
    await setupFixturePackage(
      "@acme/ui",
      {
        name: "@acme/ui",
        version: "1.0.0",
        bascik: { components: "./components" },
      },
      {
        "components/fancy-button.html": "<button class=\"btn\"><div data-bascik-slot></div></button>",
        "components/fancy-button.css": ".btn { background: blue; }",
      },
    );

    await addComponents(["@acme/ui"], { cwd: testDir });

    const fancyButtonHtml = await readFile(join(componentsDir, "fancy-button.html"), "utf8");
    const fancyButtonCss = await readFile(join(componentsDir, "fancy-button.css"), "utf8");

    const pageSource = "<!DOCTYPE html><html><body><fancy-button>Click Me</fancy-button></body></html>";
    const componentList = {
      "fancy-button": {
        fileContent: fancyButtonHtml,
        cssFileContent: fancyButtonCss,
      },
    };

    const result = recursivelyTranspile(pageSource, componentList);

    expect(result.transpiledHtmlBody).toContain("Click Me");
    expect(result.transpiledHtmlBody).toContain("bascik__fancy-button__btn");
    expect(result.usedComponents.length).toBe(1);
  });
});
