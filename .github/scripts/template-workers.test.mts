import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDomainOwner,
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

test("each approved template has two unique Workers and only production has a custom domain", () => {
  const names = new Set<string>();
  for (const slug of TEMPLATE_SLUGS) {
    const preview = templateWorker(slug, "preview");
    const production = templateWorker(slug, "production");
    assert.equal(preview.name, `bascik-template-${slug}-preview`);
    assert.equal(production.name, `bascik-template-${slug}`);
    assert.deepEqual(preview.routes, []);
    assert.equal(preview.workers_dev, true);
    assert.deepEqual(production.routes, [
      { pattern: `template-${slug}.bascik.dev`, custom_domain: true },
    ]);
    assert.equal(production.workers_dev, false);
    assert.equal(production.preview_urls, false);
    names.add(preview.name).add(production.name);
  }
  assert.equal(names.size, 18);
  assert.throws(() => templateWorker("shop-production", "production"));
  assert.throws(() => templateWorker("shop", "other"));
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
