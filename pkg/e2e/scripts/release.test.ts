import { describe, expect, it } from "vitest";
import { release } from "../../../.github/scripts/release.mjs";

const SHA = "a".repeat(40);

function fixture({
  existing = false,
  failed = false,
  pending = false,
  unavailable = false,
  npmAuthFailure = false,
  version = "1.2.3",
} = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  let clock = 0;
  let runChecks = 0;
  let registryChecks = 0;
  const dependencies = {
    run(command: string, args: string[]): string {
      calls.push([command, ...args]);
      if (command === "git") {
        if (args[0] === "remote") return "git@github.com:bascikdev/bascik.git";
        if (args[0] === "rev-parse") return SHA;
        if (args[0] === "show") {
          expect(args[1]).toMatch(new RegExp(`^${SHA}:`));
          return JSON.stringify({ name: "test-package", version });
        }
        if (args[0] === "ls-remote")
          return existing ? `${SHA}\trefs/tags/v1.2.3` : "";
        return "";
      }
      if (args[0] === "auth") return "";
      if (command === "npm" && args[0] === "whoami") {
        if (npmAuthFailure) throw new Error("npm auth missing");
        return "test-user";
      }
      if (command === "npm" && args[0] === "dist-tag") return "";
      expect(args.slice(0, 2)).toEqual(["run", "list"]);
      runChecks++;
      return JSON.stringify([
        {
          databaseId: 99,
          headSha: "b".repeat(40),
          status: "completed",
          conclusion: "success",
        },
        {
          databaseId: 123,
          headSha: SHA,
          status: pending || runChecks % 2 ? "in_progress" : "completed",
          conclusion: failed ? "failure" : "success",
        },
      ]);
    },
    async pause(ms: number) {
      clock += ms;
    },
    now: () => clock,
    async registry(name: string, registryVersion: string) {
      expect(name).toBe("test-package");
      expect(registryVersion).toBe(version);
      registryChecks++;
      calls.push(["registry"]);
      return !unavailable && registryChecks % 2 === 0;
    },
    log: (message: string) => logs.push(message),
  };
  return { dependencies, calls, logs };
}

describe("release script", () => {
  it("executes by default, reads pinned main versions and waits between stages", async () => {
    const { dependencies, calls } = fixture();
    await release([], dependencies);
    const pushes = calls.filter((call) => call[1] === "push");
    expect(pushes).toEqual([
      [
        "git",
        "push",
        "--atomic",
        "origin",
        `${SHA}:refs/tags/lsp-v1.2.3`,
        `${SHA}:refs/tags/v1.2.3`,
      ],
      [
        "git",
        "push",
        "--atomic",
        "origin",
        `${SHA}:refs/tags/create-v1.2.3`,
        `${SHA}:refs/tags/adapter-cloudflare-v1.2.3`,
      ],
      ["git", "push", "--atomic", "origin", `${SHA}:refs/tags/ext-v1.2.3`],
    ]);
    const first = calls.indexOf(pushes[0]);
    const second = calls.indexOf(pushes[1]);
    const third = calls.indexOf(pushes[2]);
    expect(
      calls.slice(first, second).filter((call) => call[0] === "registry"),
    ).toHaveLength(4);
    expect(
      calls.slice(second, third).filter((call) => call[0] === "registry"),
    ).toHaveLength(4);
    expect(calls.slice(third).some((call) => call[0] === "registry")).toBe(
      false,
    );
  });

  it("previews selected packages without pushing or checking Actions", async () => {
    const { dependencies, calls, logs } = fixture();
    await release(["--dry-run", "pkg"], dependencies);
    expect(
      calls.every(
        (call) =>
          call[0] === "git" &&
          ["remote", "fetch", "show", "rev-parse"].includes(call[1]),
      ),
    ).toBe(true);
    expect(logs).toContain(`git push --atomic origin ${SHA}:refs/tags/v1.2.3`);
  });

  it("selects the extension pre-release channel explicitly", async () => {
    const { dependencies, calls } = fixture();
    await release(["extension", "--extension-pre"], dependencies);
    expect(calls).toContainEqual([
      "git",
      "push",
      "--atomic",
      "origin",
      `${SHA}:refs/tags/ext-pre-v1.2.3`,
    ]);
  });

  it("promotes selected npm RCs to latest only when explicitly requested", async () => {
    const defaultRelease = fixture({ version: "1.2.3-rc.1" });
    await release(["pkg"], defaultRelease.dependencies);
    expect(defaultRelease.calls.some((call) => call[1] === "dist-tag")).toBe(
      false,
    );

    const promotedRelease = fixture({ version: "1.2.3-rc.1" });
    await release(["pkg", "--promote-rc-latest"], promotedRelease.dependencies);
    expect(promotedRelease.calls).toContainEqual([
      "npm",
      "dist-tag",
      "add",
      "test-package@1.2.3-rc.1",
      "latest",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    const registryIndex = promotedRelease.calls.findIndex(
      (call) => call[0] === "registry",
    );
    const distTagIndex = promotedRelease.calls.findIndex(
      (call) => call[1] === "dist-tag",
    );
    expect(distTagIndex).toBeGreaterThan(registryIndex);
  });

  it("checks npm authentication before pushing tags when RC promotion is requested", async () => {
    const { dependencies, calls } = fixture({
      npmAuthFailure: true,
      version: "1.2.3-rc.1",
    });
    await expect(
      release(["pkg", "--promote-rc-latest"], dependencies),
    ).rejects.toThrow("npm auth missing");
    expect(calls.some((call) => call[1] === "push")).toBe(false);
  });

  it.each([
    { existing: true, message: /tags already exist/ },
    { failed: true, message: /failed.*Later stages were not pushed/ },
    { pending: true, message: /Timed out waiting for lsp-v/ },
    { unavailable: true, message: /Timed out waiting for test-package/ },
  ])("stops safely on $message", async ({ message, ...options }) => {
    const { dependencies, calls } = fixture(options);
    await expect(release([], dependencies)).rejects.toThrow(message);
    expect(calls.filter((call) => call[1] === "push")).toHaveLength(
      options.existing ? 0 : 1,
    );
  });

  it("rejects invalid options before fetching or pushing", async () => {
    const { dependencies, calls } = fixture();
    await expect(release(["typo"], dependencies)).rejects.toThrow(
      /Unknown package/,
    );
    await expect(
      release(["pkg", "--extension-pre"], dependencies),
    ).rejects.toThrow(/requires selecting extension/);
    await expect(
      release(["pkg", "--promote-rc-latest"], dependencies),
    ).rejects.toThrow(/requires selecting at least one npm RC/);
    expect(
      calls.some(
        (call) => call[1] === "push" || call[0] === "gh" || call[0] === "npm",
      ),
    ).toBe(false);
  });

  it("does not promote non-RC prereleases with the RC option", async () => {
    const { dependencies } = fixture({ version: "1.2.3-beta.1" });
    await expect(
      release(["pkg", "--promote-rc-latest"], dependencies),
    ).rejects.toThrow(/requires selecting at least one npm RC/);
  });

  it("rejects an unexpected push remote", async () => {
    const { dependencies } = fixture();
    await expect(
      release([], {
        ...dependencies,
        run: () => "git@github.com:someone/other.git",
      }),
    ).rejects.toThrow(/origin must point to bascikdev\/bascik/);
  });

  it("surfaces command and registry failures without pushing later stages", async () => {
    const { dependencies, calls } = fixture();
    await expect(
      release([], {
        ...dependencies,
        registry: async () => {
          throw new Error("Registry connection failed");
        },
      }),
    ).rejects.toThrow("Registry connection failed");
    expect(calls.filter((call) => call[1] === "push")).toHaveLength(1);
    await expect(
      release([], {
        ...dependencies,
        run: () => {
          throw new Error("Git failed");
        },
      }),
    ).rejects.toThrow("Git failed");
  });
});
