import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { products } from "../src/lib/catalog.ts";

test.each([
  "ready",
  "account",
  "sandbox",
  "classification",
  "amount",
  "currency",
  "inclusive",
  "inactive",
  "store",
  "tax",
  "no-registration",
])("live readiness checks %s without writing providers", async (state) => {
  const root = await mkdtemp(join(tmpdir(), "bascik-live-readiness-"));
  try {
    const fixture = join(root, "provider.mjs");
    await writeFile(
      fixture,
      `
        const state=${JSON.stringify(state)};
        const products=${JSON.stringify(
          products.map((product) => ({
            id: `prod_${product.id}`,
            active: true,
            tax_code: product.taxCode ?? "txcd_30011000",
            metadata: { app: "bascik-shop", handle: product.slug },
          })),
        )};
        const prices=${JSON.stringify(
          products.map((product) => ({
            id: `price_${product.id}`,
            product: `prod_${product.id}`,
            active: true,
            unit_amount: product.price,
            currency: "usd",
            tax_behavior: "exclusive",
          })),
        )};
        if(state==="classification")products[0].tax_code="txcd_99999999";
        if(state==="amount")prices[0].unit_amount=1;
        if(state==="currency")prices[0].currency="eur";
        if(state==="inclusive")prices[0].tax_behavior="inclusive";
        if(state==="inactive")prices[0].active=false;
        globalThis.fetch=async(input,init)=>{
          if(init?.method && init.method!=="GET")throw Error("Unexpected live provider write");
          const url=new URL(input);
          let data;
          if(url.hostname==="api.printful.com")data={data:{id:state==="store"?18630655:19022802,type:"native"}};
          else if(url.hostname!=="api.stripe.com")throw Error("Unexpected provider host");
          else if(url.pathname==="/v1/account")data={id:state==="account"?"acct_wrong":"acct_fixture",charges_enabled:true,payouts_enabled:true};
          else if(url.pathname==="/v1/balance")data={livemode:state!=="sandbox"};
          else if(url.pathname==="/v1/tax/settings")data={livemode:true,status:state==="tax"?"pending":"active"};
          else if(url.pathname==="/v1/tax/registrations")data={data:[],has_more:false};
          else if(url.pathname==="/v1/products")data={data:products,has_more:false};
          else if(url.pathname==="/v1/prices")data={data:prices,has_more:false};
          else throw Error("Unexpected provider route");
          return Response.json(data);
        };
      `,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        fixture,
        resolve("scripts/check-live-providers.ts"),
        ...(state === "no-registration" ? ["--launch"] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          STRIPE_SECRET_KEY: "rk_live_fixture",
          STRIPE_ACCOUNT: "acct_fixture",
          PRINTFUL_TOKEN: "fixture",
        },
      },
    );
    if (state === "ready") {
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(
        await readFile(
          join(root, ".local/live-provider-readiness.json"),
          "utf8",
        ),
      );
      expect(report).toMatchObject({
        liveAccountMatched: true,
        verifiedProducts: 6,
        registrationCount: 0,
        printfulStoreVerified: true,
      });
    } else {
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stderr).toMatch(
        /mismatch|match|ready|Wrong production|active tax registration/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "production artifact launch=%s overrides sandbox bindings but preserves the portable worker and assets",
  async (launch) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-production-bundle-"));
    try {
      await mkdir(join(root, ".output"));
      await mkdir(join(root, ".output/public"));
      const checkout =
        '<main><p class="scoped-notice" data-testid="checkout-prelaunch">\nThe new shop is being prepared. Checkout stays disabled until tax,\nfulfillment, and email setup have been verified.\n</p><form data-testid="shipping-form"></form></main>';
      await writeFile(join(root, ".output/public/checkout.html"), checkout);
      await writeFile(
        join(root, ".output/public/_headers"),
        "/*\n  X-Content-Type-Options: nosniff\n\n/cart*\n  Cache-Control: no-store\n/*\n  X-Robots-Tag: noindex, nofollow\n",
      );
      await writeFile(
        join(root, "wrangler.production.json"),
        await readFile("wrangler.production.json"),
      );
      await writeFile(
        join(root, ".output/wrangler.json"),
        JSON.stringify({
          main: "./worker.js",
          assets: { directory: "./public", binding: "ASSETS" },
          vars: { SHOP_MODE: "test" },
          routes: [{ pattern: "should-not-survive.example.com" }],
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          resolve("scripts/package-production.ts"),
          ...(launch ? ["--launch"] : []),
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const config = JSON.parse(
        await readFile(join(root, ".output/wrangler.production.json"), "utf8"),
      );
      expect(config).toMatchObject({
        name: "bascik-shop-production",
        main: "./worker.js",
        assets: { directory: "./public", binding: "ASSETS" },
        triggers: { crons: ["*/5 * * * *"] },
        vars: {
          SHOP_MODE: "live",
          SHOP_ENABLED: String(launch),
          SHOP_FULFILLMENT_ENABLED: String(launch),
        },
      });
      if (launch) {
        expect(config.routes).toEqual([
          { pattern: "shop.bascik.dev", custom_domain: true },
        ]);
        expect(config.vars.SHOP_ORIGIN).toBe("https://shop.bascik.dev");
      } else expect(config.routes).toBeUndefined();
      const headers = await readFile(
        join(root, ".output/public/_headers"),
        "utf8",
      );
      expect(headers).toContain("X-Content-Type-Options: nosniff");
      expect(headers).toContain("Cache-Control: no-store");
      expect(headers.includes("X-Robots-Tag: noindex")).toBe(!launch);
      const publishedCheckout = await readFile(
        join(root, ".output/public/checkout.html"),
        "utf8",
      );
      expect(publishedCheckout.includes("Checkout stays disabled")).toBe(
        !launch,
      );
      expect(publishedCheckout).toContain('data-testid="shipping-form"');
      expect(config.d1_databases[0].migrations_dir).toBe("./migrations");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("production deploy refuses local invocation before reading any secrets or touching providers", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/deploy-production-prelaunch.ts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REPOSITORY: "bascikdev/bascik",
      },
    },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("restricted to manual main CI");
});

test.each(["empty", "saved", "other-app", "active"])(
  "production webhook setup %s preserves provider isolation and one-time secrets",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-live-webhooks-"));
    try {
      const fixture = join(root, "provider.mjs");
      await writeFile(
        fixture,
        `
          import cp from "node:child_process";
          import {syncBuiltinESMExports} from "node:module";
          import {writeFileSync,readFileSync,existsSync} from "node:fs";
          const state=${JSON.stringify(state)};
          const stripeUrl="https://bascik-shop-production.collin-inbox.workers.dev/api/webhooks/stripe";
          const pfUrl="https://bascik-shop-production.collin-inbox.workers.dev/api/webhooks/printful";
          const calls=[];
          cp.spawnSync=(command,args,options)=>{
            if(command!=="gh"||args[0]!=="secret"||args.at(-1)!=="shop-production"||!options.input)
              throw Error("Unexpected production credential destination");
            calls.push("secret:"+args[2]);
            writeFileSync("calls.json",JSON.stringify(calls));
            return {status:0};
          };
          syncBuiltinESMExports();
          globalThis.fetch=async(input,init)=>{
            const url=new URL(input);
            const post=init?.method==="POST";
            let data;
            if(url.hostname==="api.stripe.com"){
              if(url.pathname==="/v1/account")data={id:"acct_fixture"};
              else if(url.pathname==="/v1/balance")data={livemode:true};
              else if(url.pathname==="/v1/webhook_endpoints"&&!post)data={data:[],has_more:false};
              else if(url.pathname==="/v1/webhook_endpoints"&&post){
                if(state==="saved")throw Error("Unexpected signing secret rotation");
                if(init.body.get("url")!==stripeUrl||init.body.get("metadata[app]")!=="bascik-shop-production")
                  throw Error("Wrong Stripe webhook target");
                data={id:"we_fixture",secret:"whsec_fixture",livemode:true};
                calls.push("stripe:create");
              }else if(url.pathname==="/v1/webhook_endpoints/we_fixture"){
                if(post){
                  if(init.body.get("disabled")!=="true")throw Error("Live webhook enabled before deployment");
                  calls.push("stripe:disable");
                }
                data={id:"we_fixture",url:stripeUrl,livemode:true,status:state==="active"?"enabled":"disabled",metadata:{app:"bascik-shop-production"}};
              }else throw Error("Unexpected Stripe operation");
            }else if(url.hostname==="api.printful.com"&&url.pathname==="/v2/webhooks"){
              if(init.headers["X-PF-Store-Id"]!=="19022802")throw Error("Wrong Printful store");
              if(post){
                if(state!=="empty")throw Error("Unexpected Printful webhook overwrite");
                if(JSON.parse(init.body).default_url!==pfUrl)throw Error("Wrong Printful URL");
                data={default_url:pfUrl,public_key:"public_fixture",secret_key:"ab".repeat(32),events:[]};
                calls.push("printful:create");
              }else data=state==="saved"?{default_url:pfUrl,public_key:"public_fixture",events:[]}:
                state==="other-app"?{default_url:"https://other.example.com",events:[{type:"shipment_sent"}]}:{default_url:null,events:[]};
              data={data};
            }else throw Error("Unexpected provider operation");
            writeFileSync("calls.json",JSON.stringify(calls));
            return Response.json(data);
          };
        `,
      );
      if (state === "saved" || state === "active") {
        await mkdir(join(root, ".local"));
        await writeFile(
          join(root, ".local/production-webhooks.json"),
          JSON.stringify({
            stripe: { id: "we_fixture", secret: "whsec_fixture" },
            printful: {
              public_key: "public_fixture",
              secret_key: "ab".repeat(32),
            },
            orderTokenSecret: "stable-order-token-fixture".repeat(2),
          }),
        );
      }
      const result = spawnSync(
        process.execPath,
        ["--import", fixture, resolve("scripts/setup-production-webhooks.ts")],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            STRIPE_SECRET_KEY: "rk_live_fixture",
            STRIPE_ACCOUNT: "acct_fixture",
            PRINTFUL_TOKEN: "fixture",
            SHOP_CLOUDFLARE_API_TOKEN: "fixture",
          },
        },
      );
      const calls: string[] = JSON.parse(
        await readFile(join(root, "calls.json"), "utf8"),
      );
      if (state === "active") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Refusing to disrupt an active shop");
        expect(calls).not.toContain("stripe:disable");
      } else if (state === "other-app") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Refusing to replace another app");
        expect(calls).not.toContain("printful:create");
        expect(calls.filter((call) => call.startsWith("secret:"))).toHaveLength(
          0,
        );
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(calls).toContain("stripe:disable");
        expect(calls.filter((call) => call.startsWith("secret:"))).toHaveLength(
          9,
        );
        const evidence = JSON.parse(
          await readFile(join(root, ".local/production-webhooks.json"), "utf8"),
        );
        expect(evidence.stripe.secret).toBe("whsec_fixture");
        if (state === "saved") {
          expect(calls).not.toContain("stripe:create");
          expect(calls).not.toContain("printful:create");
          expect(evidence.orderTokenSecret).toBe(
            "stable-order-token-fixture".repeat(2),
          );
        }
      }
      expect(result.stdout).not.toContain("whsec_fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([
  "closed",
  "unrelated-503",
  "launch",
  "wrong-webhook",
  "launch-closed",
])(
  "production CI smoke verifies %s and cryptographically signed no-order probes",
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), "bascik-production-ci-"));
    const launch = !["closed", "unrelated-503"].includes(state);
    try {
      await mkdir(join(root, ".output"));
      await mkdir(join(root, ".output/public"));
      await writeFile(
        join(root, ".output/public/checkout.html"),
        '<p class="scoped-notice" data-testid="checkout-prelaunch">The new shop is being prepared. Checkout stays disabled until tax, fulfillment, and email setup have been verified.</p>',
      );
      await writeFile(
        join(root, ".output/public/_headers"),
        "/*\n  X-Robots-Tag: noindex, nofollow\n",
      );
      await writeFile(
        join(root, "wrangler.production.json"),
        await readFile("wrangler.production.json"),
      );
      await writeFile(
        join(root, ".output/wrangler.json"),
        JSON.stringify({
          assets: { directory: "./public", binding: "ASSETS" },
        }),
      );
      const fixture = join(root, "runtime.mjs");
      await writeFile(
        fixture,
        `
        import cp from "node:child_process";
        import {syncBuiltinESMExports} from "node:module";
        import {createHmac} from "node:crypto";
        import {writeFileSync} from "node:fs";
        const calls=[];
        globalThis.setTimeout=(callback)=>{callback();return 0};
        cp.spawnSync=(command,args)=>{
          if(command!=="yarn"||args[0]!=="exec"||args[1]!=="wrangler"||args.at(-1)!==".output/wrangler.production.json")
            throw Error("Wrong production operation");
          calls.push(args[2]);writeFileSync("calls.json",JSON.stringify(calls));
          return {status:0};
        };
        syncBuiltinESMExports();
        globalThis.fetch=async(input,init)=>{
          const url=new URL(input);
          if(url.hostname==="api.stripe.com"){
            if(url.pathname!=="/v1/webhook_endpoints/we_fixture")throw Error("Wrong webhook ID");
            const post=init?.method==="POST";
            if(post && init.body.get("disabled")!=="false")throw Error("Webhook not enabled");
            calls.push(post?"webhook:enable":"webhook:verify");writeFileSync("calls.json",JSON.stringify(calls));
            return Response.json({id:"we_fixture",livemode:true,status:post?"enabled":"disabled",
              url:${JSON.stringify(state === "wrong-webhook" ? "https://other.example/webhook" : "https://bascik-shop-production.collin-inbox.workers.dev/api/webhooks/stripe")},
              metadata:{app:"bascik-shop-production"},
              enabled_events:["checkout.session.completed","checkout.session.async_payment_succeeded","checkout.session.async_payment_failed","checkout.session.expired"]});
          }
          if(url.origin!==${JSON.stringify(launch ? "https://shop.bascik.dev" : "https://bascik-shop-production.collin-inbox.workers.dev")})throw Error("Wrong production smoke origin");
          calls.push(url.pathname);writeFileSync("calls.json",JSON.stringify(calls));
          if(url.pathname==="/")return new Response("Prelaunch");
          if(url.pathname==="/api/quote")return Response.json({error:${JSON.stringify(state === "launch" ? "Enter your delivery details." : state === "closed" || state === "launch-closed" ? "Checkout is not open yet. Please check back soon." : "Missing runtime credentials")}}, {status:${state === "launch" ? 400 : 503}});
          if(url.pathname==="/api/webhooks/stripe"){
            const header=init.headers["stripe-signature"];
            const timestamp=header.match(/t=(\\d+)/)[1];
            const expected=createHmac("sha256",process.env.STRIPE_WEBHOOK_SECRET).update(timestamp+"."+init.body).digest("hex");
            if(!header.endsWith("v1="+expected)||JSON.parse(init.body).type!=="prelaunch.probe")throw Error("Unsafe Stripe probe");
          }else if(url.pathname==="/api/webhooks/printful"){
            const expected=createHmac("sha256",Buffer.from(process.env.PRINTFUL_WEBHOOK_SECRET,"hex")).update(init.body).digest("hex");
            if(init.headers["x-pf-webhook-signature"]!==expected||init.headers["x-pf-webhook-public-key"]!==process.env.PRINTFUL_WEBHOOK_PUBLIC_KEY||
              JSON.parse(init.body).data.order.external_id!=="bascik-prelaunch-probe")throw Error("Unsafe Printful probe");
          }else throw Error("Unexpected smoke route");
          return Response.json({received:true});
        };
      `,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fixture,
          resolve("scripts/deploy-production-prelaunch.ts"),
          ...(launch ? ["--launch"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_ACTIONS: "true",
            GITHUB_EVENT_NAME: launch ? "push" : "workflow_dispatch",
            GITHUB_REF: "refs/heads/main",
            GITHUB_REPOSITORY: "bascikdev/bascik",
            CLOUDFLARE_API_TOKEN: "fixture",
            STRIPE_SECRET_KEY: "rk_live_fixture",
            STRIPE_WEBHOOK_SECRET: "whsec_fixture",
            PRINTFUL_TOKEN: "fixture",
            PRINTFUL_WEBHOOK_SECRET: "ab".repeat(32),
            PRINTFUL_WEBHOOK_PUBLIC_KEY: "public_fixture",
            ORDER_TOKEN_SECRET: "cd".repeat(32),
            STRIPE_WEBHOOK_ENDPOINT_ID: "we_fixture",
          },
        },
      );
      const calls = JSON.parse(
        await readFile(join(root, "calls.json"), "utf8"),
      );
      if (state === "wrong-webhook") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("webhook identity mismatch");
        expect(calls).toEqual(["webhook:verify"]);
      } else {
        expect(calls.slice(launch ? 2 : 0, launch ? 5 : 3)).toEqual([
          "d1",
          "secret",
          "deploy",
        ]);
      }
      if (state === "closed" || state === "launch") {
        expect(result.status, result.stderr).toBe(0);
        expect(calls).toContain("/api/webhooks/stripe");
        expect(calls).toContain("/api/webhooks/printful");
      } else if (state !== "wrong-webhook") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          state === "launch-closed"
            ? "checkout is not ready"
            : "checkout gate is not closed",
        );
        expect(calls).not.toContain("/api/webhooks/stripe");
      }
      await expect(
        readFile(join(root, ".output/production-secrets.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
