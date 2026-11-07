import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  assertProductionPrelaunch,
  assertProductionLaunch,
  productionLaunch,
  type ProductionConfig,
} from "../scripts/production-config.ts";

const authored: ProductionConfig = JSON.parse(
  readFileSync("wrangler.production.json", "utf8"),
);

test("production prelaunch is isolated from sandbox, previews and the live hostname", () => {
  expect(() => assertProductionPrelaunch(authored)).not.toThrow();
  const sandbox = readFileSync("wrangler.jsonc", "utf8");
  expect(sandbox).not.toContain(authored.name);
  expect(sandbox).not.toContain(authored.d1_databases[0].database_id);
  expect(authored.vars.SHOP_ORIGIN).not.toBe("https://shop.bascik.dev");
});

const unsafe: [string, (config: ProductionConfig) => void][] = [
  [
    "checkout",
    (config) => {
      config.vars.SHOP_ENABLED = "true";
    },
  ],
  [
    "fulfillment",
    (config) => {
      config.vars.SHOP_FULFILLMENT_ENABLED = "true";
    },
  ],
  [
    "sandbox mode",
    (config) => {
      config.vars.SHOP_MODE = "test";
    },
  ],
  [
    "hostname takeover",
    (config) => {
      config.routes = [{ pattern: "shop.bascik.dev", custom_domain: true }];
    },
  ],
  [
    "wrong origin",
    (config) => {
      config.vars.SHOP_ORIGIN = "https://shop.bascik.dev";
    },
  ],
  [
    "sandbox database",
    (config) => {
      config.d1_databases[0].database_id =
        "17c831f5-82a4-4094-ad10-5489830c6ae2";
    },
  ],
  [
    "extra database",
    (config) => {
      config.d1_databases.push(config.d1_databases[0]);
    },
  ],
  [
    "wrong account",
    (config) => {
      config.account_id = "another-account";
    },
  ],
  [
    "Shopify store",
    (config) => {
      config.vars.PRINTFUL_STORE_ID = "18630655";
    },
  ],
  [
    "shared queue",
    (config) => {
      config.queues.producers[0].queue = "bascik-shop-pr-129-jobs";
    },
  ],
  [
    "shared consumer",
    (config) => {
      config.queues.consumers[0].queue = "bascik-shop-sandbox-jobs";
    },
  ],
  [
    "shared dead-letter queue",
    (config) => {
      config.queues.consumers[0].dead_letter_queue = "bascik-shop-sandbox-dead";
    },
  ],
  [
    "unrestricted sender",
    (config) => {
      config.send_email[0].allowed_sender_addresses = [];
    },
  ],
];
test.each(unsafe)("production prelaunch rejects %s", (_name, mutate) => {
  const config = structuredClone(authored);
  mutate(config);
  expect(() => assertProductionPrelaunch(config)).toThrow(
    "Unsafe production prelaunch",
  );
});

test("production deployment is manual, main-only, owner-repository-only and gated by validation", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  const job = workflow.split("  deploy-production-prelaunch:")[1];
  expect(job).toContain("needs: validate");
  expect(job).toContain("github.event_name == 'workflow_dispatch'");
  expect(job).toContain("inputs.deploy_production_prelaunch");
  expect(job).toContain("github.ref == 'refs/heads/main'");
  expect(job).toContain("github.repository == 'bascikdev/bascik'");
  expect(job).toContain("environment: shop-production");
  expect(job).toContain("node scripts/check-live-providers.ts");
  expect(job).toContain("node scripts/deploy-production-prelaunch.ts");
});

test("live launch changes only the approved domain and commerce flags", () => {
  const config = productionLaunch(authored);
  expect(() => assertProductionLaunch(config)).not.toThrow();
  expect(() => assertProductionPrelaunch(config)).toThrow();
  expect(authored.vars.SHOP_ENABLED).toBe("false");
  expect(config.routes).toEqual([
    { pattern: "shop.bascik.dev", custom_domain: true },
  ]);
  expect(config.vars).toMatchObject({
    SHOP_ORIGIN: "https://shop.bascik.dev",
    SHOP_ENABLED: "true",
    SHOP_FULFILLMENT_ENABLED: "true",
  });
  expect(config.d1_databases).toEqual(authored.d1_databases);
  expect(config.queues).toEqual(authored.queues);
});

test.each([
  ...unsafe.filter(
    ([name]) =>
      ![
        "checkout",
        "fulfillment",
        "hostname takeover",
        "wrong origin",
      ].includes(name),
  ),
  [
    "closed checkout",
    (config: ProductionConfig) => {
      config.vars.SHOP_ENABLED = "false";
    },
  ],
  [
    "closed fulfillment",
    (config: ProductionConfig) => {
      config.vars.SHOP_FULFILLMENT_ENABLED = "false";
    },
  ],
  [
    "wrong launch origin",
    (config: ProductionConfig) => {
      config.vars.SHOP_ORIGIN = "https://bascik.dev";
    },
  ],
  [
    "docs domain",
    (config: ProductionConfig) => {
      config.routes = [{ pattern: "bascik.dev", custom_domain: true }];
    },
  ],
  [
    "route instead of domain",
    (config: ProductionConfig) => {
      config.routes = [{ pattern: "shop.bascik.dev", custom_domain: false }];
    },
  ],
  [
    "extra hostname",
    (config: ProductionConfig) => {
      config.routes = [
        { pattern: "shop.bascik.dev", custom_domain: true },
        { pattern: "bascik.dev", custom_domain: true },
      ];
    },
  ],
] satisfies [string, (config: ProductionConfig) => void][])(
  "live launch rejects %s",
  (_name, mutate) => {
    const config = productionLaunch(authored);
    mutate(config);
    expect(() => assertProductionLaunch(config)).toThrow();
  },
);

test("live deployments run only validated trusted main pushes or explicit main dispatch", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  const job = workflow.split("  deploy-production:")[1];
  expect(job).toContain("needs: validate");
  expect(job).toContain("github.event_name == 'push'");
  expect(job).toContain("inputs.deploy_production");
  expect(job).toContain("github.ref == 'refs/heads/main'");
  expect(job).toContain("github.repository == 'bascikdev/bascik'");
  expect(job).toContain("environment: shop-production");
  expect(job).toContain("node scripts/check-live-providers.ts --launch");
  expect(job).toContain("node scripts/deploy-production-prelaunch.ts --launch");
});
