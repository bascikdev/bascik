import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = fileURLToPath(new URL("..", import.meta.url));
const nestedPagePath = join(e2eDir, "base-fixture/src/pages/nested/index.html");

test("serves a subdirectory deployment consistently", async ({
  page,
  request,
}, testInfo) => {
  await page.goto("/sub/nested/");
  await expect(page.getByTestId("status")).toHaveText(
    "Nested base fixture ready",
  );
  await expect(page.getByTestId("hero")).toHaveAttribute(
    "src",
    "/sub/image.svg",
  );
  await expect(page.getByTestId("hero")).toHaveAttribute(
    "srcset",
    "/sub/image.svg 1x, https://cdn.example.com/image.svg 2x",
  );
  await expect(page.getByTestId("mail")).toHaveAttribute(
    "href",
    "mailto:test@example.com",
  );
  await expect(page.getByTestId("fragment")).toHaveAttribute(
    "href",
    "#details",
  );
  await expect
    .poll(async () =>
      page
        .getByTestId("status")
        .evaluate(
          (element) =>
            getComputedStyle(element.closest("main")!).backgroundImage,
        ),
    )
    .toContain("/sub/image.svg");

  expect((await request.get("/sub/image.svg")).status()).toBe(200);

  // Under a base, the site root is the base, so /.well-known/ lives below it.
  const wellKnown = await request.get("/sub/.well-known/security.txt");
  expect(wellKnown.status()).toBe(200);
  expect(await wellKnown.text()).toContain("Contact: mailto:base@example.com");
  expect((await request.get("/.well-known/security.txt")).status()).toBe(404);
  expect((await request.get("/sub/.env")).status()).toBe(404);

  if (testInfo.project.name === "base-static") {
    const sitemap = await (await request.get("/sub/sitemap.xml")).text();
    expect(sitemap).toContain("http://localhost:9550/sub/nested/");
  } else {
    expect((await request.get("/nested/")).status()).toBe(404);
  }
});

test("live reload reconnects through the configured base", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "base-dev");
  const original = await readFile(nestedPagePath, "utf8");
  try {
    await page.goto("/sub/nested/");
    await writeFile(
      nestedPagePath,
      original.replace(
        "Nested base fixture ready",
        "Nested base fixture updated",
      ),
    );
    await expect(page.getByTestId("status")).toHaveText(
      "Nested base fixture updated",
    );
  } finally {
    await writeFile(nestedPagePath, original);
  }
});

// Lives in the base fixture because it is the one fixture whose dev server leaves JS unminified.
test("component script errors report the line in the component file", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "base-dev",
    "only the dev server leaves JS unminified by default",
  );
  const errors: Error[] = [];
  page.on("pageerror", (err) => errors.push(err));
  await page.goto("/sub/source-lines");

  await page.getByTestId("line-note-first").click();
  await page.getByTestId("line-note-second").click();

  // line-note.html throws on line 11. A <style> block above the script is extracted before
  // scripts are scoped, so the line only survives if it was recorded from the file itself.
  expect(
    errors.map((err) =>
      /\((src\/components\/line-note\.html[^:]*):(\d+):\d+\)/
        .exec(err.stack ?? "")
        ?.slice(1),
    ),
  ).toEqual([
    ["src/components/line-note.html", "11"],
    ["src/components/line-note.html?instance=2", "11"],
  ]);
});
