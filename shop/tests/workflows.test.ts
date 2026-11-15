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
test("deployment scripts importing the shop catalog have the package HTML helpers built", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  for (const job of [
    "deploy-preview",
    "deploy-production-prelaunch",
    "deploy-production",
  ]) {
    const block = workflow.split(`  ${job}:`)[1].split(/^  [a-z-]+:/m)[0];
    expect(block).toContain("- run: yarn pkg:build");
    expect(block.indexOf("- run: yarn pkg:build")).toBeLessThan(
      block.indexOf("run: node scripts/") === -1
        ? block.indexOf("run: |")
        : block.indexOf("run: node scripts/"),
    );
  }
});
test("commerce previews deploy only trusted branch pushes after validation", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  const preview = workflow
    .split("  deploy-preview:")[1]
    .split("  deploy-sandbox:")[0];
  expect(preview).toContain("needs: validate");
  expect(preview).toContain("github.event_name == 'push'");
  expect(preview).toContain("github.ref != 'refs/heads/main'");
  expect(preview).toContain("github.repository == 'bascikdev/bascik'");
  expect(preview).toContain("environment: shop-preview");
  expect(preview).not.toContain("pull_request_target");
  const deploy = readFileSync("scripts/deploy-preview.ts", "utf8");
  expect(deploy).toContain("pulls[0].head.sha !== process.env.GITHUB_SHA");
  expect(deploy).toContain('SHOP_MODE: "test"');
  expect(deploy).toContain("config.send_email?.length");
  expect(deploy).toContain("bascik-shop-pr-${pr}");
});
test("a preview removes the Stripe endpoints of closed pull requests before it asks for its own", () => {
  // Stripe refuses a seventeenth endpoint, and nothing runs when a pull
  // request closes, so every preview clears the leftovers first.
  const deploy = readFileSync("scripts/deploy-preview.ts", "utf8");
  const cleanup = deploy.indexOf("!openPulls.has(entry.metadata.pr)");
  const create = deploy.indexOf('"metadata[app]": "bascik-shop-preview"');
  expect(cleanup).toBeGreaterThan(-1);
  expect(cleanup).toBeLessThan(create);
  // Only endpoints this script made, and never one of an open pull request.
  expect(deploy).toContain('entry.metadata.app === "bascik-shop-preview"');
  expect(deploy).toContain("pulls?state=open&per_page=100");
  expect(deploy).toContain("if (!openPulls.has(String(pr)))");
});
test("main deployments cannot be cancelled by a later main push", () => {
  const workflow = readFileSync("../.github/workflows/shop.yml", "utf8");
  expect(workflow).toContain(
    "cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}",
  );
});
