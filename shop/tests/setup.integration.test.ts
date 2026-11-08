import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { products } from "../src/lib/catalog.ts";
import {
  templateFingerprint,
  type TemplateMapping,
} from "../scripts/template-fingerprint.ts";

test("sweatshirt import is idempotent and preserves existing product and variant identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "bascik-sweatshirts-"));
  try {
    await mkdir(join(root, "catalog"));
    await mkdir(join(root, "src/pages/assets/products"), { recursive: true });
    await cp(resolve("image-originals"), join(root, "image-originals"), {
      recursive: true,
    });
    const original = await readFile("catalog/products.json", "utf8");
    await writeFile(join(root, "catalog/products.json"), original);
    const script = resolve("scripts/import-sweatshirts.ts");
    const run = () =>
      promisify(execFile)(
        process.execPath,
        [script, "image-originals/sweatshirts"],
        {
          cwd: root,
          encoding: "utf8",
        },
      );
    const first = await run();
    expect(first.stdout).toContain("Black first");
    const productPath = join(root, "catalog/products.json");
    const manifestPath = join(root, "image-originals/manifest.json");
    const catalog = await readFile(productPath, "utf8");
    const manifest = await readFile(manifestPath, "utf8");
    expect(
      JSON.parse(catalog).filter(
        (product: { slug: string }) => !product.slug.includes("sweatshirt"),
      ),
    ).toEqual(
      products.filter((product) => !product.slug.includes("sweatshirt")),
    );
    expect(catalog).toBe(original);
    const again = await run();
    expect(again.stdout).toContain("Black first");
    expect(await readFile(productPath, "utf8")).toBe(catalog);
    expect(await readFile(manifestPath, "utf8")).toBe(manifest);
    const fixture = join(root, "legacy-provider.ts");
    await writeFile(
      fixture,
      `
      import {readFile} from "node:fs/promises";
      globalThis.fetch=async(input)=>{
        const url=String(input);
        if(url==="https://shop.bascik.dev/products.json?limit=250")
          return Response.json(JSON.parse(await readFile(${JSON.stringify(resolve("catalog/source.json"))},"utf8")));
        if(url==="https://api.printful.com/countries")
          return Response.json({result:JSON.parse(await readFile(${JSON.stringify(resolve("catalog/countries.json"))},"utf8"))});
        const image=JSON.parse(await readFile("image-originals/manifest.json","utf8")).find(entry=>entry.source===url);
        if(image)return new Response(await readFile(image.file));
        throw new Error("Unexpected legacy importer network request: "+url);
      };
    `,
    );
    await promisify(execFile)(
      process.execPath,
      ["--import", fixture, resolve("scripts/import-catalog.ts")],
      { cwd: root },
    );
    const refreshed = JSON.parse(await readFile(productPath, "utf8"));
    expect(refreshed.map((product: { id: string }) => product.id)).toEqual(
      products.map((product) => product.id),
    );
    expect(
      refreshed.filter((product: { slug: string }) =>
        product.slug.includes("sweatshirt"),
      ),
    ).toEqual(
      products.filter((product) => product.slug.includes("sweatshirt")),
    );
    const beforeFailure = await readFile(productPath, "utf8");
    const hero = products.find((product) =>
      product.slug.includes("logo-sweatshirt"),
    )!.images[0].sourceId;
    await unlink(
      join(root, `image-originals/sweatshirts/109989489/${hero}.png`),
    );
    await expect(run()).rejects.toThrow("Expected all 14 mockups");
    expect(await readFile(productPath, "utf8")).toBe(beforeFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

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

test.each([
  "matching",
  "mismatched",
  "later-products",
  "later-prices",
  "incomplete-products",
  "incomplete-prices",
])(
  "Stripe setup %s existing tax code is validated before price reuse",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-stripe-test-"));
    try {
      const fixture = join(root, "provider-fixture.mjs");
      await writeFile(
        fixture,
        `
      const products=${JSON.stringify(products.map((product) => ({ id: `prod_${product.id}`, unit_amount: product.price, expected_tax_code: product.taxCode ?? "txcd_30011000", tax_code: state === "matching" ? (product.taxCode ?? "txcd_30011000") : "txcd_99999999", metadata: { app: "bascik-shop", handle: product.slug } })))};
      const state=${JSON.stringify(state)};
      if(state!=="mismatched")for(const product of products)product.tax_code=product.expected_tax_code;
      globalThis.fetch=async (input,init)=>{
        if(init?.method==="POST") throw Error("Unexpected provider write");
        const url=new URL(input);
        let result;
        if(url.pathname.endsWith("/balance")) result={livemode:false};
        else if(url.pathname.endsWith("/account")) result={id:"acct_fixture"};
        else if(url.pathname.endsWith("/tax/settings")) result={status:"active"};
        else if(url.pathname.includes("/tax_codes/")) result={id:"txcd_30011000"};
        else if(url.pathname.endsWith("/products")){
          if(!url.searchParams.has("starting_after")&&state==="later-products")result={data:Array.from({length:100},(_,i)=>({id:"prod_other_"+i,metadata:{app:"other"}})),has_more:true};
          else if(state==="incomplete-products")result={data:[],has_more:true};
          else result={data:products,has_more:false};
        }
        else if(url.pathname.endsWith("/prices")){
          if(!url.searchParams.has("starting_after")&&state==="later-prices")result={data:Array.from({length:100},(_,i)=>({id:"price_old_"+i,active:false})),has_more:true};
          else if(state==="incomplete-prices")result={data:[],has_more:true};
          else result={data:[{id:"price_fixture",unit_amount:products.find(p=>p.id===url.searchParams.get("product")).unit_amount,currency:"usd",active:true,tax_behavior:"exclusive"}],has_more:false};
        }
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
      if (["matching", "later-products", "later-prices"].includes(state)) {
        expect(result.status, result.stderr).toBe(0);
        expect(report.products).toHaveLength(products.length);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          state === "mismatched" ? "tax code mismatch" : "pagination",
        );
        expect(report.products).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
