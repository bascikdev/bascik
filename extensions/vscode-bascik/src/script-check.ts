/**
 * The decisions behind the "html.validate.scripts" prompt, kept apart from the `vscode` module so they can be
 * unit tested. `script-check-prompt.ts` asks the editor and acts on the answer.
 *
 * VS Code's built-in HTML checker joins every `<script>` without `type="module"` in a file into one JavaScript
 * file, so a Bascik page with two scripts that each `export default` shows "A module cannot have multiple default
 * exports". Bascik runs each script on its own. The extension never changes the setting on its own: it asks once,
 * in a Bascik workspace, and writes the answer to that workspace's settings only.
 */

/** The setting the prompt offers to add, as it is written in `settings.json`. */
export const HTML_VALIDATE_SCRIPTS = "html.validate.scripts";

/**
 * The built-in extension that checks inline scripts and contributes `html.validate.scripts`. When someone disables
 * it, the false error cannot appear and the setting is not registered, so there is nothing to ask about.
 */
export const HTML_LANGUAGE_FEATURES = "vscode.html-language-features";

/** Config file names that make a folder a Bascik project. Matches the language server's `CONFIG_FILE_CANDIDATES`. */
export const CONFIG_FILE_NAMES = [
  "bascik.config.js",
  "bascik.config.mjs",
  "bascik.config.ts",
];

/** Glob for a Bascik config anywhere in a workspace folder. */
export const CONFIG_GLOB = "**/bascik.config.{ts,js,mjs}";

/** Folders the language server never treats as a project: installed packages, build output, and git internals. */
export const CONFIG_EXCLUDE_GLOB = "**/{node_modules,dist,.git}/**";

export const ADD_BUTTON = "Add to workspace settings";
export const DISMISS_BUTTON = "Don't ask again";

/** `workspaceState` key that holds `true` once someone picks "Don't ask again" in this workspace. */
export const DISMISSED_STATE_KEY = "bascik.htmlValidateScripts.dontAsk";

/**
 * The parts of `WorkspaceConfiguration.inspect` the decision reads. Language values (`"[html]": { ... }`) are left
 * out on purpose: this setting is not language-overridable, VS Code's HTML language server ignores an `[html]` value
 * for it, so the false error still shows and a value set only there must not stop the prompt.
 */
export interface SettingInspection {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/** Why a folder was or was not part of a prompt. */
export type FolderDecision =
  /** No Bascik config in the folder. */
  | "not-bascik"
  /** The user, the workspace, or the folder already set the value, either way. */
  | "already-set"
  /** Nobody set it, but it does not resolve to `true` (another extension's default, for example). */
  | "already-off"
  /** VS Code's HTML language features are disabled, so nothing checks inline scripts and the setting does not exist. */
  | "no-html-check"
  /** Bascik project, nobody set the value, and VS Code checks inline scripts there. */
  | "ask";

/**
 * Should this Bascik folder be offered the setting? Only when VS Code's HTML language features run and nobody chose a
 * value at any level, so a person's own choice, in either direction, is never questioned.
 */
export function decideFolder(
  isBascik: boolean,
  setting: SettingInspection | undefined,
  htmlLanguageFeaturesRunning = true,
): FolderDecision {
  if (!isBascik) return "not-bascik";
  if (!htmlLanguageFeaturesRunning) return "no-html-check";
  const chosen = [
    setting?.globalValue,
    setting?.workspaceValue,
    setting?.workspaceFolderValue,
  ];
  if (chosen.some((value) => value !== undefined)) return "already-set";
  const effective = setting?.defaultValue ?? true;
  return effective === true ? "ask" : "already-off";
}

/** The information message: what VS Code reports, why it is wrong for Bascik pages, and what the button changes. */
export function promptMessage(folderNames: readonly string[]): string {
  const where =
    folderNames.length === 1
      ? `"${folderNames[0]}"`
      : folderNames.map((name) => `"${name}"`).join(", ");
  return (
    `Bascik: VS Code checks every <script> in an HTML file as one JavaScript file, so a page with two scripts ` +
    `that each export default shows "A module cannot have multiple default exports". Bascik runs each script on ` +
    `its own, so that error is false. Add "${HTML_VALIDATE_SCRIPTS}": false to the workspace settings of ${where}? ` +
    `It turns off only VS Code's check of code inside <script> tags in .html files.`
  );
}
