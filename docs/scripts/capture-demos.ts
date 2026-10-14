/**
 * Captures the animated WebP demos used on the home page and the tooling docs. Everything shown is real:
 * a project scaffolded by this repo's own `create-bascik`, served by the real dev server, edited in a real VS
 * Code window, and linted by the real language server. Nothing is mocked up.
 *
 * Scenes:
 *   live-reload       editor beside a browser: edit a page, then a component, and the browser updates on save
 *   live-reload-stacked  the same, with the editor above the browser, for narrow docs columns
 *   error-overlay     editor beside a browser: a typo raises the overlay, fixing it dismisses it
 *   component-tag     editor above a browser: a component file exists, its tag is typed into a page, and it renders
 *   stream            a browser loading a page whose slow part streams in
 *   markdown-watch    editor above a browser: a watched Markdown file is edited, and the page that reads it updates
 *   server-request    editor above a browser: a server script renders a different page for each request
 *   exec-watch        the terminal: editing a watched file reruns an exec script and rebuilds only its page
 *   dynamic-routes    editor above a browser: a URL is a 404 until a route is added to the template's routes script
 *   sitemap           the terminal: `bascik --build` with a site URL, then the generated sitemap.xml
 *   api-routes        the terminal: curl against a real dev server answering an API route, then a 405 with its Allow header
 *   devtools-breakpoint  the browser above real Chrome DevTools: a breakpoint in a component script, on its file's line
 *   dev-terminal      the terminal: `bascik` starts in milliseconds, then an edit rebuilds only one page
 *   lint              the terminal: `npm run lint` finding real problems
 *
 * Terminal scenes record the real program. The dev server runs in a pseudo-terminal (node-pty) and
 * its output is replayed through a terminal emulator, so the color and the address pinned to the top row are
 * exactly what a reader's terminal shows. Re-record the terminal scenes (dev-terminal, exec-watch, sitemap, lint)
 * whenever the CLI's output changes. `api-routes` only shows curl, so it does not depend on the CLI's output.
 *
 * Maintainer tool only: it is not part of the docs build. macOS only (it drives the VS Code app bundle).
 *   yarn pkg:build                          # scenes run pkg/dist
 *   yarn workspace @bascik/language-server build   # the lint scene runs lsp/dist
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
import { stripVTControlCharacters } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { browserWindow, roundCorners, sideBySide, stacked } from './capture-kit/compose.ts';
import { INTRO_HOLD, OUTRO_HOLD, pushFrame, sleep, writeScene, type Frame } from './capture-kit/frames.ts';
import {
  bascikBin,
  createStarterProject,
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
  /** The page the browser opens, such as `/hello`. Defaults to the home page. */
  path?: string;
  /** Overrides the layout's editor height, for scenes whose code needs more lines. */
  editorHeight?: number;
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
async function openEditorAndBrowser({
  layout = 'side',
  editorSettings = {},
  prepare,
  path = '',
  editorHeight,
}: RigOptions = {}): Promise<EditorBrowserRig> {
  const size = { ...LAYOUTS[layout], ...(editorHeight ? { editorHeight } : {}) };
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
  await page.goto(server.url + path);
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
      // The address bar follows the page, so a scene that navigates shows where it went.
      const current = new URL(page.url());
      const shownPath = current.pathname === '/' && !current.search ? '' : current.pathname + decodeURIComponent(current.search);
      const [editorWindow, browserPane] = await Promise.all([
        roundCorners(editorPng),
        browserWindow(pagePng, SHOWN_URL + shownPath).then((window) => roundCorners(window)),
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

/** A component the starter does not have. Its file name is its tag name: nothing registers or imports it. */
const HELLO_CARD = `<article class="hello-card">
  <p class="kicker">One file. One tag.</p>
  <h2 class="title">Vanilla HTML, ready to reuse.</h2>
</article>

<style>
  .hello-card {
    margin-top: 18px;
    padding: 16px 20px;
    background: var(--elevated);
    border: 1px solid var(--border);
    border-top: 3px solid var(--accent);
    border-radius: var(--r);
  }
  .kicker { margin: 0 0 6px; color: var(--accent); font-size: 0.85rem; }
  .title { margin: 0; font-size: 1.2rem; }
</style>
`;

/** A page that does not use the component yet. The blank line in `<main>` is where its tag gets typed. */
const HELLO_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Hello - my-site</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="my-site" />
  <main class="container">

  </main>
</body>
</html>
`;

/** Opens the suggest widget, retrying while the extension is still indexing the project. */
async function openSuggestions(editor: Page): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await press(editor, 'Control+Space');
    await sleep(700);
    if ((await editor.locator('.suggest-widget.visible .monaco-list-row').count()) > 0) return;
    await press(editor, 'Escape');
    await sleep(500);
  }
  throw new Error('The suggest widget never listed the component');
}

async function componentTag(): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({
    layout: 'stacked',
    path: '/hello',
    prepare: async (dir) => {
      await mkdir(join(dir, 'src/components/hello-card'), { recursive: true });
      await writeFile(join(dir, 'src/components/hello-card/hello-card.html'), HELLO_CARD);
      await writeFile(join(dir, 'src/pages/hello.html'), HELLO_PAGE);
    },
  });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  const waitForCards = (count: number) =>
    rig.page.waitForFunction((expected) => document.querySelectorAll('main article').length === expected, count, {
      timeout: 15_000,
    });
  try {
    const pageFile = join(rig.project.dir, 'src/pages/hello.html');

    // Beat 1: the component is one file. The tab shows its name and folder.
    await openFile(editor, 'hello-card.html');
    await gotoLine(editor, 1, 1);
    await rig.snap(frames, INTRO_HOLD + 1600);

    // Beat 2: use the file name as a tag. The editor suggests it, with no import anywhere.
    await openFile(editor, 'hello.html');
    const slot = await readLine(pageFile, '<main class="container">');
    await gotoLine(editor, slot.line + 1, 1);
    await editor.keyboard.type('    ');
    await rig.snap(frames, 1000);
    for (const chunk of ['<', 'h', 'e', 'l']) {
      await editor.keyboard.type(chunk);
      await rig.snap(frames, 200);
    }
    await openSuggestions(editor);
    await rig.snap(frames, 1500);
    await press(editor, 'Enter');
    await rig.snap(frames, 900);
    await press(editor, 'Meta+s');
    await waitForCards(1);
    if (!(await readFile(pageFile, 'utf8')).includes('<hello-card')) throw new Error('The tag did not save as expected');
    await rig.snap(frames, 2200);

    // Beat 3: use it again. Each tag is another copy, built from the same file.
    await press(editor, 'Shift+Alt+ArrowDown');
    await rig.snap(frames, 800);
    await press(editor, 'Meta+s');
    await waitForCards(2);
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
      // A terminal, not a pipe: the dev server colors its output and pins its address to the top row there.
      pty: { rows: 17, cols: 92 },
      stopAfterMs: 20_000,
      stopWhen: /transpiled: pages\/index\.html[^\n]*\n(?:[^\n]*\n)*?[^\n]*transpiled: pages\/index\.html/,
      triggers: [
        {
          // The address is pinned as soon as the port is bound. The edit waits for the first compile to finish.
          when: /All tasks completed/,
          run: async () => {
            await sleep(900);
            await writeFile(pageFile, before.replace('Build fast with', 'Ship fast with'));
            edited = true;
          },
        },
      ],
    });
    if (!edited) throw new Error('The dev server never finished its first compile');
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

/**
 * Real problems, each of a kind the language server reports. They are all in a page on purpose: a scoping
 * problem in a component is also printed by the compiler while `bascik --check` loads components, which would
 * put the same finding in this recording twice.
 */
const LINT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Team</title></head>
<body>
  <site-header data-bascik-prop-brnad="my-site" />
  <div data-bascik-build></div>
  <script data-bascik-build data-bascik-server>
    export default () => '<p>Hi</p>';
  </script>
  <feat-card>
    <h3>Unclosed card</h3>
  <site-footer data-bascik-prop-brand="my-site" />
</body>
</html>
`;

async function lint(): Promise<Frame[]> {
  const project = await createStarterProject();
  await writeFile(join(project.dir, 'src/pages/team.html'), LINT_PAGE);
  const browser = await chromium.launch();
  try {
    const pairs = await redactions(project);
    const recording = await recordCommand({
      command: process.execPath,
      // The scaffolded `lint` script is `bascik --check`.
      args: [bascikBin, '--check'],
      cwd: project.dir,
    });
    for (const chunk of recording.chunks) chunk.text = redact(chunk.text, pairs);
    return await renderTerminal(browser, { title: 'npm run lint', rows: 23, width: 780 }, {
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

/** Markdown outside `src/`, read by a page's build script. */
const NOTES_MD = `# Release notes

Version 1.0 ships today.
`;

/** A page whose build script turns `content/notes.md` into a heading and paragraphs. */
const NOTES_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Notes - my-site</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="my-site" />
  <main>
    <section class="section">
      <div class="container">
        <script data-bascik-build>
          import { readFile } from 'node:fs/promises';

          export default async () => {
            const [title, ...body] = (await readFile('content/notes.md', 'utf8')).trim().split('\\n\\n');
            return \`<h1>\${title.slice(2)}</h1>\` + body.map((text) => \`<p>\${text}</p>\`).join('');
          };
        </script>
      </div>
    </section>
  </main>
</body>
</html>
`;

/** A post-phase exec script that indexes the Markdown and writes its output to `dist/`, never to a source. */
const SEARCH_INDEX_SCRIPT = `import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

const files = (await readdir('content')).filter((file) => file.endsWith('.md'));
const entries = await Promise.all(
  files.map(async (file) => ({ file, title: (await readFile(\`content/\${file}\`, 'utf8')).split('\\n')[0].slice(2) })),
);
await mkdir('dist', { recursive: true });
await writeFile('dist/search-index.json', JSON.stringify(entries));
console.log(\`indexed: \${entries.map((entry) => entry.title).join(', ')}\`);
`;

/** Adds the notes page and its Markdown. With `exec`, also the search index script that watches the Markdown. */
async function addNotes(dir: string, { exec = false } = {}): Promise<void> {
  await mkdir(join(dir, 'content'), { recursive: true });
  await writeFile(join(dir, 'content/notes.md'), NOTES_MD);
  await writeFile(join(dir, 'src/pages/notes.html'), NOTES_PAGE);
  const pipeline = exec
    ? `exec: [{ script: 'scripts/search-index.ts', phase: 'post', watch: ['content/'] }],`
    : `watchPaths: ['content/'],`;
  if (exec) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, 'scripts/search-index.ts'), SEARCH_INDEX_SCRIPT);
  }
  await writeFile(
    join(dir, 'bascik.config.ts'),
    `import { defineConfig } from '@bascik/bascik/config';\n\nexport default defineConfig({\n  pipeline: {\n    ${pipeline}\n  },\n});\n`,
  );
}

async function markdownWatch(): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({
    layout: 'stacked',
    path: '/notes',
    editorHeight: 236,
    // Markdown offers code actions on empty lines; the bulb would flicker in and out of frames.
    editorSettings: { 'editor.lightbulb.enabled': 'off' },
    prepare: (dir) => addNotes(dir),
  });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  const markdownFile = join(rig.project.dir, 'content/notes.md');
  try {
    // Beat 1: change a sentence in the Markdown. The page that reads it rebuilds.
    await openFile(editor, 'notes.md');
    const sentence = await readLine(markdownFile, 'ships today');
    const endOfToday = sentence.column + 'ships today'.length;
    await selectBackwards(editor, sentence.line, endOfToday, 'today'.length);
    await rig.snap(frames, INTRO_HOLD + 400);
    for (const chunk of ['on ', 'Fri', 'day']) {
      await editor.keyboard.type(chunk);
      await rig.snap(frames, 220);
    }
    await rig.snap(frames, 600);
    await press(editor, 'Meta+s');
    await rig.page.waitForFunction(() => document.querySelector('main p')?.textContent?.includes('Friday'), null, {
      timeout: 15_000,
    });
    await rig.snap(frames, 2200);

    // Beat 2: add a paragraph. It appears on the page as a new <p>.
    await press(editor, 'End', 'Enter', 'Enter');
    await rig.snap(frames, 500);
    for (const chunk of ['Scoped ', 'CSS is ', 'on by ', 'default.']) {
      await editor.keyboard.type(chunk);
      await rig.snap(frames, 220);
    }
    await rig.snap(frames, 600);
    await press(editor, 'Meta+s');
    await rig.page.waitForFunction(() => document.querySelectorAll('main p').length === 2, null, { timeout: 15_000 });
    const saved = await readFile(markdownFile, 'utf8');
    if (!saved.includes('ships on Friday.\n\nScoped CSS is on by default.')) {
      throw new Error(`The Markdown edit did not save as expected:\n${saved}`);
    }
    await rig.snap(frames, OUTRO_HOLD);
    return frames;
  } finally {
    await rig.close();
  }
}

/** The five-line escaper the server scripts docs recommend writing once per project. */
const ESCAPE_HELPER = `export const escape = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
`;

/** A component that is only a server script: it renders on every request, from that request. */
const HELLO_USER = `<script data-bascik-server>
  import { escape } from '@/lib/server.ts';

  export default (request) => {
    const params = new URL(request.url).searchParams;
    const name = escape(params.get('name') ?? 'Guest');
    const time = new Date().toLocaleTimeString('en-US');
    return \`<h1>Hello, \${name}!</h1>
      <p>Rendered at \${time}</p>\`;
  };
</script>
`;

const GREET_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Greet - my-site</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="my-site" />
  <main>
    <section class="section">
      <div class="container">
        <hello-user />
      </div>
    </section>
  </main>
</body>
</html>
`;

async function serverRequest(): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({
    layout: 'stacked',
    path: '/greet?name=Ada',
    editorHeight: 354,
    editorSettings: { 'editor.lightbulb.enabled': 'off' },
    prepare: async (dir) => {
      await mkdir(join(dir, 'src/lib'), { recursive: true });
      await writeFile(join(dir, 'src/lib/server.ts'), ESCAPE_HELPER);
      await mkdir(join(dir, 'src/components/hello-user'), { recursive: true });
      await writeFile(join(dir, 'src/components/hello-user/hello-user.html'), HELLO_USER);
      await writeFile(join(dir, 'src/pages/greet.html'), GREET_PAGE);
    },
  });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  const heading = () => rig.page.locator('main h1').textContent();
  const renderedAt = () => rig.page.locator('main p').textContent();
  try {
    await openFile(editor, 'hello-user.html');
    await gotoLine(editor, 1, 1);
    if ((await heading()) !== 'Hello, Ada!') throw new Error(`Unexpected first render: ${await heading()}`);
    await rig.snap(frames, INTRO_HOLD + 1800);

    // Beat 1: another request, another query string, another page. Nothing was rebuilt.
    await rig.page.goto(rig.page.url().replace('name=Ada', 'name=Grace'));
    if ((await heading()) !== 'Hello, Grace!') throw new Error(`Unexpected second render: ${await heading()}`);
    await rig.snap(frames, 2600);

    // Beat 2: the same URL again. The script runs again, so the time moves on.
    const before = await renderedAt();
    await sleep(1100);
    await rig.page.reload();
    if ((await renderedAt()) === before) throw new Error('The reload did not render a new time');
    await rig.snap(frames, OUTRO_HOLD);
    return frames;
  } finally {
    await rig.close();
  }
}

async function execWatch(): Promise<Frame[]> {
  const project = await createStarterProject();
  await addNotes(project.dir, { exec: true });
  const browser = await chromium.launch();
  try {
    const pairs = await redactions(project);
    const markdownFile = join(project.dir, 'content/notes.md');
    let edited = false;
    // The real dev server runs the exec script once at startup. Then the Markdown is edited, and the server
    // reruns the script and rebuilds the one page that reads that file.
    const recording = await recordCommand({
      command: process.execPath,
      args: [bascikBin, '--port', String(PORT)],
      cwd: project.dir,
      pty: { rows: 18, cols: 92 },
      stopAfterMs: 20_000,
      stopWhen: /\(completed\) exec[^\n]*\n(?:[^\n]*\n)*?[^\n]*\(completed\) exec/,
      triggers: [
        {
          when: /All tasks completed/,
          run: async () => {
            await sleep(900);
            await writeFile(markdownFile, NOTES_MD.replace('# Release notes', '# Release notes for 1.0'));
            edited = true;
          },
        },
      ],
    });
    if (!edited) throw new Error('The dev server never finished its first compile');
    const text = stripVTControlCharacters(recording.chunks.map((chunk) => chunk.text).join(''));
    if (!/transpiled: pages\/notes\.html[\s\S]*indexed: Release notes for 1\.0/.test(text)) {
      throw new Error(`The edit did not rebuild the page and rerun the script:\n${text}`);
    }
    for (const chunk of recording.chunks) chunk.text = redact(chunk.text, pairs);
    return await renderTerminal(browser, { title: 'bascik', rows: 18, width: 780 }, {
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

/** One template, one page per route. Lines stay short so they fit the stacked editor without clipping. */
const BLOG_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Blog - my-site</title>
  <site-meta />
</head>
<body>
  <site-header data-bascik-prop-brand="my-site" />
  <main class="section container">
    <script data-bascik-routes>
      export default () => [
        { slug: 'hello-world', title: 'Hello, world' },
        { slug: 'second-post', title: 'Second post' },
      ].map((post) => ({
        params: { slug: post.slug },
        data: post,
      }));
    </script>
    <script data-bascik-build>
      export default () => {
        const route = JSON.parse(process.env.BASCIK_ROUTE);
        return \`<h1>\${route.data.title}</h1>\`;
      };
    </script>
  </main>
</body>
</html>
`;

const addBlog = async (dir: string) => {
  await mkdir(join(dir, 'src/pages/blog'), { recursive: true });
  await writeFile(join(dir, 'src/pages/blog/[slug].html'), BLOG_TEMPLATE);
};

async function dynamicRoutes(): Promise<Frame[]> {
  const rig = await openEditorAndBrowser({
    layout: 'stacked',
    path: '/blog/third-post',
    editorHeight: 300,
    editorSettings: {
      'editor.lightbulb.enabled': 'off',
      'editor.autoClosingQuotes': 'never',
      // VS Code's built-in HTML validator treats every <script> as a classic script, so after an edit it
      // underlines the `export default` of Bascik's directive scripts. That is unrelated to routes.
      'html.validate.scripts': false,
    },
    prepare: addBlog,
  });
  const { page: editor } = rig.vscode;
  const frames: Frame[] = [];
  const templateFile = join(rig.project.dir, 'src/pages/blog/[slug].html');
  const heading = () => rig.page.locator('h1').first().textContent();
  try {
    // Beat 1: the URL does not exist yet, so the dev server answers with the starter's 404 page.
    await openFile(editor, '[slug].html');
    const second = await readLine(templateFile, "{ slug: 'second-post'");
    // Going to the last line first makes the editor scroll so the routes script sits at the top.
    await gotoLine(editor, 29, 1);
    await gotoLine(editor, second.line, second.text.length + 1);
    if ((await heading()) === 'Third post') throw new Error('The third post exists before it was added');
    await rig.snap(frames, INTRO_HOLD + 1400);

    // Beat 2: add a route. Duplicate the last entry, then rename it.
    await press(editor, 'Shift+Alt+ArrowDown');
    await rig.snap(frames, 700);
    const added = second.line + 1;
    const slugEnd = second.text.indexOf('second-post') + 1 + 'second'.length;
    await selectBackwards(editor, added, slugEnd, 'second'.length);
    await rig.snap(frames, 500);
    await editor.keyboard.type('third');
    await rig.snap(frames, 500);
    // Columns are 1-based, and "third" is one letter shorter than "second", so the title moved left by one.
    const titleEnd = second.text.indexOf('Second post') + 1 + 'Second'.length - 1;
    await selectBackwards(editor, added, titleEnd, 'Second'.length);
    await rig.snap(frames, 500);
    await editor.keyboard.type('Third');
    await rig.snap(frames, 800);
    await press(editor, 'Meta+s');
    const saved = await readFile(templateFile, 'utf8');
    if (!saved.includes("{ slug: 'third-post', title: 'Third post' },")) {
      throw new Error(`The route edit did not save as expected:\n${saved}`);
    }

    // Beat 3: the same URL now renders the template with the new route's data.
    const deadline = Date.now() + 15_000;
    while ((await heading()) !== 'Third post') {
      if (Date.now() > deadline) throw new Error('The new route never rendered');
      await sleep(300);
      await rig.page.reload();
    }
    await rig.snap(frames, OUTRO_HOLD);
    return frames;
  } finally {
    await rig.close();
  }
}

async function sitemap(): Promise<Frame[]> {
  const project = await createStarterProject();
  await addBlog(project.dir);
  const browser = await chromium.launch();
  try {
    const pairs = await redactions(project);
    const typed = 'bascik --build --site-url https://example.com && cat dist/sitemap.xml';
    // The real build runs, then the real file it wrote is printed. Only how bascik is reached differs.
    const recording = await recordCommand({
      command: '/bin/sh',
      args: ['-c', `"${process.execPath}" "${bascikBin}" --build --site-url https://example.com && cat dist/sitemap.xml`],
      cwd: project.dir,
    });
    const text = recording.chunks.map((chunk) => chunk.text).join('');
    if (recording.exitCode !== 0 || !text.includes('<loc>https://example.com/blog/second-post</loc>')) {
      throw new Error(`The build did not write the expected sitemap:\n${text}`);
    }
    for (const chunk of recording.chunks) chunk.text = redact(chunk.text, pairs);
    return await renderTerminal(browser, { title: 'bascik --build', rows: 26, width: 780 }, {
      typed,
      recording,
      maxGapMs: 500,
      finalHoldMs: OUTRO_HOLD + 1000,
    });
  } finally {
    await browser.close();
    await project.cleanup();
  }
}

/** A real route: one GET handler, so every other method is refused with an Allow header. */
const USERS_ROUTE = `export const GET = async (
  _request: Request,
  context: { params: Record<string, string> }
): Promise<Response> => {
  return Response.json({ id: context.params.id, name: 'Ada' });
};
`;

async function apiRoutes(): Promise<Frame[]> {
  const project = await createStarterProject();
  await mkdir(join(project.dir, 'src/api/users'), { recursive: true });
  await writeFile(join(project.dir, 'src/api/users/[id].ts'), USERS_ROUTE);
  const server = await startDevServer(project.dir, PORT);
  const browser = await chromium.launch();
  try {
    // Only the port differs from what the reader would type: this is the command, run as written.
    const typed =
      "curl -s -w ' %{http_code}\\n' localhost:8080/api/users/42; " +
      "curl -s -X DELETE -o /dev/null -w '%{http_code} %header{allow}\\n' localhost:8080/api/users/42";
    const recording = await recordCommand({
      command: '/bin/sh',
      args: ['-c', typed.split('localhost:8080').join(`localhost:${PORT}`)],
      cwd: project.dir,
    });
    const text = recording.chunks.map((chunk) => chunk.text).join('');
    if (!text.includes('"name":"Ada"} 200') || !/405 GET, HEAD, OPTIONS/.test(text)) {
      throw new Error(`The requests did not return the expected responses:\n${text}`);
    }
    return await renderTerminal(browser, { title: 'curl', rows: 6, width: 780 }, {
      typed,
      recording,
      maxGapMs: 600,
      finalHoldMs: OUTRO_HOLD + 1000,
    });
  } finally {
    await browser.close();
    await server.stop();
    await project.cleanup();
  }
}

/** The DevTools frontend port. Separate from the dev server's. */
const DEVTOOLS_PORT = 9334;

/**
 * The browser above, and real Chrome DevTools docked under it, debugging the starter's two counters. DevTools is
 * Chrome's own frontend, served by the inspected browser and opened in a second one so it can be photographed.
 */
async function devtoolsBreakpoint(): Promise<Frame[]> {
  const project = await createStarterProject();
  const server = await startDevServer(project.dir, PORT);
  // The full Chromium build serves the DevTools frontend; the headless shell does not.
  const inspected = await chromium.launch({
    channel: 'chromium',
    args: [`--remote-debugging-port=${DEVTOOLS_PORT}`, '--remote-allow-origins=*'],
  });
  const frontend = await chromium.launch();
  const frames: Frame[] = [];
  try {
    const counterFile = join(project.dir, 'src/components/my-counter/my-counter.html');
    const increment = await readLine(counterFile, '++count');
    const page = await inspected.newPage({ viewport: { width: 664, height: 132 }, deviceScaleFactor: 2 });
    await page.goto(server.url);
    // Below the sticky header, so the counters are in view and nothing covers the button.
    const showCounters = () =>
      page.evaluate(() => {
        const header = document.querySelector('header')?.getBoundingClientRect().height ?? 0;
        const counter = document.querySelector('[data-testid="counter-inc"]')!;
        window.scrollTo(0, counter.getBoundingClientRect().top + window.scrollY - header - 24);
      });
    await showCounters();
    const targets = (await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json()) as Array<{ id: string; url: string }>;
    const target = targets.find((candidate) => candidate.url.startsWith(server.url))!;
    const tools = await frontend.newPage({ viewport: { width: 664, height: 470 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const ws = `127.0.0.1:${DEVTOOLS_PORT}/devtools/page/${target.id}`;
    await tools.goto(`http://127.0.0.1:${DEVTOOLS_PORT}/devtools/inspector.html?ws=${ws}&panel=sources`);
    await tools.waitForSelector('.navigator-tabbed-pane', { timeout: 30_000 });
    await sleep(1500);
    // DevTools opens a screencast of the page when the frontend is not docked; the page is shown above instead.
    const screencast = tools.locator('[aria-label="Toggle screencast"]');
    if (await screencast.count()) await screencast.first().click();
    await sleep(500);
    // A frontend opened this way attaches with the page paused. Let it run.
    if (await tools.getByText('Debugger paused').count()) {
      await press(tools, 'F8');
      await sleep(500);
      // The pause opened whatever script was running in a tab of its own. Close it.
      await press(tools, 'Alt+w');
    }
    await sleep(500);
    // In a pane this narrow the file tree would leave the editor no room.
    await press(tools, 'Meta+Shift+y');
    await sleep(500);

    // The page cannot be photographed while it is paused, so the last picture is kept until it resumes.
    let pagePane = await browserWindow(await page.screenshot(), SHOWN_URL).then((window) => roundCorners(window));
    const snap = async (hold: number, { refreshPage = true } = {}) => {
      await sleep(250);
      if (refreshPage) pagePane = await browserWindow(await page.screenshot(), SHOWN_URL).then((window) => roundCorners(window));
      pushFrame(frames, await stacked(pagePane, await roundCorners(await tools.screenshot())), hold);
    };

    // Beat 1: each counter's script is its own file, named after the component.
    await press(tools, 'Meta+p');
    await sleep(400);
    for (const chunk of ['my-', 'cou', 'nter']) {
      await tools.keyboard.type(chunk);
      await sleep(150);
    }
    await sleep(800);
    await snap(INTRO_HOLD + 1800);

    // Beat 2: open the first instance at the line that increments the count, and set a breakpoint there.
    await press(tools, 'Enter');
    await sleep(800);
    await press(tools, 'Meta+p');
    await tools.keyboard.type(`:${increment.line}`);
    await sleep(600);
    await press(tools, 'Enter');
    await sleep(800);
    await snap(1600);
    const gutter = tools.locator('.cm-lineNumbers .cm-gutterElement', { hasText: new RegExp(`^${increment.line}$`) });
    await gutter.first().click();
    await snap(1400);

    // Beat 3: click "+". The page pauses on the same line number as in the file.
    await page.getByTestId('counter-inc').first().click({ noWaitAfter: true, timeout: 1500 }).catch(() => undefined);
    await tools.locator('.cm-executionLine').waitFor({ timeout: 10_000 });
    await snap(3600, { refreshPage: false });

    // Beat 4: resume, and the count changes.
    await press(tools, 'F8');
    await page.waitForFunction(() => document.querySelector('[data-testid="counter-val"]')?.textContent === '1', null, {
      timeout: 10_000,
    });
    await showCounters();
    await snap(OUTRO_HOLD);
    return frames;
  } finally {
    await frontend.close();
    await inspected.close();
    await server.stop();
    await project.cleanup();
  }
}

const scenes: Record<string, () => Promise<Frame[]>> = {
  'live-reload': () => liveReload('side'),
  'live-reload-stacked': () => liveReload('stacked'),
  'error-overlay': errorOverlay,
  'component-tag': componentTag,
  stream,
  'dev-terminal': devTerminal,
  lint,
  'markdown-watch': markdownWatch,
  'server-request': serverRequest,
  'exec-watch': execWatch,
  'dynamic-routes': dynamicRoutes,
  sitemap,
  'api-routes': apiRoutes,
  'devtools-breakpoint': devtoolsBreakpoint,
};

const wanted = process.argv.slice(2);
const unknown = wanted.filter((name) => !(name in scenes));
if (unknown.length) throw new Error(`Unknown scene(s): ${unknown.join(', ')}. Scenes: ${Object.keys(scenes).join(', ')}`);

for (const name of wanted.length ? wanted : Object.keys(scenes)) {
  await writeScene(outDir, name, await scenes[name]());
}
