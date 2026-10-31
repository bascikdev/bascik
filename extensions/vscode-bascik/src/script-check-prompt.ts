import * as vscode from "vscode";
import {
  ADD_BUTTON,
  CONFIG_EXCLUDE_GLOB,
  CONFIG_GLOB,
  decideFolder,
  DISMISS_BUTTON,
  DISMISSED_STATE_KEY,
  HTML_LANGUAGE_FEATURES,
  promptMessage,
  type FolderDecision,
} from "./script-check";

/** One information message the extension showed, recorded so the real-editor tests can answer it. */
export interface ScriptCheckPromptRecord {
  folders: string[];
  message: string;
  buttons: string[];
  /** Answers the prompt as a click would; `undefined` closes it. */
  answer(button: string | undefined): void;
  /** Settles once the answer has been acted on. */
  done: Promise<void>;
}

/** What `check()` did. */
export interface ScriptCheckResult {
  /** Why nothing was shown, or `"prompted"`. */
  outcome: "dismissed" | "asked-this-session" | "nothing-to-ask" | "prompted";
  folders: Record<string, FolderDecision>;
}

/**
 * Offers to add `"html.validate.scripts": false` to a Bascik workspace's settings. It never changes a setting on its
 * own: only a click on "Add to workspace settings" writes, and only to the Bascik workspace folders that have no value
 * in user, workspace, or folder settings. User settings are never touched.
 */
export class ScriptCheckPrompt implements vscode.Disposable {
  /** Every prompt shown, oldest first. Read by the real-editor tests. */
  readonly prompts: ScriptCheckPromptRecord[] = [];
  private askedThisSession = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly state: vscode.Memento) {}

  /** Checks now and again whenever folders are added. Returns the first check, which runs in the background. */
  start(): Promise<ScriptCheckResult> {
    this.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.check()),
    );
    return this.check();
  }

  /** Decides for every workspace folder and shows at most one prompt per session. */
  async check(): Promise<ScriptCheckResult> {
    const folders: Record<string, FolderDecision> = {};
    const toAsk: vscode.WorkspaceFolder[] = [];
    const htmlRunning = htmlLanguageFeaturesRunning();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const decision = decideFolder(
        await isBascikFolder(folder),
        vscode.workspace
          .getConfiguration("html", folder)
          .inspect<boolean>("validate.scripts"),
        htmlRunning,
      );
      folders[folder.name] = decision;
      if (decision === "ask") toAsk.push(folder);
    }
    if (toAsk.length === 0) return { outcome: "nothing-to-ask", folders };
    if (this.isDismissed()) {
      return { outcome: "dismissed", folders };
    }
    if (this.askedThisSession)
      return { outcome: "asked-this-session", folders };
    this.askedThisSession = true;
    this.show(toAsk);
    return { outcome: "prompted", folders };
  }

  private show(folders: vscode.WorkspaceFolder[]): void {
    const names = folders.map((folder) => folder.name);
    const message = promptMessage(names);
    const buttons = [ADD_BUTTON, DISMISS_BUTTON];
    let answer!: (button: string | undefined) => void;
    const answered = new Promise<string | undefined>((resolve) => {
      answer = resolve;
    });
    vscode.window
      .showInformationMessage(message, ...buttons)
      .then(answer, () => answer(undefined));
    const done = answered.then((button) => this.act(button, folders));
    this.prompts.push({ folders: names, message, buttons, answer, done });
  }

  private async act(
    button: string | undefined,
    folders: vscode.WorkspaceFolder[],
  ): Promise<void> {
    if (button === DISMISS_BUTTON) {
      await this.state.update(DISMISSED_STATE_KEY, true);
      return;
    }
    if (button !== ADD_BUTTON) return;
    for (const folder of folders) {
      const config = vscode.workspace.getConfiguration("html", folder);
      // Someone may have set it while the prompt was open; their value wins.
      if (
        decideFolder(
          true,
          config.inspect("validate.scripts"),
          htmlLanguageFeaturesRunning(),
        ) !== "ask"
      ) {
        continue;
      }
      try {
        // WorkspaceFolder writes `<folder>/.vscode/settings.json`, merged with what is there, in single-folder and
        // multi-root workspaces alike.
        await config.update(
          "validate.scripts",
          false,
          vscode.ConfigurationTarget.WorkspaceFolder,
        );
      } catch (error) {
        void vscode.window.showWarningMessage(
          `Bascik could not add "html.validate.scripts": false to ${folder.name}/.vscode/settings.json: ${String(error)}`,
        );
      }
    }
  }

  /** Whether someone picked "Don't ask again" in this workspace. */
  isDismissed(): boolean {
    return this.state.get<boolean>(DISMISSED_STATE_KEY) === true;
  }

  /** For the real-editor tests: forget this session's prompt, as a new window would. */
  forgetSession(): void {
    this.askedThisSession = false;
  }

  /** For the real-editor tests: drop a stored "Don't ask again" so a later test in the same run sees the prompt. */
  clearDismissal(): Thenable<void> {
    return this.state.update(DISMISSED_STATE_KEY, undefined);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
  }
}

/** A disabled extension is missing from `vscode.extensions`, so presence means VS Code checks inline scripts. */
function htmlLanguageFeaturesRunning(): boolean {
  return vscode.extensions.getExtension(HTML_LANGUAGE_FEATURES) !== undefined;
}

/** A folder is a Bascik project when it holds a Bascik config outside installed packages, build output, and git. */
async function isBascikFolder(
  folder: vscode.WorkspaceFolder,
): Promise<boolean> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, CONFIG_GLOB),
    new vscode.RelativePattern(folder, CONFIG_EXCLUDE_GLOB),
    1,
  );
  return found.length > 0;
}
