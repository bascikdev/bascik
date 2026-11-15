// Spawns a process and waits for it to exit: the guard must stay quiet.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";

it("ends what it starts", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const [code] = await once(child, "exit");
  expect(code).toBe(0);
});
