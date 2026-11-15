// Passes, and leaves an orphan running: the guard must fail the run.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("leaves a process running", async () => {
  const parent = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./leaker.ts", import.meta.url)),
      "parent",
      process.env.LEAK_GUARD_FIXTURE_PID_FILE!,
      "exit",
      "inherit",
    ],
    { stdio: "ignore" },
  );
  const [code] = await once(parent, "exit");
  expect(code).toBe(0);
});
