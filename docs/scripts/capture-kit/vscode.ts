/**
 * Launches an isolated VS Code window with the repo's compiled Bascik extension and drives it over the
 * Chromium DevTools protocol. The window has its own user-data and extensions directories, so your own
 * settings and installed extensions are never touched.
 *
 * macOS only: it uses the app bundle path and Cmd shortcuts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const kitDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(kitDir, '../../..');
const codeBinary = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const debugPort = 9333;

export const LINE_HEIGHT = 24;
export const TAB_HEIGHT = 35;
export const TOP_PADDING = 12;

export const press = async (page: Page, ...keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};

function editorSettings(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.activityBar.location': 'hidden',
    'workbench.statusBar.visible': false,
    'workbench.layoutControl.enabled': false,
    'workbench.tips.enabled': false,
    'workbench.editor.showTabs': 'single',
    'window.titleBarStyle': 'custom',
    'window.commandCenter': false,
    'window.restoreWindows': 'none',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'editor.minimap.enabled': false,
    'editor.fontSize': 15,
    'editor.lineHeight': LINE_HEIGHT,
    'editor.fontFamily': 'Menlo, Monaco, "Courier New", monospace',
    'editor.padding.top': TOP_PADDING,
    'editor.scrollBeyondLastLine': false,
    'editor.wordBasedSuggestions': 'off',
    'editor.suggest.showStatusBar': false,
    'editor.quickSuggestions': { other: false, comments: false, strings: false },
    'editor.suggestOnTriggerCharacters': false,
    'editor.autoClosingBrackets': 'never',
    'editor.renderLineHighlight': 'none',
    // A blinking caret would make otherwise identical frames differ and bloat the animation.
    'editor.cursorBlinking': 'solid',
    'editor.occurrencesHighlight': 'off',
    'editor.selectionHighlight': false,
    'editor.guides.indentation': false,
    'editor.stickyScroll.enabled': false,
    'breadcrumbs.enabled': false,
    // Autosave keeps the tab free of the unsaved-changes dot after a scene types text.
    'files.autoSave': 'afterDelay',
    'files.autoSaveDelay': 100,
    'git.enabled': false,
    'chat.commandCenter.enabled': false,
    'chat.disableAIFeatures': true,
    ...overrides,
  };
}

async function installExtension(extensionsDir: string): Promise<void> {
  const source = join(repoDir, 'extensions/vscode-bascik');
  const target = join(extensionsDir, 'bascik.bascik-vscode-0.0.0');
  await mkdir(target, { recursive: true });
  for (const entry of ['package.json', 'syntaxes', 'snippets', 'icon.png', 'LICENSE']) {
    await cp(join(source, entry), join(target, entry), { recursive: true });
  }
  await cp(join(source, 'dist'), join(target, 'dist'), {
    recursive: true,
    filter: (path) => !path.includes('/test') && !path.endsWith('.test.js'),
  });
}

async function waitForPort(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  throw new Error('VS Code did not expose the DevTools port in time');
}

export interface VsCodeSession {
  page: Page;
  browser: Browser;
  /** The directory VS Code opened as its workspace. */
  projectDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** Opens this existing directory instead of a new empty one. `prepare` is not called for it. */
  projectDir?: string;
  /** Fills a new workspace before VS Code opens it. */
  prepare?: (projectDir: string) => Promise<void>;
  /** Overrides for the default editor settings. */
  settings?: Record<string, unknown>;
}

export async function launchVsCode({ projectDir: existingDir, prepare, settings = {} }: LaunchOptions): Promise<VsCodeSession> {
  const base = await mkdtemp(join(tmpdir(), 'bascik-shots-'));
  const projectDir = existingDir ?? join(base, 'project');
  const extensionsDir = join(base, 'extensions');
  const userDataDir = join(base, 'user-data');
  if (!existingDir) {
    await mkdir(projectDir, { recursive: true });
    await prepare?.(projectDir);
  }
  await installExtension(extensionsDir);
  await mkdir(join(userDataDir, 'User'), { recursive: true });
  await writeFile(join(userDataDir, 'User/settings.json'), JSON.stringify(editorSettings(settings), null, 2));

  // Strip the variables an integrated terminal sets, so this window starts as a standalone VS Code.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  const code: ChildProcess = spawn(
    codeBinary,
    [
      projectDir,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--remote-debugging-port=${debugPort}`,
      '--new-window',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-workspace-trust',
      '--disable-extensions-except=bascik.bascik-vscode',
    ],
    { env, stdio: 'ignore' },
  );

  const close = async () => {
    code.kill();
    // Electron leaves helper processes behind; end everything started with this run's profile.
    spawnSync('pkill', ['-f', base]);
    if (process.env.KEEP_TEMP) console.log(`kept ${base}`);
    else await rm(base, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await waitForPort();
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    let page = context.pages().find((candidate) => candidate.url().includes('workbench'));
    if (!page) page = await context.waitForEvent('page');
    await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
    await page.waitForTimeout(3000);
    // Give the editor the whole window: hide the Explorer (Cmd+B) and the secondary side bar (Cmd+Option+B).
    await press(page, 'Meta+b', 'Meta+Alt+b');
    await page.waitForTimeout(500);
    return {
      page,
      browser,
      projectDir,
      close: async () => {
        await browser.close().catch(() => undefined);
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Resizes the window content area while keeping 2x pixel density for crisp screenshots. */
export async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** Opens a file with Quick Open and confirms the editor tab shows it, retrying while the file index warms up. */
export async function openFile(page: Page, fileName: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await press(page, 'Meta+p');
    await page.keyboard.type(fileName);
    await page.waitForTimeout(700);
    await press(page, 'Enter');
    await page.waitForTimeout(500);
    const label = await page.locator('.editor-group-container .title-label').first().textContent();
    if (label?.trim().startsWith(fileName)) return;
  }
  throw new Error(`Could not open ${fileName}`);
}

/** Moves the cursor with Go to Line. */
export async function gotoLine(page: Page, line: number, column: number): Promise<void> {
  await press(page, 'Control+g');
  await page.keyboard.type(`${line}:${column}`);
  await press(page, 'Enter');
  await page.waitForTimeout(500);
}

/**
 * Takes a picture straight through the browser protocol. Playwright's own screenshot call dismisses a
 * keyboard-triggered hover once it has taken the picture, so frames after the first would lose it.
 */
export async function createCapture(page: Page): Promise<(area: { x: number; y: number; width: number; height: number }) => Promise<Buffer>> {
  const session = await page.context().newCDPSession(page);
  return async (area) => {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', clip: { ...area, scale: 1 } });
    return Buffer.from(data, 'base64');
  };
}
