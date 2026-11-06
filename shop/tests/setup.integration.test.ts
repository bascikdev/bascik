import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { products } from "../src/lib/catalog.ts";
import {
  templateFingerprint,
  type TemplateMapping,
} from "../scripts/template-fingerprint.ts";

test("mapping import rejects a different template despite matching catalog and placements", async () => {
  const root = await mkdtemp(join(tmpdir(), "bascik-mapping-test-"));
  try {
    await mkdir(join(root, ".local"));
    const mappings: TemplateMapping[] = products.flatMap((product) =>
      product.variants.map((variant) => ({
        variant_id: variant.id,
        store_id: 19022802,
        catalog_variant_id: 456,
        product_template_id: 123,
        shipping_placements: [{ placement: "front", technique: "dtg" }],
      })),
    );
    const fingerprint = templateFingerprint(mappings);
    const validation = {
      proposalFingerprint: fingerprint,
      draft: {
        store_id: 19022802,
        status: "draft",
        external_id: `bascik-audit-${fingerprint.slice(0, 19)}`,
        costs: { calculation_status: "done" },
      },
      items: mappings.map((mapping) => ({
        external_id: mapping.variant_id,
        source: "product_template",
        catalog_variant_id: 456,
        quantity: 1,
        placements: mapping.shipping_placements,
      })),
    };
    await writeFile(
      join(root, ".local/printful-validation-draft.json"),
      JSON.stringify(validation),
    );
    const proposal = { store: { id: 19022802 }, mappings };
    await writeFile(
      join(root, ".local/printful-template-mappings.json"),
      JSON.stringify(proposal),
    );
    const script = resolve("scripts/setup-printful-mappings.ts");
    const valid = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(valid.status, valid.stderr).toBe(0);
    const sqlPath = join(root, ".local/printful-template-mappings.sql");
    const sql = await readFile(sqlPath, "utf8");
    mappings[0].product_template_id = 124;
    await writeFile(
      join(root, ".local/printful-template-mappings.json"),
      JSON.stringify(proposal),
    );
    const changed = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toContain(
      "complete validated API-store template draft",
    );
    expect(await readFile(sqlPath, "utf8")).toBe(sql);
    await writeFile(
      join(root, ".local/printful-validation-draft.json"),
      JSON.stringify({ ...validation, proposalFingerprint: undefined }),
    );
    const legacy = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(legacy.status).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["matching", "mismatched"])(
  "Stripe setup %s existing tax code is validated before price reuse",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-stripe-test-"));
    try {
      const fixture = join(root, "provider-fixture.mjs");
      await writeFile(
        fixture,
        `
      const products=${JSON.stringify(products.map((product) => ({ id: `prod_${product.id}`, tax_code: state === "matching" ? "txcd_30011000" : "txcd_99999999", metadata: { app: "bascik-shop", handle: product.slug } })))};
      globalThis.fetch=async (input,init)=>{
        if(init?.method==="POST") throw Error("Unexpected provider write");
        const url=new URL(input);
        let result;
        if(url.pathname.endsWith("/balance")) result={livemode:false};
        else if(url.pathname.endsWith("/account")) result={id:"acct_fixture"};
        else if(url.pathname.endsWith("/tax/settings")) result={status:"active"};
        else if(url.pathname.includes("/tax_codes/")) result={id:"txcd_30011000"};
        else if(url.pathname.endsWith("/products")) result={data:products};
        else if(url.pathname.endsWith("/prices")) result={data:[{id:"price_fixture",unit_amount:products.find(p=>p.id===url.searchParams.get("product")).metadata.handle.includes("hat")?2500:3000,currency:"usd",active:true,tax_behavior:"exclusive"}]};
        else throw Error("Unexpected provider route");
        return Response.json(result);
      };
    `,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", fixture, resolve("scripts/setup-stripe.ts"), "--write"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            STRIPE_SECRET_KEY: "sk_test_fixture",
            STRIPE_ACCOUNT: "acct_fixture",
            TAX_CODE_SHIRT: "txcd_30011000",
            TAX_CODE_HAT: "txcd_30011000",
          },
        },
      );
      const report = JSON.parse(
        await readFile(join(root, ".local/stripe-readiness.json"), "utf8"),
      );
      if (state === "matching") {
        expect(result.status, result.stderr).toBe(0);
        expect(report.products).toHaveLength(4);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("tax code mismatch");
        expect(report.products).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
