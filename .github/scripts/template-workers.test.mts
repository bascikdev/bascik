import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

test("each showcase alias belongs only to the current preview Worker", () => {
  const names = new Set<string>();
  for (const slug of TEMPLATE_SLUGS) {
    const preview = templateWorker(slug, "preview");
    const production = templateWorker(slug, "production");
    assert.equal(preview.name, `bascik-template-${slug}-preview`);
    assert.equal(production.name, `bascik-template-${slug}`);
    assert.deepEqual(preview.routes, [
      { pattern: `template-${slug}.bascik.dev`, custom_domain: true },
    ]);
    assert.equal(preview.workers_dev, true);
    assert.deepEqual(production.routes, []);
    assert.equal(production.workers_dev, false);
    assert.equal(production.preview_urls, false);
    names.add(preview.name).add(production.name);
  }
  assert.equal(names.size, 18);
  assert.throws(() => templateWorker("shop-production", "production"));
  assert.throws(() => templateWorker("shop", "other"));
});

test("preview alias ownership refuses production and unrelated Workers", () => {
  for (const slug of TEMPLATE_SLUGS) {
    const preview = templateWorker(slug, "preview");
    assert.doesNotThrow(() => assertDomainOwner([], preview));
    assert.doesNotThrow(() =>
      assertDomainOwner(
        [{ service: preview.name, environment: "production" }],
        preview,
      ),
    );
    for (const service of [
      templateWorker(slug, "production").name,
      "bascik",
      "bascik-shop-production",
    ]) {
      assert.throws(() =>
        assertDomainOwner([{ service, environment: "production" }], preview),
      );
    }
  }
});

test("production promotion is blocked before credentials or domain mutation", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          new URL("./template-workers.mts", import.meta.url).pathname,
          "check-domain",
          "default",
        ],
        {
          env: {
            ...process.env,
            CLOUDFLARE_API_TOKEN: "",
            CLOUDFLARE_ACCOUNT_ID: "",
          },
          stdio: "pipe",
        },
      ),
    (error: { stderr?: Buffer }) =>
      error.stderr
        ?.toString()
        .includes("Custom domain is not assigned to this Worker") === true,
  );
});

test("trigger-only output contains one authorized preview alias and no code or bindings", () => {
  const directory = mkdtempSync(join(tmpdir(), "template-domain-test-"));
  try {
    execFileSync(
      process.execPath,
      [
        new URL("./template-workers.mts", import.meta.url).pathname,
        "domain-triggers",
        "shop",
        directory,
      ],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: "8572c3fcc06b71dbf05fe590e8b3f74e",
        },
        stdio: "pipe",
      },
    );
    const output = join(directory, ".cloudflare/output/v0");
    assert.deepEqual(
      JSON.parse(readFileSync(join(output, "config.json"), "utf8")),
      {
        accountId: "8572c3fcc06b71dbf05fe590e8b3f74e",
        buildContext: { isPreview: false },
      },
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(output, "workers/default/worker.config.json"),
          "utf8",
        ),
      ),
      {
        name: "bascik-template-shop-preview",
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        domains: ["template-shop.bascik.dev"],
        workersDev: true,
        previewUrls: false,
      },
    );
    assert.equal(existsSync(join(output, "workers/default/assets")), true);
    assert.equal(existsSync(join(output, "workers/default/bundle")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CI checks preview ownership immediately before publishing without weakening the main gate", () => {
  const workflow = readFileSync(
    new URL("../workflows/template-workers.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /node \.github\/scripts\/template-workers\.mts check-domain "\$SLUG" preview\s+yarn workspace @bascik\/adapter-cloudflare wrangler deploy/,
  );
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /check-merged/);
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
