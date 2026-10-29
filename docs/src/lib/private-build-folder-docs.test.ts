/**
 * Bascik's private build folder lives beside the output directory
 * (`.bascik/dist/`), never in it, so a static deploy of `dist/` never
 * publishes the ownership inventory, the build state or the server-script
 * sidecar (Collin 2026-10-29: bascik.dev served /.bascik/ownership.json).
 *
 * - The deployment pages say what a static host receives, what a server
 *   deploy copies, and what a Cloudflare target deploys.
 * - No page names a private file at its old place inside dist/.
 * - The FAQ explains the folder, and links to it land.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DOCS = path.resolve(import.meta.dirname, "../..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const plain = (md: string): string => md.replace(/`/g, "");

const listMd = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? listMd(full)
      : name.endsWith(".md")
        ? [full]
        : [];
  });

/** The text under a heading up to the next heading of the same or a higher level. */
const sectionOf = (md: string, heading: RegExp): string => {
  const lines = md.split("\n");
  const start = lines.findIndex((line) => {
    const m = line.match(/^(#{2,4}) (.+)$/);
    return m !== null && heading.test(plain(m[2]));
  });
  if (start === -1) return "";
  const level = lines[start].match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const m = line.match(/^(#+) /);
    return m !== null && m[1].length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
};

describe("what a static host receives", () => {
  const index = read("content/deployment/index.md");
  const section = sectionOf(index, /^What a static host receives$/);

  it("the Deployment Overview has the section, under What's in dist/", () => {
    expect(section).not.toBe("");
    expect(sectionOf(index, /^What's in dist\/$/)).toContain(
      "### What a static host receives",
    );
  });

  it("says dist/ is all a static host gets, and the private folder sits beside it", () => {
    const text = plain(section);
    expect(text).toMatch(/\.bascik\/dist\//);
    expect(text).toMatch(/beside dist\//);
    expect(text).toMatch(/ownership\.json/);
    expect(text).toMatch(/server-scripts\.json/);
    expect(text).toMatch(/dotfiles included/i);
  });

  it("says a bascik --server deploy copies both folders, and a Cloudflare target deploys its own folder", () => {
    const text = plain(section);
    expect(text).toMatch(/bascik --server[^.]*both/);
    expect(text).toMatch(/dist\/\.bascik\/cloudflare/);
  });

  it("says both folders come from the same build, that a changed page warns, and what still refuses", () => {
    const text = plain(section);
    expect(text).toMatch(
      /both dist\/ and \.bascik\/dist\/ from the same build/,
    );
    // A page that differs from the build record is a warning: a deploy
    // step may edit dist/ after the build. Only a server script the
    // private folder cannot run stops the server.
    expect(text).toMatch(/differs from that record[\s\S]{0,120}warning/);
    expect(text).toMatch(/edits dist\/ after the build/);
    expect(text).toMatch(
      /refuses to start only when it cannot run[\s\S]{0,300}server-script placeholder the sidecar does not hold/,
    );
    expect(text).not.toMatch(
      /page changed after the build counts as a different build/,
    );
  });

  it("says a --target build puts the Worker inside dist/, so dist/ is then not for a static host", () => {
    const text = plain(section);
    expect(text).toMatch(/dist\/\.bascik\/<target>\//);
    expect(text).toMatch(
      /do not point a static host at dist\/ after a --target build/,
    );
    const hosting = plain(read("content/deployment/static-hosting.md"));
    expect(hosting).not.toMatch(/^dist\/ holds only the site/m);
    expect(hosting).toMatch(
      /Do not point a static host at dist\/ after a --target build/,
    );
  });

  it("static hosting and the production server pages point there", () => {
    for (const rel of [
      "content/deployment/static-hosting.md",
      "content/production-server.md",
    ])
      expect(read(rel), rel).toContain(
        "/deployment#what-a-static-host-receives",
      );
  });
});

describe("no page names a private file inside dist/", () => {
  it("every page names .bascik/dist/<file>, never dist/.bascik/<file>", () => {
    const stale =
      /dist\/\.bascik\/(server-scripts|components|csp-hashes|manifest|ownership|build-state)\.json/;
    const offenders = listMd(path.join(DOCS, "content"))
      .filter((file) => stale.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(DOCS, file));
    expect(offenders).toEqual([]);
  });

  it("the FAQ explains the folder under a stable heading", () => {
    const faq = sectionOf(
      read("content/faq.md"),
      /^What is the \.bascik\/ folder\?$/,
    );
    expect(plain(faq)).toMatch(/beside dist\//);
    expect(plain(faq)).toMatch(/\.gitignore/);
    expect(plain(faq)).toMatch(/dist\/\.bascik\/<target>\//);
    for (const file of listMd(path.join(DOCS, "content")))
      expect(readFileSync(file, "utf8"), file).not.toContain(
        "faq#what-is-distbascik",
      );
  });
});
