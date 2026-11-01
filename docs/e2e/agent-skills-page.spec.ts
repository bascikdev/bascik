import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { listSkillNames } from "../scripts/skill-bundle.ts";

for (const width of [1440, 390]) {
  test(`Agent Skills leads with CLI installation and lists every skill at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/agent-skills");
    const content = page.getByTestId("agent-skills-content");
    const headings = await content.locator("h2").allTextContents();
    expect(headings.slice(0, 2)).toEqual(["Install", "The Skills"]);
    expect(headings.at(-1)).toBe("Other Install Methods");
    await expect(content.getByTestId("code-block").first()).toContainText(
      "npx skills add bascikdev/bascik",
    );
    const table = content.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "Install command" }),
    });
    await expect(table).toHaveCount(1);
    const names = await listSkillNames(
      fileURLToPath(new URL("../../skills", import.meta.url)),
    );
    await expect(table.getByRole("row")).toHaveCount(names.length + 1);
    for (const name of names) {
      const row = table.getByRole("row").filter({
        has: page.getByRole("cell", { name, exact: true }),
      });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole("cell").last()).toHaveText(
        `npx skills add bascikdev/bascik --skill ${name}`,
      );
    }
    await expect(
      table.getByRole("row").filter({ hasText: "--skill bascik-refactor" }),
    ).toContainText("Opt-in.");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
