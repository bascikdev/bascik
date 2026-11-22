import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PREVIEW_TEMPLATES } from "./changed-workspaces.mjs";
import {
  assertDomainOwner,
  branchPreview,
  previewUrl,
  templateDatabase,
  templateWorker,
  TEMPLATE_SLUGS,
} from "./template-workers.mts";

test("SQL templates have separate D1 names and require a remote UUID", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.deepEqual(templateDatabase("reports", "preview", id), {
    binding: "DB",
    database_name: "bascik-template-reports-preview-db",
    database_id: id,
  });
  assert.equal(
    templateDatabase("reports", "production", id).database_name,
    "bascik-template-reports-db",
  );
  assert.equal(
    templateDatabase("shop", "preview", id).database_name,
    "bascik-template-shop-preview-db",
  );
  assert.throws(() => templateDatabase("shop", "production", ""));
  assert.throws(() => templateDatabase("reports", "other", id));
});

test("each showcase hostname belongs only to the production Worker", () => {
  const names = new Set<string>();
  for (const slug of TEMPLATE_SLUGS) {
    const preview = templateWorker(slug, "preview");
    const production = templateWorker(slug, "production");
    assert.equal(preview.name, `bascik-template-${slug}-preview`);
    assert.equal(production.name, `bascik-template-${slug}`);
    assert.deepEqual(production.routes, [
      { pattern: `template-${slug}.bascik.dev`, custom_domain: true },
    ]);
    assert.equal(production.workers_dev, false);
    assert.deepEqual(preview.routes, []);
    assert.equal(preview.workers_dev, true);
    assert.equal(production.preview_urls, false);
    // Branch Previews upload versions of the preview Worker under an alias.
    assert.equal(preview.preview_urls, true);
    names.add(preview.name).add(production.name);
  }
  assert.equal(names.size, 18);
  assert.throws(() => templateWorker("shop-production", "production"));
  assert.throws(() => templateWorker("shop", "other"));
});

test("production ownership refuses preview and unrelated Workers", () => {
  for (const slug of TEMPLATE_SLUGS) {
    const production = templateWorker(slug, "production");
    assert.doesNotThrow(() => assertDomainOwner([], production));
    assert.doesNotThrow(() =>
      assertDomainOwner(
        [{ service: production.name, environment: "production" }],
        production,
      ),
    );
    for (const service of [
      templateWorker(slug, "preview").name,
      "bascik",
      "bascik-shop-production",
      "cloudflare-adapter",
    ]) {
      assert.throws(() =>
        assertDomainOwner([{ service, environment: "production" }], production),
      );
    }
  }
});

test("binding a production database requires its D1 id", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          new URL("./template-workers.mts", import.meta.url).pathname,
          "bind",
          "shop",
          "production",
          "/nonexistent",
        ],
        {
          env: { ...process.env, TEMPLATE_SHOP_PRODUCTION_D1_ID: "" },
          stdio: "pipe",
        },
      ),
    (error: { stderr?: Buffer }) => (error.stderr?.length ?? 0) > 0,
  );
});

test("main deploys production only from merged pull requests, after the ownership and newest-commit checks", () => {
  const workflow = readFileSync(
    new URL("../workflows/template-workers.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /push:\s+branches: \[main\]/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  const order = [
    "template-workers.mts check-merged",
    'template-workers.mts check-domain "$SLUG"',
    "newest-commit.mjs",
    "wrangler.jsonc",
    'smoke "$SLUG" "https://template-$SLUG.bascik.dev"',
  ].map((step) => workflow.indexOf(step));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  for (const slug of TEMPLATE_SLUGS)
    assert.match(workflow, new RegExp(`"${slug}"`));
  const helper = readFileSync(
    new URL("./template-workers.mts", import.meta.url),
    "utf8",
  );
  assert.match(helper, /ref !== "refs\/heads\/main"/);
  assert.match(helper, /mergedPullRequest\(pulls, sha\)/);
});

test("the production hostname cannot move from another Worker or environment", () => {
  const worker = templateWorker("shop", "production");
  assert.doesNotThrow(() => assertDomainOwner([], worker));
  assert.doesNotThrow(() =>
    assertDomainOwner(
      [{ service: worker.name, environment: "production" }],
      worker,
    ),
  );
  assert.throws(() => assertDomainOwner([{ service: "bascik-shop" }], worker));
  assert.throws(() =>
    assertDomainOwner(
      [{ service: worker.name, environment: "staging" }],
      worker,
    ),
  );
});

test("deployment metadata must identify the expected dedicated preview target", () => {
  const worker = templateWorker("default", "preview");
  const result = {
    type: "deploy",
    worker_name: worker.name,
    targets: [`https://${worker.name}.example.workers.dev`],
  };
  assert.equal(previewUrl(JSON.stringify(result), worker), result.targets[0]);
  assert.throws(() =>
    previewUrl(
      JSON.stringify({ ...result, targets: ["https://shop.bascik.dev"] }),
      worker,
    ),
  );
  assert.throws(() =>
    previewUrl(JSON.stringify({ ...result, worker_name: "other" }), worker),
  );
});

test("branch Preview rows name the preview Worker's alias URL and a template page", () => {
  assert.deepEqual(PREVIEW_TEMPLATES, [...TEMPLATE_SLUGS]);
  assert.deepEqual(
    branchPreview(
      "docs",
      "https://pr-295-bascik-template-docs-preview.example.workers.dev",
    ),
    {
      order: 2,
      label: "Template: docs (branch preview)",
      worker: "bascik-template-docs-preview",
      url: "https://pr-295-bascik-template-docs-preview.example.workers.dev",
      paths: ["/", "/docs/navigation-and-search"],
    },
  );
  for (const url of [
    "https://bascik-template-docs-preview.example.workers.dev",
    "https://pr-295-bascik-template-docs.example.workers.dev",
    "https://pr-295-bascik-template-blog-preview.example.workers.dev",
    "http://pr-295-bascik-template-docs-preview.example.workers.dev",
    "https://pr-295-bascik-template-docs-preview.example.workers.dev/x",
    "https://template-docs.bascik.dev",
    "https://pr-295-bascik-template-docs-preview.a.b.workers.dev",
    "https://pr-295-bascik-template-docs-preview.example.workers.dev.example.com",
    "https://295-bascik-template-docs-preview.example.workers.dev",
  ])
    assert.throws(() => branchPreview("docs", url), /not a Preview alias/, url);
  assert.throws(() => branchPreview("nope", "https://x.workers.dev"));
});
