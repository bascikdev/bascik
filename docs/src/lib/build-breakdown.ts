/**
 * build-breakdown.ts
 *
 * Renders the "where the time goes" panel on the /development-server page from `docs/build-timings.json`: one bar per
 * measured build (cold and warm), each split into the phases the CLI itself reports, drawn to a shared scale
 * so the warm build is visibly shorter. Everything shown is a measured number or a live count, never prose.
 */
import {
  countComponents,
  countSourcePages,
  formatSeconds,
  millisecondsPerPage,
  readBuildTimings,
  type BuildRunTimings,
  type BuildStatPaths,
  type BuildTimings,
  type ExecTiming,
} from './build-stats.ts';

/** Where the panel reads from. Counts can be given directly so tests need no filesystem. */
export interface BuildBreakdownPaths extends BuildStatPaths {
  pages?: number;
  components?: number;
}

export type SegmentId = 'startup' | 'pre' | 'pages' | 'post' | 'other';

export interface Segment {
  id: SegmentId;
  label: string;
  seconds: number;
  detail: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `scripts/generate-og-images.ts` becomes `generate-og-images`. */
export const scriptName = (script: string): string => (script.split('/').pop() ?? script).replace(/\.[cm]?[jt]s$/, '');

const names = (scripts: ExecTiming[]): string => scripts.map((script) => scriptName(script.script)).join(', ');

/** The phases of one build, in the order they happen, without the empty ones. */
export function segmentsFor(run: BuildRunTimings, kind: 'cold' | 'warm', facts: { pages: number; buildScripts: number }): Segment[] {
  const pre = run.execScripts.filter((script) => script.phase === 'pre');
  const post = run.execScripts.filter((script) => script.phase === 'post');
  const pagesDetail =
    kind === 'cold'
      ? `${facts.pages} pages, running ${facts.buildScripts} build scripts in isolated child processes`
      : `${facts.pages} pages, with build script results read from the cache`;
  const segments: Segment[] = [
    { id: 'startup', label: 'Start-up', seconds: run.startupSeconds, detail: 'Node boots and loads the config' },
    { id: 'pre', label: 'Pre scripts', seconds: run.preScriptsSeconds, detail: names(pre) || 'None' },
    { id: 'pages', label: 'Pages', seconds: run.pagesSeconds, detail: pagesDetail },
    { id: 'post', label: 'Post scripts', seconds: run.postScriptsSeconds, detail: names(post) || 'None' },
    { id: 'other', label: 'Everything else', seconds: run.otherSeconds, detail: 'Copying assets, the sitemap, the build manifest' },
  ];
  return segments.filter((segment) => segment.seconds > 0);
}

/** The bar's accessible name: the whole breakdown in one sentence. */
export function barLabel(name: string, run: BuildRunTimings, segments: Segment[]): string {
  return `${name}, ${formatSeconds(run.wallSeconds)} in total: ${segments.map((s) => `${s.label.toLowerCase()} ${formatSeconds(s.seconds)}`).join(', ')}`;
}

function renderRun(
  kind: 'cold' | 'warm',
  name: string,
  note: string,
  run: BuildRunTimings,
  scaleSeconds: number,
  facts: { pages: number; buildScripts: number },
): string {
  const segments = segmentsFor(run, kind, facts);
  const width = Math.max(1, (run.wallSeconds / scaleSeconds) * 100);
  const bar = segments
    .map((segment) => `<span class="bb-seg bb-seg-${segment.id}" style="flex-grow:${segment.seconds}"></span>`)
    .join('');
  const legend = segments
    .map(
      (segment) =>
        `<li class="bb-legend-row"><span class="bb-swatch bb-seg-${segment.id}" aria-hidden="true"></span>` +
        `<span class="bb-legend-label">${escapeHtml(segment.label)}</span>` +
        `<span class="bb-legend-time">${formatSeconds(segment.seconds)}</span>` +
        `<span class="bb-legend-detail">${escapeHtml(segment.detail)}</span></li>`,
    )
    .join('');
  return (
    `<div class="bb-run">` +
    `<div class="bb-run-head"><h4 class="bb-run-name">${escapeHtml(name)}</h4><span class="bb-run-total">${formatSeconds(run.wallSeconds)}</span></div>` +
    `<p class="bb-run-note">${escapeHtml(note)}</p>` +
    `<div class="bb-bar" role="img" aria-label="${escapeHtml(barLabel(name, run, segments))}" style="width:${width.toFixed(1)}%">${bar}</div>` +
    `<ul class="bb-legend">${legend}</ul>` +
    `</div>`
  );
}

function renderFact(value: string, label: string): string {
  return `<div class="bb-fact"><span class="bb-fact-value">${escapeHtml(value)}</span><span class="bb-fact-label">${escapeHtml(label)}</span></div>`;
}

/** The scripts that run alongside page compilation, each with how long it took in the cold build. */
function renderParallel(timings: BuildTimings): string {
  const parallel = timings.cold.execScripts.filter((script) => script.phase === 'parallel').sort((a, b) => b.seconds - a.seconds);
  if (parallel.length === 0) return '';
  const chips = parallel
    .map((script) => `<li class="bb-chip"><span class="bb-chip-name">${escapeHtml(scriptName(script.script))}</span><span class="bb-chip-time">${formatSeconds(script.seconds)}</span></li>`)
    .join('');
  return (
    `<div class="bb-parallel"><h4 class="bb-parallel-title">Also running during the page compile</h4>` +
    `<p class="bb-parallel-note">These ${parallel.length} exec scripts run in parallel with the pages, so they add no time of their own: the longest is ${formatSeconds(parallel[0].seconds)}.</p>` +
    `<ul class="bb-chips">${chips}</ul></div>`
  );
}

/** Renders the whole panel. `components` is injectable so tests need no filesystem. */
export async function renderBuildBreakdown(paths: BuildBreakdownPaths = {}): Promise<string> {
  const timings = await readBuildTimings(paths.timingsPath).catch(() => undefined);
  // `yarn docs:measure-build` runs a full build to produce this file, so that build must not need it. The
  // unit tests fail when the file is missing or stale, which is where that is enforced.
  if (!timings?.cold || !timings.warm) {
    return '<p class="bb-foot">Build timings have not been measured yet. Run <code>yarn docs:measure-build</code>.</p>';
  }
  const components = paths.components ?? (await countComponents(paths.componentDirs));
  const pages = paths.pages ?? (await countSourcePages(paths.pagesDir));
  const facts = { pages, buildScripts: timings.buildScripts };
  const scale = Math.max(timings.cold.wallSeconds, timings.warm.wallSeconds);
  const slowest = timings.warm.slowestPage;

  return (
    `<div class="bb">` +
    `<div class="bb-facts">` +
    renderFact(String(pages), 'pages') +
    renderFact(String(components), 'components') +
    renderFact(String(timings.buildScripts), 'build scripts run') +
    renderFact(`${millisecondsPerPage(timings.warm.pagesSeconds, timings.pages)}ms`, 'per page, warm') +
    `</div>` +
    `<div class="bb-runs">` +
    renderRun('cold', 'Cold build', 'No script cache: every build script runs.', timings.cold, scale, facts) +
    renderRun('warm', 'Warm build', 'Right after: unchanged build scripts are served from the cache.', timings.warm, scale, facts) +
    `</div>` +
    renderParallel(timings) +
    `<p class="bb-foot">Median page ${timings.warm.pageMedianMs}ms, slowest ${escapeHtml(slowest.path.replace(/^pages\//, ''))} at ${slowest.ms}ms (warm). ` +
    `Measured ${escapeHtml(timings.measuredOn)} on ${escapeHtml(timings.machine)} with Node ${escapeHtml(timings.nodeVersion)}. ` +
    `Re-measure with <code>yarn docs:measure-build</code>.</p>` +
    `</div>`
  );
}
