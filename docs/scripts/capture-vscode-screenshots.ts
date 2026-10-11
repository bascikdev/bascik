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
 * The VS Code launching and frame assembly live in ./capture-kit, shared with capture-demos.ts.
 *
 * Maintainer tool only: it is not part of the docs build. Run after `yarn ext:compile` (macOS):
 *   node scripts/capture-vscode-screenshots.ts [sceneName ...]
 *
 * Set KEEP_TEMP=1 to keep the throwaway profile for inspection, DEBUG_FULL=1 to also save a full-window PNG
 * per scene to /tmp.
 *
 * Output: docs/src/pages/assets/vscode/<scene>@2x.webp, plus <scene>-still@2x.webp for animated scenes
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { INTRO_HOLD, OUTRO_HOLD, pushFrame, writeScene, type Clip, type Frame } from './capture-kit/frames.ts';
import {
  LINE_HEIGHT,
  TAB_HEIGHT,
  TOP_PADDING,
  createCapture,
  gotoLine,
  launchVsCode,
  openFile,
  press,
  resizeWindow,
} from './capture-kit/vscode.ts';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(docsDir, 'src/pages/assets/vscode');

/** Default window content size in CSS pixels. Screenshots are taken at 2x pixel density. */
const WIDTH = 780;
const HEIGHT = 720;
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

async function createRecorder(page: Page, clip: Clip): Promise<Recorder & { frames: Frame[] }> {
  const capture = await createCapture(page);
  const frames: Frame[] = [];
  const recorder = {
    frames,
    async frame(holdMs: number) {
      // Let popups and squiggles finish their own short fades before the picture is taken.
      await page.waitForTimeout(150);
      pushFrame(frames, await capture(clip), holdMs);
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

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const selected = wanted.length ? scenes.filter((scene) => wanted.includes(scene.name)) : scenes;
  if (selected.length === 0) throw new Error(`No scenes match: ${wanted.join(', ')}`);

  const vscode = await launchVsCode({ prepare: (projectDir) => buildProject(projectDir, selected) });
  const { page } = vscode;
  try {
    for (const scene of selected) {
      const { line, column } = stripMarker(scene.content);
      await resizeWindow(page, scene.width ?? WIDTH, HEIGHT);
      await openFile(page, scene.file.split('/').pop() ?? scene.file);
      await page.waitForTimeout(1500);
      await gotoLine(page, line, column);

      const editor = await page.locator('.editor-group-container').first().boundingBox();
      if (!editor) throw new Error('Editor not found');
      const height = Math.min(
        editor.height,
        TAB_HEIGHT + TOP_PADDING + scene.lines * LINE_HEIGHT + (scene.extraHeight ?? 0),
      );
      const recorder = await createRecorder(page, { x: editor.x, y: editor.y, width: editor.width, height });

      await scene.run(page, recorder);
      if (recorder.frames.length === 0) {
        await page.waitForTimeout(1200);
        await recorder.frame(0);
      }
      if (process.env.DEBUG_FULL) await page.screenshot({ path: `/tmp/vscode-${scene.name}.png` });
      await writeScene(outDir, scene.name, recorder.frames);
      await press(page, 'Escape');
    }
  } finally {
    await vscode.close();
  }
}

await main();
