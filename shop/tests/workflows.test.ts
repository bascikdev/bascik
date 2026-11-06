import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

function eventBlock(file: string, event: string) {
  const text = readFileSync(`../.github/workflows/${file}.yml`, "utf8");
  const on = text.match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1];
  const block = on?.match(
    new RegExp(`^  ${event}:\\n([\\s\\S]*?)(?=^  \\w|(?![\\s\\S]))`, "m"),
  )?.[1];
  if (!block) throw new Error(`Missing ${event} trigger in ${file}`);
  return block;
}

test.each(["ci", "codeql"])(
  "%s excludes shop-only push and pull request events",
  (workflow) => {
    for (const event of ["push", "pull_request"]) {
      const block = eventBlock(workflow, event);
      expect(block).toMatch(/paths-ignore:\n\s+- "shop\/\*\*"/);
      expect(block).not.toMatch(/^\s+paths:/m);
    }
  },
);

test("shop workflow includes the shop and shared dependencies on both events", () => {
  for (const event of ["push", "pull_request"]) {
    const block = eventBlock("shop", event);
    for (const path of [
      "shop/**",
      "pkg/**",
      "adapters/cloudflare/**",
      "package.json",
      "yarn.lock",
      ".github/workflows/shop.yml",
    ])
      expect(block).toContain(`"${path}"`);
  }
});

test("scheduled CodeQL remains enabled", () => {
  expect(eventBlock("codeql", "schedule")).toContain("cron:");
});
test("sandbox deployment is manual, main-only, and includes the entire asset bundle", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  expect(workflow).toContain(
    "github.event_name == 'workflow_dispatch' && inputs.deploy_sandbox && github.ref == 'refs/heads/main'",
  );
  expect(workflow).toContain("needs: validate");
  expect(workflow).toContain("environment: shop-sandbox");
  for (const path of ["worker.js", "wrangler.json", "public/", "migrations/"])
    expect(workflow).toContain(`shop/.output/${path}`);
  expect(workflow).toContain("secrets.SHOP_CLOUDFLARE_API_TOKEN");
  expect(workflow).toContain('c.vars.SHOP_ENABLED!=="false"');
  expect(workflow).toContain('c.vars.SHOP_FULFILLMENT_ENABLED!=="false"');
});
