/// <reference lib="dom" />

/**
 * /semantic-html practices what it teaches: its checklist says a page with more than one <nav> names each one, so
 * the demo Previews on the page must not add a landmark whose name another landmark already has (the docs header
 * is navigation "Main"; a demo <site-nav aria-label="Main" /> made a second one, which a screen reader's landmark
 * list shows as two identical entries).
 */
import { test, expect } from "@playwright/test";

const LANDMARK =
  /^\s*- (banner|navigation|main|contentinfo|complementary|region|form|search)(?: "([^"]*)")?/;

test("every landmark on /semantic-html has a name no other landmark of its role shares", async ({
  page,
}) => {
  await page.goto("/semantic-html");
  const snapshot = await page.locator("body").ariaSnapshot();
  const landmarks = snapshot
    .split("\n")
    .map((line) => LANDMARK.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]} "${m[2] ?? ""}"`);
  expect(landmarks).toContain('navigation "Main"');
  // The good nav demo's Preview is a real navigation landmark, under its own name.
  expect(landmarks).toContain('navigation "Demo site"');
  const repeated = landmarks.filter((name, i) => landmarks.indexOf(name) !== i);
  expect(repeated, snapshot).toEqual([]);
});
