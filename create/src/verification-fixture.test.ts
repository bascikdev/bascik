import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createVerificationFixture,
  browserVerificationFixture,
  withVerificationFixture,
} from "../e2e/verification-fixture.ts";

describe("verification fixture isolation and cleanup", () => {
  it("removes browser output recreated after Playwright global teardown", async () => {
    const previous = new Set(process.listeners("exit"));
    const fixture = await browserVerificationFixture("default");
    const cleanup = process
      .listeners("exit")
      .find((listener) => !previous.has(listener));
    try {
      expect(cleanup).toBeDefined();
      await fixture.dispose();
      await mkdir(join(fixture.root, "browser-results"), { recursive: true });
      await writeFile(
        join(fixture.root, "browser-results/.last-run.json"),
        "{}",
      );
      cleanup!(0);
      await expect(access(fixture.root)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (cleanup) process.off("exit", cleanup);
      await fixture.dispose();
    }
  }, 120_000);
  it("uses OS temp space and removes a successful fixture", async () => {
    let root = "";
    await withVerificationFixture("default", async (fixture) => {
      root = fixture.root;
      expect(dirname(root)).toBe(tmpdir());
      await access(fixture.site);
    });
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes a fixture when its validation fails", async () => {
    let root = "";
    const failure = new Error("intentional validation failure");
    await expect(
      withVerificationFixture("default", async (fixture) => {
        root = fixture.root;
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes a fixture when provisioning fails before validation", async () => {
    const prefix = "bascik-feedback-invalid-default-feedback-template-";
    const before = (await readdir(tmpdir())).filter((name) =>
      name.startsWith(prefix),
    );
    await expect(
      createVerificationFixture("invalid-default-feedback-template"),
    ).rejects.toThrow();
    expect(
      (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)),
    ).toEqual(before);
  });
});
