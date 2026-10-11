/**
 * Captures the animated WebP demos used on the home page and the tooling docs. Everything shown is real:
 * a project scaffolded by this repo's own `create-bascik`, served by the real dev server, edited in a real VS
 * Code window, and linted by the real language server. Nothing is mocked up.
 *
 * Scenes:
 *   live-reload       editor beside a browser: edit a page, then a component, and the browser updates on save
 *   live-reload-stacked  the same, with the editor above the browser, for narrow docs columns
 *   error-overlay     editor beside a browser: a typo raises the overlay, fixing it dismisses it
 *   stream            a browser loading a page whose slow part streams in
 *   dev-terminal      the terminal: `bascik` starts in milliseconds, then an edit rebuilds only one page
 *   lint              the terminal: `npm run lint` finding real problems
 *
 * Maintainer tool only: it is not part of the docs build. macOS only (it drives the VS Code app bundle).
 *   yarn workspace create-bascik build      # when the scaffolder changed: scenes use create/dist
 *   yarn workspace bascik-vscode compile    # when the extension changed
 *   node scripts/capture-demos.ts [scene ...]
 *
 * It never touches `docs/`, so a running `yarn docs:dev` is left alone. Servers use port 8123 and the address
 * bar shows localhost:8080, the port a reader's own project uses by default.
 *
 * Output: docs/src/pages/assets/demos/<scene>@2x.webp, plus <scene>-still@2x.webp for animated scenes.
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { browserWindow, roundCorners, sideBySide, stacked } from './capture-kit/compose.ts';
import { INTRO_HOLD, OUTRO_HOLD, pushFrame, sleep, writeScene, type Frame } from './capture-kit/frames.ts';
import {
  bascikBin,
  createStarterProject,
  languageServerBin,
  startDevServer,
  type StarterProject,
} from './capture-kit/project.ts';
import { recordCommand, renderTerminal } from './capture-kit/terminal.ts';
import { createCapture, gotoLine, launchVsCode, openFile, press, resizeWindow } from './capture-kit/vscode.ts';

const docsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(docsDir, 'src/pages/assets/demos');
const PORT = 8123;
const SHOWN_URL = 'localhost:8080';

const BROWSER_BAR = 36;

/**
 * Pane sizes in CSS pixels. Side by side suits the wide home page. Stacked suits a docs column, which is about
 * 680px wide, so code stays readable instead of being shrunk to fit.
 */
const LAYOUTS = {
  side: { editorWidth: 560, editorHeight: 400, browserWidth: 540 },
  stacked: { editorWidth: 664, editorHeight: 196, browserWidth: 664 },
} as const;
/**
 * VS Code places its editor inside the window, below a title bar and inside a thin frame, so the editor is
 * smaller than the window. These are measured, not guessed. The browser pane is sized to match whatever the
 * editor really measures, so the two panes line up.
 */
const STACKED_BROWSER_HEIGHT = 300;
type Layout = keyof typeof LAYOUTS;

interface RigOptions {
  layout?: Layout;
  editorSettings?: Record<string, unknown>;
  /** Changes the starter before the dev server and editor open it. */
  prepare?: (projectDir: string) => Promise<void>;
}

async function readLine(file: string, needle: string): Promise<{ line: number; column: number; text: string }> {
  const lines = (await readFile(file, 'utf8')).split('\n');
  const index = lines.findIndex((candidate) => candidate.includes(needle));
  if (index === -1) throw new Error(`"${needle}" not found in ${file}`);
  return { line: index + 1, column: lines[index].indexOf(needle) + 1, text: lines[index] };
}

interface EditorBrowserRig {
  project: StarterProject;
  browser: Browser;
  page: Page;
  vscode: Awaited<ReturnType<typeof launchVsCode>>;
  /** Takes one picture of both panes and adds it as a frame. */
  snap(frames: Frame[], holdMs: number): Promise<void>;
  close(): Promise<void>;
}

/** An editor and a browser looking at the same real dev server, composed into one picture per frame. */
async function openEditorAndBrowser({ layout = 'side', editorSettings = {}, prepare }: RigOptions = {}): Promise<EditorBrowserRig> {
  const size = LAYOUTS[layout];
  const project = await createStarterProject();
  await prepare?.(project.dir);
  const server = await startDevServer(project.dir, PORT);
  const vscode = await launchVsCode({
    projectDir: project.dir,
    settings: {
      'files.autoSave': 'off',
      'files.watcherExclude': { '**/node_modules/**': true },
      // The scrollbars would leave empty bands inside the cropped editor.
      'editor.scrollbar.horizontal': 'hidden',
      'editor.scrollbar.vertical': 'hidden',
      ...editorSettings,
    },
  });
  await resizeWindow(vscode.page, size.editorWidth, size.editorHeight);
  const measured = await vscode.page.locator('.editor-group-container').first().boundingBox();
  if (!measured) throw new Error('Editor not found');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: {
      width: size.browserWidth,
      // Side by side, the browser (title bar included) is exactly as tall as the editor. Stacked, it has its own height.
      height: layout === 'side' ? Math.round(measured.height) - BROWSER_BAR : STACKED_BROWSER_HEIGHT,
    },
    deviceScaleFactor: 2,
  });
  await page.goto(server.url);
  const capture = await createCapture(vscode.page);

  const rig: EditorBrowserRig = {
    project,
    browser,
    page,
    vscode,
    async snap(frames, holdMs) {
      await sleep(150);
      const [editorPng, pagePng] = await Promise.all([
        capture({ x: measured.x, y: measured.y, width: measured.width, height: measured.height }),
        page.screenshot(),
      ]);
      const [editorWindow, browserPane] = await Promise.all([
        roundCorners(editorPng),
        browserWindow(pagePng, SHOWN_URL).then((window) => roundCorners(window)),
      ]);
      const compose = layout === 'side' ? sideBySide : stacked;
      pushFrame(frames, await compose(editorWindow, browserPane), holdMs);
    },
    async close() {
      await browser.close().catch(() => undefined);
      await vscode.close();
      await server.stop();
      await project.cleanup();
    },
  };
  return rig;
}

/** Selects the `length` characters that end at `column` on `line`, ready to be typed over. */
async function selectBackwards(page: Page, line: number, column: number, length: number): Promise<void> {
  await gotoLine(page, line, column);
  for (let index = 0; index < length; index++) await press(page, 'Shift+ArrowLeft');
}

/** Scrolls so the first feature card sits near the top of the pane, where its border is easy to see. */
async function scrollToCards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.querySelector('article');
    if (card) window.scrollTo(0, card.getBoundingClientRect().top + window.scrollY - 70);
  });
}

async function liveReload(layout: Layout): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({ layout });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  try {
    const pageFile = join(rig.project.dir, 'src/pages/index.html');
    const cardFile = join(rig.project.dir, 'src/components/feat-card/feat-card.html');

    // Beat 1: edit a page. The brand name in the heading is the lime green word.
    await openFile(editor, 'index.html');
    const heading = await readLine(pageFile, '<span>my-site</span>');
    const endOfName = heading.column + '<span>my-site'.length;
    await selectBackwards(editor, heading.line, endOfName, 'my-site'.length);
    await rig.snap(frames, INTRO_HOLD + 400);
    for (const chunk of ['A', 'c', 'm', 'e']) {
      await editor.keyboard.type(chunk);
      await rig.snap(frames, 220);
    }
    await rig.snap(frames, 700);
    await press(editor, 'Meta+s');
    await rig.page.waitForFunction(() => document.querySelector('h1 span')?.textContent === 'Acme', null, { timeout: 15_000 });
    if (!(await readFile(pageFile, 'utf8')).includes('<span>Acme</span>')) throw new Error('The heading edit did not save as expected');
    await rig.snap(frames, 2600);

    // Beat 2: edit a component. Every card on the page uses it, so every card changes.
    await openFile(editor, 'feat-card.html');
    await scrollToCards(rig.page);
    const declaration = 'border: 1px solid var(--border);';
    const border = await readLine(cardFile, declaration);
    const original = await rig.page.evaluate(() => getComputedStyle(document.querySelector('article')!).borderTopColor);
    // The cursor goes just before the ";", then the value `var(--border)` is selected backwards from there.
    await selectBackwards(editor, border.line, border.column + declaration.length - 1, 'var(--border)'.length);
    await rig.snap(frames, 1400);
    for (const chunk of ['var(', '--acc', 'ent)']) {
      await editor.keyboard.type(chunk);
      await rig.snap(frames, 260);
    }
    await rig.snap(frames, 600);
    await press(editor, 'Meta+s');
    await rig.page.waitForFunction(
      (before) => getComputedStyle(document.querySelector('article')!).borderTopColor !== before,
      original,
      { timeout: 15_000 },
    );
    // Fail loudly rather than publish an animation of broken code.
    const saved = await readFile(cardFile, 'utf8');
    if (!saved.includes('border: 1px solid var(--accent);')) {
      throw new Error(`The edit did not produce the expected CSS:\n${saved.split('\n').slice(0, 6).join('\n')}`);
    }
    // A reload keeps the scroll position, but make sure the cards are what the last frame shows.
    await scrollToCards(rig.page);
    await rig.snap(frames, OUTRO_HOLD);
    return frames;
  } finally {
    await rig.close();
  }
}

/** The starter's welcome label, with the year filled in by a build script. A page-level script, like a real site's. */
const YEAR_LABEL = `<p class="section-label">Welcome
          <script data-bascik-build>
            export default () => String(new Date().getFullYear());
          </script>
        </p>`;

async function errorOverlay(): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({
    layout: 'stacked',
    prepare: async (dir) => {
      const file = join(dir, 'src/pages/index.html');
      await writeFile(file, (await readFile(file, 'utf8')).replace('<p class="section-label">Welcome</p>', YEAR_LABEL));
    },
  });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  const overlay = rig.page.getByTestId('bascik-build-error-overlay');
  try {
    const pageFile = join(rig.project.dir, 'src/pages/index.html');
    await openFile(editor, 'index.html');
    const call = await readLine(pageFile, 'String(new Date()');
    // Put the cursor right after "String" so one Backspace turns it into the typo "Strin".
    await gotoLine(editor, call.line, call.column + 'String'.length);
    await rig.snap(frames, INTRO_HOLD + 600);

    await press(editor, 'Backspace');
    await rig.snap(frames, 800);
    await press(editor, 'Meta+s');
    await overlay.waitFor({ state: 'visible', timeout: 15_000 });
    // The stack frame inside the overlay names a temp directory on this machine. Show it the way a reader's own
    // project would, not as a path nobody can use.
    await rig.page.evaluate(() => {
      for (const pre of document.querySelectorAll('#bascik-build-error-overlay pre')) {
        pre.textContent = (pre.textContent ?? '').replace(/file:\/\/\/\S*?\/(runner\.mjs)/g, 'file:///…/$1');
      }
    });
    await sleep(400);
    await rig.snap(frames, 3800);

    await editor.keyboard.type('g');
    await rig.snap(frames, 800);
    await press(editor, 'Meta+s');
    await overlay.waitFor({ state: 'detached', timeout: 15_000 });
    await rig.page.waitForFunction(() => document.querySelector('h1') !== null, null, { timeout: 15_000 });
    if (!(await readFile(pageFile, 'utf8')).includes('String(new Date()')) throw new Error('The fix did not save as expected');
    await sleep(400);
    await rig.snap(frames, OUTRO_HOLD);
    return frames;
  } finally {
    await rig.close();
  }
}

const STREAM_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Dashboard - my-site</title>
  <site-meta />
  <style>
    .stream-layout { display: grid; gap: 14px; margin-top: 24px; }
    .skeleton { padding: 24px; border: 1px dashed var(--border); border-radius: var(--r); color: var(--text-muted); }
    .metric { padding: 24px; background: var(--elevated); border: 1px solid var(--border); border-radius: var(--r); }
    .metric strong { display: block; font-size: 2rem; color: var(--accent); }
    .stream-layout:has(.metric) .skeleton { display: none; }
  </style>
</head>
<body>
  <site-header data-bascik-prop-brand="my-site" />
  <main>
    <section class="section">
      <div class="container">
        <p class="section-label">Dashboard</p>
        <h1>Live metrics</h1>
        <div class="stream-layout">
          <div class="skeleton" role="status">Loading live metrics…</div>
          <div>
            <script data-bascik-stream>
              export default async function () {
                await new Promise((done) => setTimeout(done, 2200));
                return '<article class="metric"><strong>99.99%</strong>Uptime across 3 regions</article>';
              }
            </script>
          </div>
        </div>
      </div>
    </section>
  </main>
  <site-footer data-bascik-prop-brand="my-site" />
</body>
</html>
`;

async function stream(): Promise<Frame[]> {
  const project = await createStarterProject();
  await writeFile(join(project.dir, 'src/pages/dashboard.html'), STREAM_PAGE);
  const server = await startDevServer(project.dir, PORT);
  const browser = await chromium.launch();
  const frames: Frame[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 330 }, deviceScaleFactor: 2 });
    const snap = async (hold: number) => pushFrame(frames, await browserWindow(await page.screenshot(), SHOWN_URL + '/dashboard'), hold);

    // Warm the route so the recording shows streaming, not first-request compilation.
    await page.goto(`${server.url}/dashboard`);
    await page.waitForSelector('.metric', { timeout: 15_000 });

    // Load it again and photograph the page while the stream is still open. The server holds the metric back
    // for about two seconds, so the skeleton is on screen first and the card replaces it in place.
    const started = Date.now();
    await page.goto(`${server.url}/dashboard`, { waitUntil: 'commit' });
    await page.waitForSelector('.skeleton', { state: 'visible', timeout: 10_000 });
    let last = Date.now();
    while (!(await page.locator('.metric').count())) {
      await snap(Date.now() - last + 60);
      last = Date.now();
      if (Date.now() - started > 15_000) throw new Error('The streamed metric never arrived');
    }
    await sleep(200);
    await snap(OUTRO_HOLD);
    return frames;
  } finally {
    await browser.close();
    await server.stop();
    await project.cleanup();
  }
}

/** Replaces the throwaway project's location with a plain one, and the capture port with the default. */
async function redactions(project: StarterProject): Promise<Array<[string, string]>> {
  const real = await realpath(project.dir);
  return [
    [`${real}/`, '~/my-site/'],
    [`${project.dir}/`, '~/my-site/'],
    [`:${PORT}`, ':8080'],
  ];
}

function redact(text: string, pairs: Array<[string, string]>): string {
  return pairs.reduce((value, [from, to]) => value.split(from).join(to), text);
}

async function devTerminal(): Promise<Frame[]> {
  const project = await createStarterProject();
  const browser = await chromium.launch();
  try {
    const pairs = await redactions(project);
    const pageFile = join(project.dir, 'src/pages/index.html');
    const before = await readFile(pageFile, 'utf8');
    let edited = false;
    // The real dev server runs. Once it is up, a real file is saved, and the server reports what it rebuilt.
    const recording = await recordCommand({
      command: process.execPath,
      args: [bascikBin, '--port', String(PORT)],
      cwd: project.dir,
      stopAfterMs: 20_000,
      stopWhen: /transpiled: pages\/index\.html[^\n]*\n(?:[^\n]*\n)*?[^\n]*transpiled: pages\/index\.html/,
      triggers: [
        {
          when: /Server running at/,
          run: async () => {
            await sleep(900);
            await writeFile(pageFile, before.replace('Build fast with', 'Ship fast with'));
            edited = true;
          },
        },
      ],
    });
    if (!edited) throw new Error('The dev server never reported that it was running');
    for (const chunk of recording.chunks) chunk.text = redact(chunk.text, pairs);
    return await renderTerminal(browser, { title: 'bascik', rows: 17, width: 780 }, {
      typed: 'bascik',
      recording,
      maxGapMs: 900,
      finalHoldMs: OUTRO_HOLD,
      endsAtPrompt: false,
    });
  } finally {
    await browser.close();
    await project.cleanup();
  }
}

/** Real problems, each of a kind the language server reports. */
const LINT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Team</title></head>
<body>
  <site-header data-bascik-prop-brnad="my-site" />
  <feat-card>
    <h3>Unclosed card</h3>
  <site-footer data-bascik-prop-brand="my-site" />
</body>
</html>
`;

const LINT_COMPONENT = `<button class="toggle" id="toggle">Toggle</button>

<script>
  const toggle = document.getElementById('toggle');
  toggle.id = 'toggle-active';
  document.querySelector('[data-state="open"]');
</script>
`;

async function lint(): Promise<Frame[]> {
  const project = await createStarterProject();
  await writeFile(join(project.dir, 'src/pages/team.html'), LINT_PAGE);
  await mkdir(join(project.dir, 'src/components/toggle-box'), { recursive: true });
  await writeFile(join(project.dir, 'src/components/toggle-box/toggle-box.html'), LINT_COMPONENT);
  const browser = await chromium.launch();
  try {
    const pairs = await redactions(project);
    const recording = await recordCommand({
      command: process.execPath,
      args: [languageServerBin, '--check'],
      cwd: project.dir,
    });
    for (const chunk of recording.chunks) chunk.text = redact(chunk.text, pairs);
    return await renderTerminal(browser, { title: 'npm run lint', rows: 15, width: 780 }, {
      typed: 'npm run lint',
      recording,
      maxGapMs: 500,
      finalHoldMs: OUTRO_HOLD,
    });
  } finally {
    await browser.close();
    await project.cleanup();
  }
}

const scenes: Record<string, () => Promise<Frame[]>> = {
  'live-reload': () => liveReload('side'),
  'live-reload-stacked': () => liveReload('stacked'),
  'error-overlay': errorOverlay,
  stream,
  'dev-terminal': devTerminal,
  lint,
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !(name in scenes));
if (unknown.length) throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Scenes: ${Object.keys(scenes).join(', ')}`);

for (const name of wanted.length ? wanted : Object.keys(scenes)) {
  await writeScene(outDir, name, await scenes[name]());
}
