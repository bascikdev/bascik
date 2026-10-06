import { describe, it, expect } from "vitest";
import {
  buildScriptFixtureRoot,
  cleanupFixture,
  createFixtureDirs,
  readDistHtml,
  runRealBuildScriptBuild,
  twoScriptPageTemplate,
  writeBuildScriptConfig,
  writeFixtureFile,
} from "./lib/build-script-isolation.fixtures.ts";

/**
 * Prompt 103 P0 regression anchor. Two sibling build scripts sharing a stateful
 * helper produced different output depending on cache temperature: a cold batch
 * printed "first:1 second:2" (shared-process batch, shared ESM module, shared
 * counter) while a partial-hit build where only one script was cached printed
 * "first:1 second:1". Final HTML ownership must be identical regardless of
 * neighboring misses: each script runs in its own fresh process and sees its own
 * helper module, so the expected output is ALWAYS "first:1 second:1".
 */
describe("build-script per-script output isolation (real child processes)", () => {
  for (const workers of [false, true]) {
    describe(`execution mode: workers=${workers}`, () => {
      it("produces identical final HTML on cold, warm, and partial-hit builds", async () => {
        const root = buildScriptFixtureRoot(`parity-${workers}`);
        try {
          await createFixtureDirs(root);
          await writeBuildScriptConfig(root, workers);
          await writeFixtureFile(root, "src/lib/helper.js", `
            export let counter = 0;
            export const next = () => ++counter;
          `);
          await writeFixtureFile(root, "src/pages/index.html", twoScriptPageTemplate());

          // COLD: both scripts are cache misses.
          await runRealBuildScriptBuild(root);
          const coldHtml = await readDistHtml(root, "index.html");
          expect(coldHtml).toContain('data-testid="count-a">first:1</span>');
          expect(coldHtml).toContain('data-testid="count-b">second:1</span>');
          expect(coldHtml).not.toContain("second:2");

          // WARM: both scripts hit the on-disk cache, no child processes run.
          await runRealBuildScriptBuild(root);
          const warmHtml = await readDistHtml(root, "index.html");
          expect(warmHtml).toEqual(coldHtml);

          // PARTIAL-HIT: change ONLY the second script body; script A stays
          // cached (cache key only covers A's own deps), while script B runs
          // alone in its own process and must still see its own counter=1.
          await writeFixtureFile(root, "src/pages/index.html", twoScriptPageTemplate("\n// a comment only on script B"));
          await runRealBuildScriptBuild(root);
          const partialHtml = await readDistHtml(root, "index.html");
          expect(partialHtml).toContain('data-testid="count-a">first:1</span>');
          expect(partialHtml).toContain('data-testid="count-b">second:1</span>');
          expect(partialHtml).not.toContain("second:2");
        } finally {
          await cleanupFixture(root);
        }
      }, 90000);
    });
  }

  it("does not leak detached (setImmediate) output from one script into a sibling", async () => {
    const root = buildScriptFixtureRoot("detached");
    try {
      await createFixtureDirs(root);
      await writeBuildScriptConfig(root, false);
      // Script A schedules setImmediate output that resolves AFTER its own
      // return; script B awaits a setImmediate before returning. A's detached
      // output must never be captured by B's transport envelope.
      await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html><head><title>d</title></head><body>
<script data-bascik-build>
setImmediate(() => console.log('A-LATE'));
export default function () {
  return '<span data-testid="early">A-early</span>';
}
</script>
<script data-bascik-build>
export default async function () {
  await new Promise((resolve) => setImmediate(resolve));
  return '<span data-testid="b">B</span>';
}
</script>
</body></html>`);
      const { stdout } = await runRealBuildScriptBuild(root);
      expect(stdout).toContain("A-LATE");
      const html = await readDistHtml(root, "index.html");
      expect(html).toContain('data-testid="early">A-early</span>');
      expect(html).toContain('data-testid="b">B</span>');
      // In the new contract, console.log does NOT enter HTML at all!
      expect(html).not.toContain("A-LATE");
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);

  it("reports a thrown sibling cleanly and still publishes the healthy script (warn)", async () => {
    const root = buildScriptFixtureRoot("thrown");
    try {
      await createFixtureDirs(root);
      await writeBuildScriptConfig(root, false, "warn");
      await writeFixtureFile(root, "src/pages/index.html", `<!DOCTYPE html><html><head><title>t</title></head><body>
<script data-bascik-build>export default () => '<span data-testid="ok">healthy</span>';</script>
<script data-bascik-build>
export default function () {
  throw new Error('sibling failure');
}
</script>
</body></html>`);
      const { stderr } = await runRealBuildScriptBuild(root);
      expect(stderr).toContain("sibling failure");
      const html = await readDistHtml(root, "index.html");
      expect(html).toContain('data-testid="ok">healthy</span>');
      expect(html).not.toContain("sibling failure");
    } finally {
      await cleanupFixture(root);
    }
  }, 60000);
});
