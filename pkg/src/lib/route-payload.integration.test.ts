import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupFixture,
  createFixtureDirs,
  fixtureRoot,
  runRealBuild,
  writeFixtureFile,
} from "./build-fixtures.ts";

// A route's `data` reaches build scripts as BASCIK_ROUTE. Linux limits one
// environment string to 128 KiB (MAX_ARG_STRLEN) and macOS limits the whole
// environment to about 1 MiB, so a long post body passed as route data used to
// fail with `spawn E2BIG`. Route data must arrive intact at any size the
// routes script can print.

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(cleanupFixture));
});

describe("large dynamic route payloads", () => {
  it("delivers route data larger than the OS environment limit to build scripts", async () => {
    const root = fixtureRoot("route-payload");
    fixtureRoots.push(root);
    await createFixtureDirs(root);
    await writeFixtureFile(root, "bascik.config.js", `module.exports = {
  generate: { sitemap: false, robots: false },
};`);
    // 2 MiB of content, beyond both the Linux per-string and macOS total limits.
    await writeFixtureFile(root, "src/pages/[slug].html", `<!doctype html><html lang="en"><head><title>Post</title></head><body>
<script data-bascik-routes>
  const body = 'é'.repeat(1024 * 1024);
  console.log(JSON.stringify([{ params: { slug: 'long' }, data: { body } }]));
</script>
<p><script data-bascik-build>
  const { params, data } = JSON.parse(process.env.BASCIK_ROUTE);
  const ok = data.body.length === 1024 * 1024 && /^é+$/.test(data.body);
  console.log(params.slug + ':' + data.body.length + ':' + ok);
</script></p>
</body></html>`);

    await runRealBuild({ projectRoot: root });
    const html = await readFile(join(root, "dist/long.html"), "utf8");
    expect(html).toContain("long:1048576:true");
  }, 120_000);
});

describe("directive scripts inside printed build output", () => {
  it("never runs or registers them, while component tags in the output still expand", async () => {
    const root = fixtureRoot("printed-directives");
    fixtureRoots.push(root);
    await createFixtureDirs(root);
    await writeFixtureFile(root, "bascik.config.js", `module.exports = {
  generate: { sitemap: false, robots: false },
};`);
    await writeFixtureFile(root, "src/components/post-note/post-note.html", "<aside>NOTE</aside>");
    // Stand-in for CMS HTML: a post body that carries directive scripts.
    await writeFixtureFile(root, "content/post.html", [
      "<p>From the CMS</p>",
      "<script data-bascik-build>import { writeFileSync } from 'node:fs'; writeFileSync('CANARY', 'ran'); console.log('<p>BUILD RAN</p>');</script>",
      "<script data-bascik-server>export default () => 'SERVER RAN';</script>",
      "<post-note></post-note>",
    ].join("\n"));
    await writeFixtureFile(root, "src/pages/index.html", `<!doctype html><html lang="en"><head><title>P</title></head><body>
<article><script data-bascik-build>
  import { readFile } from 'node:fs/promises';
  console.log(await readFile('content/post.html', 'utf8'));
</script></article>
</body></html>`);

    const { stdout, stderr } = await runRealBuild({ projectRoot: root });
    const html = await readFile(join(root, "dist/index.html"), "utf8");
    expect(html).toContain("<p>From the CMS</p>");
    expect(html).toContain("<aside>NOTE</aside>");
    expect(html).not.toContain("BUILD RAN");
    expect(html).not.toMatch(/data-bascik-(build|server)/);
    expect(html).not.toContain("text/bascik-server");
    await expect(readFile(join(root, "CANARY"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const sidecar = await readFile(join(root, "dist/.bascik/server-scripts.json"), "utf8").catch(() => "{}");
    expect(sidecar).not.toContain("SERVER RAN");
    expect(`${stdout}${stderr}`).toMatch(/contained <script data-bascik-build>, <script data-bascik-server>/);
  }, 120_000);
});
