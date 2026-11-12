import { describe, expect, it } from "vitest";
import { release } from "../../../.github/scripts/release.mjs";

const SHA = "a".repeat(40);

function fixture({
  existing = false,
  remoteTags = [] as string[],
  failed = false,
  pending = false,
  unavailable = false,
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
          const packagePath = args[1].slice(SHA.length + 1);
          const nameByPath: Record<string, string> = {
            "pkg/package.json": "@bascik/bascik",
            "lsp/package.json": "@bascik/language-server",
            "create/package.json": "create-bascik",
            "adapters/cloudflare/package.json": "@bascik/adapter-cloudflare",
            "adapters/netlify/package.json": "@bascik/adapter-netlify",
            "extensions/vscode-bascik/package.json": "bascik-vscode",
          };
          return JSON.stringify({
            name: nameByPath[packagePath],
            version,
          });
        }
        if (args[0] === "ls-remote") {
          const present = remoteTags.filter((tag) =>
            args.includes(`refs/tags/${tag}`),
          );
          if (present.length)
            return present.map((tag) => `${SHA}\trefs/tags/${tag}`).join("\n");
          return existing ? `${SHA}\trefs/tags/v1.2.3` : "";
        }
        return "";
      }
      if (args[0] === "auth") return "";
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
      expect([
        "@bascik/language-server",
        "@bascik/bascik",
        "create-bascik",
        "@bascik/adapter-cloudflare",
        "@bascik/adapter-netlify",
      ]).toContain(name);
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
        `${SHA}:refs/tags/adapter-netlify-v1.2.3`,
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
    ).toHaveLength(6);
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

  it("prints latest dist-tag commands for every selected npm package without releasing", async () => {
    const { dependencies, calls, logs } = fixture();
    await release(["--latest"], dependencies);

    expect(logs.slice(1)).toEqual([
      "npm dist-tag add @bascik/language-server@1.2.3 latest --registry https://registry.npmjs.org",
      "npm dist-tag add @bascik/bascik@1.2.3 latest --registry https://registry.npmjs.org",
      "npm dist-tag add create-bascik@1.2.3 latest --registry https://registry.npmjs.org",
      "npm dist-tag add @bascik/adapter-cloudflare@1.2.3 latest --registry https://registry.npmjs.org",
      "npm dist-tag add @bascik/adapter-netlify@1.2.3 latest --registry https://registry.npmjs.org",
    ]);
    expect(
      calls.some(
        (call) => call[1] === "push" || call[0] === "gh" || call[0] === "npm",
      ),
    ).toBe(false);
  });

  it("prints latest commands for RC versions and selected packages only", async () => {
    const { dependencies, logs } = fixture({ version: "1.2.3-beta.10" });
    await release(["pkg", "create", "--latest"], dependencies);

    expect(logs).toEqual([
      "Run these commands to set the selected npm package versions to latest:",
      "npm dist-tag add @bascik/bascik@1.2.3-beta.10 latest --registry https://registry.npmjs.org",
      "npm dist-tag add create-bascik@1.2.3-beta.10 latest --registry https://registry.npmjs.org",
    ]);
  });

  it.each([
    { existing: true, message: /tags already exist/ },
    { failed: true, message: /failed.*Later stages were not pushed/ },
    { pending: true, message: /Timed out waiting for lsp-v/ },
    {
      unavailable: true,
      message: /Timed out waiting for @bascik\/language-server/,
    },
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
      release(["extension", "--latest"], dependencies),
    ).rejects.toThrow(/requires selecting at least one npm package/);
    expect(
      calls.some(
        (call) => call[1] === "push" || call[0] === "gh" || call[0] === "npm",
      ),
    ).toBe(false);
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

  it("refuses an ext-v plan when ext-pre-v for the same version is on origin, and the reverse", async () => {
    for (const [args, existingTag, planned] of [
      [["extension"], "ext-pre-v1.2.3", "ext-v1.2.3"],
      [["extension", "--extension-pre"], "ext-v1.2.3", "ext-pre-v1.2.3"],
    ] as const) {
      for (const flags of [[], ["--dry-run"]]) {
        const { dependencies, calls } = fixture({ remoteTags: [existingTag] });
        await expect(
          release([...args, ...flags], dependencies),
        ).rejects.toThrow(
          new RegExp(`${existingTag} already exists.*${planned}`, "s"),
        );
        expect(calls.filter((call) => call[1] === "push")).toEqual([]);
      }
    }
  });

  it("allows the other extension channel at a different version", async () => {
    const { dependencies, calls } = fixture({ remoteTags: ["ext-pre-v1.2.2"] });
    await release(["extension"], dependencies);
    expect(calls.filter((call) => call[1] === "push")).toHaveLength(1);
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
