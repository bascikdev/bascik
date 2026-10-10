/**
 * Captures the WebP screenshots on /tools/vscode-extension from a real VS Code window running the real
 * extension, so the page shows what the extension actually does instead of static code samples.
 *
 * How it works: it builds a throwaway Bascik project, installs the repo's compiled extension into a throwaway
 * extensions directory, launches an isolated VS Code (own user-data-dir, so your settings are untouched),
 * drives it over the Chromium DevTools protocol, and screenshots each scene to WebP.
 *
 * A scene is either a single still, or a storyboard: it calls `rec.frame(holdMs)` after each step (a keystroke, a
 * popup opening) and the frames become an animated WebP. Frames are captured one step at a time rather than
 * recorded live, so timing is exact and does not depend on how fast this machine renders. An animated scene also
 * gets a `-still` copy of its last frame, which the docs serve to visitors who prefer reduced motion.
 *
 * Maintainer tool only: it is not part of the docs build. Run after `yarn ext:compile` (macOS):
 *   node scripts/capture-vscode-screenshots.ts [sceneName ...]
 *
 * Set KEEP_TEMP=1 to keep the throwaway profile for inspection, DEBUG_FULL=1 to also save a full-window PNG
 * per scene to /tmp.
 *
 * Output: docs/src/pages/assets/vscode/<scene>@2x.webp, plus <scene>-still@2x.webp for animated scenes
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import sharp from 'sharp';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(docsDir, '..');
const outDir = join(docsDir, 'src/pages/assets/vscode');
const codeBinary = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const debugPort = 9333;

/** Default window content size in CSS pixels. Screenshots are taken at 2x pixel density. */
const WIDTH = 780;
const HEIGHT = 720;
const LINE_HEIGHT = 24;
const TAB_HEIGHT = 35;
const TOP_PADDING = 12;

interface Scene {
  /** Output file name without extension. */
  name: string;
  /** Path of the file to open, relative to the project root. */
  file: string;
  /** File content. A single `|` marks where the cursor goes and is removed from the file. */
  content: string;
  /**
   * Puts the editor in the state to capture (open a popup, show a hover, and so on). A scene that never calls
   * `rec.frame` is captured once, after a short settle, as a still image.
   */
  run: (page: Page, rec: Recorder) => Promise<void>;
  /** Visible editor lines to keep when cropping. */
  lines: number;
  /** Extra pixels below the last kept line, for popups that hang under the cursor. */
  extraHeight?: number;
  /** Window width in CSS pixels. Defaults to WIDTH. Long popups wrap at the window edge. */
  width?: number;
}

/** Collects the frames of one scene. */
interface Recorder {
  /** Captures the editor as it looks now and keeps it on screen for `holdMs`. */
  frame(holdMs: number): Promise<void>;
  /**
   * Types `text` and captures a frame after every `every` characters, each held roughly as long as that many
   * characters take to type.
   */
  type(text: string, options?: { every?: number; msPerChar?: number }): Promise<void>;
}

const bascikConfig = `import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({});
`;

const userCard = `<!-- @bascik
Displays a person's identity and available actions.
@prop role - The person's role or job title.
@slot actions - Controls displayed after the profile details.
@slot default - The primary profile content.
-->
<article class="card" data-bascik-attr-aria-label="role">
  <p class="role" data-bascik-text="role"></p>
  <div data-bascik-slot></div>
  <footer data-bascik-slot="actions"></footer>
</article>

<style>
  .card {
    padding: 1rem;
    border: 1px solid #ccc;
  }
</style>
`;

const userBadge = `<!-- @bascik
A small label that marks a person's status.
@prop status - The status text shown in the badge.
@prop tone - Visual emphasis: neutral, success, or warning.
-->
<span class="badge" data-bascik-attr-title="tone" data-bascik-text="status"></span>

<style>
  .badge {
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
  }
</style>
`;

const siteHeader = `<header>
  <nav>
    <a href="/">Home</a>
  </nav>
</header>

<style>
  nav {
    display: flex;
  }
</style>
`;

const press = async (page: Page, ...keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};

/** Opens the suggest widget, retrying while the extension is still indexing the project. */
const openSuggestList = async (page: Page) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    await press(page, 'Control+Space');
    await page.waitForTimeout(700);
    if ((await page.locator('.suggest-widget.visible .monaco-list-row').count()) > 0) return;
    await press(page, 'Escape');
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: '/tmp/vscode-suggest-failure.png' }).catch(() => undefined);
  throw new Error('Suggest widget never showed any rows (screenshot: /tmp/vscode-suggest-failure.png)');
};

/** A second Ctrl+Space toggles the documentation panel next to the list. VS Code remembers that state. */
const toggleSuggestDetails = async (page: Page) => {
  await press(page, 'Control+Space');
  await page.waitForTimeout(700);
};

/** Accepts the highlighted suggestion and waits for the snippet to land. */
const acceptSuggestion = async (page: Page) => {
  await press(page, 'Enter');
  await page.waitForTimeout(500);
};

/**
 * Shows the hover at the cursor and returns once it has stayed up for a couple of seconds. Cmd+K Cmd+I on
 * macOS: Ctrl+K would cut the rest of the line. VS Code sometimes drops a keyboard hover again right after
 * showing it, so a hover that vanished is shown again rather than captured as an empty frame.
 */
const hover = async (page: Page, settleMs = 3000) => {
  await page.waitForTimeout(settleMs);
  const visibleHover = page.locator('.monaco-hover:not(.hidden) .monaco-hover-content');
  for (let attempt = 0; attempt < 6; attempt++) {
    await press(page, 'Meta+k', 'Meta+i');
    await visibleHover.first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2200);
    if ((await visibleHover.count()) > 0) return;
  }
  await page.screenshot({ path: '/tmp/vscode-hover-failure.png' });
  throw new Error('The hover never stayed visible (screenshot: /tmp/vscode-hover-failure.png)');
};

/** How long the first frame stays up before anything moves, and how long the last one stays before the loop. */
const INTRO_HOLD = 1200;
const OUTRO_HOLD = 4000;

// Order matters: scenes that show the documentation side panel must come last, because VS Code keeps it open.
const scenes: Scene[] = [
  {
    name: 'complete-props',
    file: 'src/pages/props.html',
    content: `<main>
  <user-badge |></user-badge>
</main>
`,
    lines: 3,
    extraHeight: 100,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await openSuggestList(page);
      await rec.frame(1500);
      await rec.type('data-bascik-prop-st', { every: 4 });
      await rec.frame(700);
      await acceptSuggestion(page);
      await rec.frame(900);
      await rec.type('Active', { every: 2 });
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'complete-slots',
    file: 'src/pages/slots.html',
    content: `<user-card>
  <span |
</user-card>
`,
    lines: 3,
    extraHeight: 30,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await openSuggestList(page);
      await rec.frame(1500);
      await rec.type('data-bascik-slot', { every: 4 });
      await rec.frame(700);
      await acceptSuggestion(page);
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'complete-script-directives',
    file: 'src/pages/directives.html',
    content: `<main>
  <script |></script>
</main>
`,
    lines: 3,
    extraHeight: 150,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await openSuggestList(page);
      await rec.frame(1800);
      await rec.type('data-bascik-b', { every: 4 });
      await rec.frame(700);
      await acceptSuggestion(page);
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'hover-component',
    file: 'src/pages/hover.html',
    content: `<main>
  <user-ca|rd data-bascik-prop-role="Lead Engineer"></user-card>
</main>
`,
    lines: 3,
    extraHeight: 275,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await hover(page);
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'diagnostics',
    file: 'src/pages/problems.html',
    // The slot and script errors are already in the file. The animation adds the third problem by typing it.
    content: `<main>
  <h1>Our team</h1>
  <p>Meet the people behind the project.</p>
  <user-card data-bascik-prop-role="Sarah" |>
    <p data-bascik-slot="footer">Hello</p>
  </user-card>
  <script data-bascik-build data-bascik-server>
    export default async () => '';
  </script>
</main>
`,
    lines: 10,
    extraHeight: 0,
    run: async (page, rec) => {
      await page.waitForTimeout(3000);
      await rec.frame(INTRO_HOLD);
      await rec.type('data-bascik-prop-nane="x"', { every: 5 });
      await page.waitForTimeout(2000);
      await rec.frame(1200);
      // Park the cursor inside the misspelled name so the hover describes it.
      await press(page, 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft');
      await hover(page, 0);
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'scoping-warnings',
    file: 'src/css/theme.css',
    content: `.card {
  color: navy;
}

|
`,
    lines: 5,
    extraHeight: 190,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await rec.type('[data-state] { color: crimson; }', { every: 4 });
      await page.waitForTimeout(2000);
      await rec.frame(1000);
      // Cursor to the third character, inside the selector, so the hover describes it.
      await press(page, 'Home', 'ArrowRight', 'ArrowRight', 'ArrowRight');
      await hover(page, 0);
      await rec.frame(OUTRO_HOLD);
    },
  },
  {
    name: 'complete-component-tags',
    file: 'src/pages/team.html',
    content: `<main>
  <h1>Our team</h1>
  <|
  <p>Meet the people behind the project.</p>
</main>
`,
    lines: 5,
    extraHeight: 335,
    width: 940,
    run: async (page, rec) => {
      await rec.frame(INTRO_HOLD);
      await openSuggestList(page);
      await rec.frame(1500);
      await rec.type('user-ca', { every: 1, msPerChar: 200 });
      await toggleSuggestDetails(page);
      await rec.frame(2600);
      await acceptSuggestion(page);
      await rec.frame(OUTRO_HOLD);
    },
  },
];

function stripMarker(content: string): { text: string; line: number; column: number } {
  const index = content.indexOf('|');
  if (index === -1) throw new Error('Scene content needs a | cursor marker');
  const before = content.slice(0, index);
  const lines = before.split('\n');
  return {
    text: content.slice(0, index) + content.slice(index + 1),
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

async function buildProject(root: string, sceneList: Scene[]): Promise<void> {
  for (const directory of ['user-card', 'user-badge', 'site-header']) {
    await mkdir(join(root, 'src/components', directory), { recursive: true });
  }
  await writeFile(join(root, 'bascik.config.ts'), bascikConfig);
  await writeFile(join(root, 'package.json'), '{ "name": "demo", "type": "module" }\n');
  await writeFile(join(root, 'src/components/user-card/user-card.html'), userCard);
  await writeFile(join(root, 'src/components/user-badge/user-badge.html'), userBadge);
  await writeFile(join(root, 'src/components/site-header/site-header.html'), siteHeader);
  await mkdir(join(root, 'src/pages'), { recursive: true });
  await writeFile(join(root, 'src/pages/index.html'), '<site-header />\n');
  // Write every scene up front so VS Code's file index knows them before Quick Open is used.
  for (const scene of sceneList) {
    await mkdir(dirname(join(root, scene.file)), { recursive: true });
    await writeFile(join(root, scene.file), stripMarker(scene.content).text);
  }
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

async function writeSettings(userDataDir: string): Promise<void> {
  const userDir = join(userDataDir, 'User');
  await mkdir(userDir, { recursive: true });
  const settings = {
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
  };
  await writeFile(join(userDir, 'settings.json'), JSON.stringify(settings, null, 2));
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

/** Resizes the window content area while keeping 2x pixel density for crisp screenshots. */
async function resizeWindow(page: Page, width: number, height: number): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** Opens a file with Quick Open and confirms the editor tab shows it, retrying while the file index warms up. */
async function openFile(page: Page, fileName: string): Promise<void> {
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

interface Frame {
  png: Buffer;
  hold: number;
}

type Clip = { x: number; y: number; width: number; height: number };

async function createRecorder(page: Page, clip: Clip): Promise<Recorder & { frames: Frame[] }> {
  // Playwright's own screenshot call dismisses a keyboard-triggered hover once it has taken the picture, so
  // frames after the first would lose it. Asking the browser for the picture directly leaves the editor alone.
  const session = await page.context().newCDPSession(page);
  const capture = async (area: Clip): Promise<Buffer> => {
    const { data } = await session.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...area, scale: 1 },
    });
    return Buffer.from(data, 'base64');
  };
  const frames: Frame[] = [];
  const recorder = {
    frames,
    async frame(holdMs: number) {
      // Let popups and squiggles finish their own short fades before the picture is taken.
      await page.waitForTimeout(150);
      const png = await capture(clip);
      const previous = frames.at(-1);
      // Identical neighbors become one longer frame, which keeps the file small.
      if (previous?.png.equals(png)) previous.hold += holdMs;
      else frames.push({ png, hold: holdMs });
    },
    async type(text: string, { every = 1, msPerChar = 110 }: { every?: number; msPerChar?: number } = {}) {
      const characters = Array.from(text);
      for (let index = 0; index < characters.length; index += every) {
        const chunk = characters.slice(index, index + every).join('');
        await page.keyboard.type(chunk);
        await recorder.frame(chunk.length * msPerChar);
      }
    },
  };
  return recorder;
}

/** Writes a still WebP for one frame, or an animated WebP plus a still of the last frame for several. */
async function writeScene(name: string, frames: Frame[]): Promise<void> {
  const animatedFile = join(outDir, `${name}@2x.webp`);
  const stillFile = join(outDir, `${name}-still@2x.webp`);
  const lossy = { quality: 80, effort: 6 };
  if (frames.length === 1) {
    await sharp(frames[0].png).webp(lossy).toFile(animatedFile);
    // A scene that stopped moving must not leave a stale reduced-motion copy behind.
    await rm(stillFile, { force: true });
    console.log(`captured ${name}`);
    return;
  }
  const { width = 0, height = 0 } = await sharp(frames[0].png).metadata();
  const raw = await Promise.all(frames.map(({ png }) => sharp(png).ensureAlpha().raw().toBuffer()));
  await sharp(Buffer.concat(raw), { raw: { width, height: height * frames.length, channels: 4, pageHeight: height } })
    // Lossless: lossy animations only re-encode the changed rectangle, so each frame leaves a faint ghost of
    // the one before it. Flat dark UI compresses well without loss anyway.
    .webp({ lossless: true, effort: 6, loop: 0, delay: frames.map((frame) => frame.hold) })
    .toFile(animatedFile);
  await sharp(frames[frames.length - 1].png).webp(lossy).toFile(stillFile);
  const seconds = (frames.reduce((total, frame) => total + frame.hold, 0) / 1000).toFixed(1);
  console.log(`captured ${name} (${frames.length} frames, ${seconds}s loop)`);
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const selected = wanted.length ? scenes.filter((scene) => wanted.includes(scene.name)) : scenes;
  if (selected.length === 0) throw new Error(`No scenes match: ${wanted.join(', ')}`);

  const base = await mkdtemp(join(tmpdir(), 'bascik-shots-'));
  const projectDir = join(base, 'project');
  const extensionsDir = join(base, 'extensions');
  const userDataDir = join(base, 'user-data');
  await buildProject(projectDir, selected);
  await installExtension(extensionsDir);
  await writeSettings(userDataDir);
  await mkdir(outDir, { recursive: true });

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

    for (const scene of selected) {
      const { line, column } = stripMarker(scene.content);
      await resizeWindow(page, scene.width ?? WIDTH, HEIGHT);
      await openFile(page, scene.file.split('/').pop() ?? scene.file);
      await page.waitForTimeout(1500);
      await press(page, 'Control+g');
      await page.keyboard.type(`${line}:${column}`);
      await press(page, 'Enter');
      await page.waitForTimeout(500);

      const editor = await page.locator('.editor-group-container').first().boundingBox();
      if (!editor) throw new Error('Editor not found');
      const height = Math.min(
        editor.height,
        TAB_HEIGHT + TOP_PADDING + scene.lines * LINE_HEIGHT + (scene.extraHeight ?? 0),
      );
      const clip = { x: editor.x, y: editor.y, width: editor.width, height };
      const recorder = await createRecorder(page, clip);

      await scene.run(page, recorder);
      if (recorder.frames.length === 0) {
        await page.waitForTimeout(1200);
        await recorder.frame(0);
      }
      if (process.env.DEBUG_FULL) await page.screenshot({ path: `/tmp/vscode-${scene.name}.png` });
      await writeScene(scene.name, recorder.frames);
      await press(page, 'Escape');
    }
    await browser.close();
  } finally {
    code.kill();
    // Electron leaves helper processes behind; end everything started with this run's profile.
    spawnSync('pkill', ['-f', base]);
    if (process.env.KEEP_TEMP) console.log(`kept ${base}`);
    else await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
