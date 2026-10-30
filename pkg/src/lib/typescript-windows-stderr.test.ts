/**
 * `checkDirectiveModuleSyntax` reads the line and column of a parse error
 * from `node --check` stderr. On Windows, Node writes that report through C
 * stdio in text mode, so every line ends in CRLF. This file swaps `spawn` for
 * a process that answers with the report Node gives on Windows, byte for
 * byte, so the position is checked on every platform, not only on Windows CI.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const windowsCheck = vi.hoisted(() => ({ stderr: "" }));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter & { setEncoding: () => void };
        stdin: EventEmitter & { end: (code: string) => void };
      };
      child.stderr = Object.assign(new EventEmitter(), {
        setEncoding: () => {},
      });
      child.stdin = Object.assign(new EventEmitter(), {
        end: () => {
          setImmediate(() => {
            child.stderr.emit("data", windowsCheck.stderr);
            child.emit("close", 1);
          });
        },
      });
      return child;
    },
  };
});

const { checkDirectiveModuleSyntax, __moduleCheckStatsForTests } =
  await import("./typescript.ts");

/** The report `node --check --input-type=module -` gives, with Windows line ends. */
const crlfReport = (
  line: number,
  source: string,
  column: number,
  message: string,
) =>
  [
    `[stdin]:${line}`,
    source,
    `${" ".repeat(column - 1)}^`,
    "",
    `SyntaxError: ${message}`,
    "    at checkSyntax (node:internal/main/check_syntax:84:5)",
    "",
    "Node.js v24.0.0",
    "",
  ].join("\r\n");

describe("checkDirectiveModuleSyntax with Windows node --check output", () => {
  it("names the file, line and column when Node's report ends its lines in CRLF", async () => {
    windowsCheck.stderr = crlfReport(
      2,
      "let q = 2;",
      5,
      "Identifier 'q' has already been declared",
    );
    __moduleCheckStatsForTests.disableChecker = true;
    try {
      await expect(
        checkDirectiveModuleSyntax(
          "let q = 1;\nlet q = 2;\nexport default q;\n",
          "src/lib/q.ts",
        ),
      ).rejects.toThrow(
        /src\/lib\/q\.ts:2:5: Identifier 'q' has already been declared\n {2}2 \| let q = 2;\n {2} {2}\| {5}\^/,
      );
    } finally {
      __moduleCheckStatsForTests.disableChecker = false;
    }
  });
});
