/**
 * listComponents against two real component roots in a temp directory.
 *
 * Pins prompt 80's multi-root rules: every listed root is scanned, and a
 * duplicate filename across roots is the same collision error as a duplicate
 * across subfolders, with both paths named.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { configState } = vi.hoisted(() => ({
  configState: {
    directory: { pages: "", components: [] as string[], out: "" },
    scoping: { deduplicateCss: true, preserve: [] as string[] },
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

let base: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bascik-multi-root-")));
  configState.directory.pages = join(base, "site/src/pages");
  configState.directory.out = join(base, "site/dist");
  configState.directory.components = [join(base, "shared/components"), join(base, "site/src/components")];
  mkdirSync(join(base, "shared/components"), { recursive: true });
  mkdirSync(join(base, "site/src/components"), { recursive: true });
  invalidateComponentListCache();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
  warnSpy.mockRestore();
  invalidateComponentListCache();
  rmSync(base, { recursive: true, force: true });
});

describe("listComponents with multiple roots", () => {
  it("discovers components in every configured root", async () => {
    writeFileSync(join(base, "shared/components/hello-card.html"), "<div>shared</div>");
    writeFileSync(join(base, "site/src/components/local-card.html"), "<div>local</div>");

    const list = await listComponents();
    expect(Object.keys(list).sort()).toEqual(["hello-card", "local-card"]);
    expect(list["hello-card"].fileName).toBe(join(base, "shared/components/hello-card.html"));
    expect(list["local-card"].fileName).toBe(join(base, "site/src/components/local-card.html"));
  });

  it("throws the collision error naming both paths when two roots define the same tag", async () => {
    writeFileSync(join(base, "shared/components/hello-card.html"), "<div>shared</div>");
    writeFileSync(join(base, "site/src/components/hello-card.html"), "<div>local</div>");

    await expect(listComponents()).rejects.toThrow(
      new RegExp(
        `two component files both define the tag <hello-card>[\\s\\S]*` +
        `shared/components/hello-card.html[\\s\\S]*site/src/components/hello-card.html[\\s\\S]*directory\\.components`,
      ),
    );
  });
});
