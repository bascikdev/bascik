/**
 * @module lost-placeholders
 *
 * A server or stream script of a built page lives in the private folder's
 * sidecar (`server-scripts.json`); the page keeps only a placeholder,
 * `<script type="text/bascik-server" data-bascik-server-id="…">`, where its
 * output goes. A step that edits the page after it was written (a `post`
 * exec script, a minifier, a deploy rewrite) can remove that placeholder, or
 * rewrite it into something a browser does not read as one, and the script
 * then never runs while the page is served without it.
 *
 * Both checks share this text: `bascik --build` (plain and `--target`)
 * fails after its `post` phase, and `bascik --server` refuses to start, for
 * a dist/ edited after the build. Each names the page, how many scripts the
 * sidecar holds for it, and the tag to paste back.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getHtmlAttributeValue, scanRequestScripts } from "./html-patterns.ts";
import {
  serverScriptPagePath,
  type ServerScriptEntry,
} from "./server-sidecar.ts";
import { privateDirFor, privateDirLabel } from "./private-dir.ts";

/**
 * The `data-bascik-server-id` of every placeholder (or directive block that
 * carries one) in `html`, found the way the server's planner finds them.
 */
export const placeholderIdsInHtml = (html: string): Set<string> => {
  const ids = new Set<string>();
  for (const match of scanRequestScripts(html, true)) {
    const id = getHtmlAttributeValue(
      html.slice(match.start, match.end),
      "data-bascik-server-id",
    );
    if (id) ids.add(id);
  }
  return ids;
};

/**
 * One message per page whose server-script placeholder the sidecar holds
 * but the page no longer has. `found` maps each page present in the output
 * directory (`pages/<path relative to it>`) to the placeholder ids it has;
 * a page that is gone from it entirely is not served at all and is skipped.
 */
export const lostPlaceholderMessages = (
  found: ReadonlyMap<string, ReadonlySet<string>>,
  scripts: Readonly<Record<string, Pick<ServerScriptEntry, "mode">>>,
  outDirRel: string,
  privateRel: string,
): string[] => {
  const held = new Map<string, { total: number; lost: string[] }>();
  for (const id of Object.keys(scripts).sort()) {
    const pagePath = serverScriptPagePath(id)?.replace(/\\/g, "/");
    const ids = pagePath === undefined ? undefined : found.get(pagePath);
    if (!pagePath || !ids) continue;
    const entry = held.get(pagePath) ?? { total: 0, lost: [] };
    entry.total++;
    if (!ids.has(id)) entry.lost.push(id);
    held.set(pagePath, entry);
  }
  const messages: string[] = [];
  for (const [pagePath, { total, lost }] of [...held].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (lost.length === 0) continue;
    const page = `${outDirRel}/${pagePath.replace(/^pages\//, "")}`;
    const count = `${total} server script${total === 1 ? "" : "s"}`;
    const gone =
      lost.length === total
        ? total === 1
          ? "the page has no placeholder for it"
          : "the page has none of their placeholders"
        : `${lost.length} of their placeholders ${lost.length === 1 ? "is" : "are"} gone`;
    // The tag the build wrote for the first lost script, so it can be put
    // back as it is: a stream placeholder carries its mode marker.
    const marker =
      scripts[lost[0]]?.mode === "stream" ? " data-bascik-stream" : "";
    messages.push(
      `${page}: ${privateRel}/server-scripts.json holds ${count} for this page, but ${gone} ` +
        `(\`<script type="text/bascik-server" data-bascik-server-id="${lost[0]}"${marker}></script>\`)`,
    );
  }
  return messages;
};

/**
 * The whole refusal for `lost` (from lostPlaceholderMessages): `lead` opens
 * it (`--server: production startup validation failed.`), `cause` names
 * what removed the placeholders.
 */
export const lostPlaceholderError = (
  lead: string,
  lost: readonly string[],
  cause: string,
): string =>
  `[bascik] ${lead} ${lost.slice(0, 5).join("; ")}` +
  `${lost.length > 5 ? `; and ${lost.length - 5} more pages` : ""}. ${cause} removed or rewrote ` +
  `the placeholder, so its server script cannot run. Keep each placeholder's \`type\` and ` +
  `\`data-bascik-server-id\` (a browser reads any quoting, case or attribute order the same way): ` +
  `a minifier keeps it when it does not remove empty elements. A page that should have no server ` +
  `script needs it removed from the source and a new \`bascik --build\`.`;

/**
 * Fail the build when a page in `outDir` lost a placeholder the committed
 * sidecar holds a script for. Runs after the `post` exec phase and the
 * ownership commit, on dist/ as it ships; only the pages the sidecar holds
 * scripts for are read. No sidecar (a static site) passes.
 */
export const assertPlaceholdersKept = async (
  outDir: string,
  outDirRel: string,
): Promise<void> => {
  let scripts: Record<string, ServerScriptEntry>;
  try {
    scripts =
      (
        JSON.parse(
          await readFile(
            join(privateDirFor(outDir), "server-scripts.json"),
            "utf8",
          ),
        ) as { scripts?: Record<string, ServerScriptEntry> }
      ).scripts ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const pagePaths = new Set<string>();
  for (const id of Object.keys(scripts)) {
    const pagePath = serverScriptPagePath(id)?.replace(/\\/g, "/");
    if (pagePath?.startsWith("pages/")) pagePaths.add(pagePath);
  }
  const found = new Map<string, Set<string>>();
  for (const pagePath of [...pagePaths].sort()) {
    let html: string;
    try {
      html = await readFile(join(outDir, pagePath.slice(6)), "utf8");
    } catch (err) {
      // A script removed the page: it is not served, so nothing is lost.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    found.set(pagePath, placeholderIdsInHtml(html));
  }
  const lost = lostPlaceholderMessages(
    found,
    scripts,
    outDirRel,
    privateDirLabel(outDir),
  );
  if (lost.length > 0)
    throw new Error(
      lostPlaceholderError(
        "--build: a page lost a server-script placeholder after the build wrote it.",
        lost,
        "A `post` exec script",
      ),
    );
};
