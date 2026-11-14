/**
 * Misuse of the corporate template's data, against the real CLI: each test
 * scaffolds the site into a temporary folder, makes one mistake a site owner
 * could make, and checks the build (or the link audit) names it.
 *
 * The happy path (the site builds and passes `bascik --check` and the audits,
 * with every adapter) is the template matrix in scaffold.integration.test.ts.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { scaffold } from "../scaffold.js";
import { CORPORATE_TEMPLATE } from "./corporate.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const PKG_CLI = join(REPO_ROOT, "pkg/bin/bascik.js");
const CHECK_LINKS = join(REPO_ROOT, "skills/bascik/scripts/check-links.mjs");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A scaffolded corporate site in its own temporary folder, with Bascik linked in. */
async function corporateSite(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "bascik-corporate-test-"));
  tempDirs.push(parent);
  await scaffold("book-company", parent, { template: CORPORATE_TEMPLATE });
  const project = join(parent, "book-company");
  const scope = join(project, "node_modules", "@bascik");
  await mkdir(scope, { recursive: true });
  await symlink(join(REPO_ROOT, "pkg"), join(scope, "bascik"), "dir");
  return project;
}

/** Replace one piece of a generated file, failing when the piece is not there exactly once. */
async function edit(
  project: string,
  path: string,
  from: string,
  to: string,
): Promise<void> {
  const file = join(project, ...path.split("/"));
  const source = await readFile(file, "utf8");
  expect(source.split(from), `${path} has "${from}" once`).toHaveLength(2);
  await writeFile(
    file,
    source.replace(from, () => to),
    "utf8",
  );
}

interface RunResult {
  output: string;
  exitCode: number;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        NO_COLOR: "1",
        BASCIK_SITE_URL: "https://example.com",
      },
      timeout: 90_000,
    });
    return { output: `${stdout}\n${stderr}`, exitCode: 0 };
  } catch (err: unknown) {
    const failed = err as { stdout?: string; stderr?: string; code?: number };
    return {
      output: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`,
      exitCode: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

const build = (project: string): Promise<RunResult> =>
  run([PKG_CLI, "--build"], project);

describe("corporate template misuse, with the real CLI", () => {
  it("builds a page for a service added to the data, and links it from the menu, with no other edit", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/lib/services.ts",
      `    {
      slug: "manuscript-editing",`,
      `    {
      slug: "audiobook-production",
      name: "Audiobook production & <narration>",
      summary:
        "Casting, recording and mastering for audiobook stores, with a narrator matched to the voice of your book.",
      description: "A producer runs the recording from casting to the final files.",
      includes: ["A narrator shortlist"],
      steps: [{ title: "Casting", text: "You choose from three sample readings." }],
      turnaround: "Six weeks.",
    },
    {
      slug: "manuscript-editing",`,
    );
    const result = await build(project);
    expect(result.exitCode, result.output).toBe(0);
    const page = await readFile(
      join(project, "dist/services/audiobook-production.html"),
      "utf8",
    );
    // The name is data: it reaches the heading, the title and the breadcrumb escaped.
    expect(page).toContain("Audiobook production &amp; &lt;narration&gt;</h1>");
    expect(page).not.toContain("<narration>");
    expect(page).toContain(
      '<link rel="canonical" href="https://example.com/services/audiobook-production"',
    );
    const home = await readFile(join(project, "dist/index.html"), "utf8");
    expect(home).toContain('href="/services/audiobook-production"');
    expect(await readFile(join(project, "dist/sitemap.xml"), "utf8")).toContain(
      "https://example.com/services/audiobook-production",
    );
  }, 120_000);

  it("fails the build, naming the service and the field, when a service has no summary", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/lib/services.ts",
      `      summary:
        "A cover that reads at thumbnail size and pages that are comfortable to read, in print and e-book formats.",
`,
      "",
    );
    const result = await build(project);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      'services[1] ("book-design"): "summary" is missing or empty. Fill it in src/lib/services.ts.',
    );
    expect(existsSync(join(project, "dist/services/book-design.html"))).toBe(
      false,
    );
  }, 120_000);

  it("fails the build, naming the slug and both entries, when two services share a slug", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/lib/services.ts",
      'slug: "distribution",',
      'slug: "manuscript-editing",',
    );
    const result = await build(project);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      'services[2]: the slug "manuscript-editing" is already used by services[0].',
    );
  }, 120_000);

  it("fails the build, naming the role and the field, when an open role has an empty title", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/components/role-list/roles.ts",
      'title: "Production designer",',
      'title: "  ",',
    );
    const result = await build(project);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      'roles[1] ("production-designer"): "title" is missing or empty. Fill it in src/components/role-list/roles.ts.',
    );
  }, 120_000);

  it("fails the build, naming the entry, when a news date is not a real day", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/components/news-list/news.ts",
      'date: "2026-08-19",',
      'date: "2026-02-30",',
    );
    const result = await build(project);
    expect(result.exitCode, result.output).not.toBe(0);
    expect(result.output).toContain(
      'news ("debut-prize-shortlist"): the date "2026-02-30" is not a real day',
    );
  }, 120_000);

  it("is caught by the link audit over dist/ when a navigation entry points at a page that does not exist", async () => {
    const project = await corporateSite();
    await edit(
      project,
      "src/lib/navigation.ts",
      '{ label: "About", href: "/about" },\n  { label: "Careers"',
      '{ label: "About", href: "/about" },\n  { label: "Pricing", href: "/pricing" },\n  { label: "Careers"',
    );
    // The build itself has no opinion on a link; the link audit over dist/ is what catches it.
    const result = await build(project);
    expect(result.exitCode, result.output).toBe(0);
    const audit = await run([CHECK_LINKS], project);
    expect(audit.exitCode, audit.output).not.toBe(0);
    expect(audit.output).toContain("/pricing");
  }, 120_000);
});
