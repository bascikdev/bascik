import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { scaffold } from "../src/scaffold.ts";
import { templateNamed } from "../src/templates.ts";

const run = promisify(execFile);
export const repositoryRoot = resolve(import.meta.dirname, "../..");
export interface VerificationFixture {
  root: string;
  site: string;
  dispose(): Promise<void>;
}

export async function removeVerificationFixture(root: string): Promise<void> {
  if (
    dirname(root) !== tmpdir() ||
    !basename(root).startsWith("bascik-feedback-")
  )
    throw new Error(
      `Refusing to remove a non-temporary verification path: ${root}`,
    );
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

/** Fresh sources and build output never enter create/src or packaged create/dist. */
export async function createVerificationFixture(
  name: string,
  build = false,
): Promise<VerificationFixture> {
  const root = await mkdtemp(join(tmpdir(), `bascik-feedback-${name}-`));
  const fixture = {
    root,
    site: join(root, name),
    dispose: () => removeVerificationFixture(root),
  };
  try {
    const template = templateNamed(name);
    if (!template) throw new Error(`Unknown verification template: ${name}`);
    await scaffold(name, root, { template });
    // Junctions do not require symlink privileges on Windows.
    await symlink(
      await realpath(join(repositoryRoot, "node_modules")),
      join(fixture.site, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    if (build) {
      await run(
        process.execPath,
        [join(repositoryRoot, "pkg/bin/bascik.js"), "--build"],
        {
          cwd: fixture.site,
          env: {
            ...process.env,
            BASCIK_SITE_URL: `https://${name}.example`,
            NO_COLOR: "1",
          },
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    }
    return fixture;
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
}

export async function withVerificationFixture<T>(
  name: string,
  action: (fixture: VerificationFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createVerificationFixture(name);
  try {
    return await action(fixture);
  } finally {
    await fixture.dispose();
  }
}

/** Playwright workers inherit the same path, rather than creating extra fixtures. */
export async function browserVerificationFixture(
  name: string,
): Promise<VerificationFixture> {
  const key = `BASCIK_FEEDBACK_${name.toUpperCase()}_ROOT`;
  const cached = process.env[key];
  if (cached && existsSync(join(cached, name, "dist/index.html"))) {
    return {
      root: cached,
      site: join(cached, name),
      dispose: () => removeVerificationFixture(cached),
    };
  }
  const fixture = await createVerificationFixture(name, true);
  // --list and discovery/config errors can exit without Playwright globalTeardown.
  // Playwright also writes .last-run.json after globalTeardown has removed output.
  // Only the allocating process owns this fallback, never an inheriting worker.
  process.once("exit", () => {
    rmSync(fixture.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  process.env[key] = fixture.root;
  return fixture;
}
