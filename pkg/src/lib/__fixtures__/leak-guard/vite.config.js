// A one-project Vitest run with the leak guard on, started as a child process
// by ../../process-leak-guard.integration.test.ts. LEAK_GUARD_FIXTURE picks
// the test file: `leaks` leaves an orphan behind, `clean` does not. The files
// do not end in `.test.ts`, so no other project collects them.
import { fileURLToPath } from "node:url";

export default {
  root: fileURLToPath(new URL("../../../..", import.meta.url)),
  test: {
    include: [
      `src/lib/__fixtures__/leak-guard/${process.env.LEAK_GUARD_FIXTURE}.fixture-test.ts`,
    ],
    globalSetup: ["./vitest.leak-guard-setup.ts"],
  },
};
