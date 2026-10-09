/** Paired controls at identical source paths, so deterministic instance IDs remain comparable. */
import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execute } from './profile-runner.ts';
import { cleanGeneratorEnvironment, validatePrivateDirectory, digest } from './profile-workload.ts';

const { values } = parseArgs({
  options: {
    project: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
    'report-dir': { type: 'string' }, rounds: { type: 'string', default: '3' }, mode: { type: 'string', default: 'build' },
    edits: { type: 'boolean', default: false },
  }
});
assert(values.project && values.baseline && values.candidate && values['report-dir']);
assert(['dev', 'build'].includes(values.mode!));
const repository = fileURLToPath(new URL('../../', import.meta.url));
const root = await validatePrivateDirectory(values['report-dir'], [repository]);
const project = await realpath(values.project);
const distance = relative(repository, project);
assert(isAbsolute(distance) || distance === '..' || distance.startsWith('../'), 'project must be private and outside repository');
assert(!(await lstat(join(project, 'node_modules'))).isSymbolicLink(), 'project cache parent must not be a symlink');
await mkdir(root, { recursive: true, mode: 0o700 });
assert.equal((await readdir(root)).length, 0);
const rounds = Number(values.rounds);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 10);
assert(!values.edits, 'paired byte-equivalence controls require unchanged authored sources; use compiler-timeline for edits');
const runs: Record<string, unknown>[] = [];
const sources: Record<string, string> = {};
for (const [name, path] of [['baseline', values.baseline], ['candidate', values.candidate]]) {
  sources[name] = digest(await readFile(join(path!, 'dist/lib/html-minifier.js')));
}
for (let round = 1; round <= rounds; round++) for (const state of ['cold', 'warm']) {
  const order = round % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
  let expected: { path: string; sha256: string }[] | undefined;
  for (const name of order) {
    if (state === 'cold') await rm(join(project, 'node_modules/.cache'), { recursive: true, force: true });
    const directory = join(root, `${round}-${state}-${name}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resultPath = join(directory, 'subject.json');
    const compiler = name === 'baseline' ? values.baseline : values.candidate;
    console.log(`Paired ${values.mode} ${round} ${state} ${name}`);
    await execute([process.execPath, fileURLToPath(new URL('./compiler-timeline-subject.ts', import.meta.url)), compiler!, values.mode!, resultPath, String(values.edits)], project, join(directory, 'capture'), {
      ...cleanGeneratorEnvironment(process.env), BASCIK_SITE_URL: 'https://bascik.dev',
    });
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (!values.edits) {
      if (expected) assert.deepEqual(result.outputs, expected, 'same-path compiler output changed');
      else expected = result.outputs;
    }
    const log = await readFile(join(directory, 'capture/process.log'), 'utf8');
    const pageMs = [...log.split('Server running at')[0].matchAll(/^transpiled: (.+) in ([\d.]+)(ms|s)/gm)].map(match => Number(match[2]) * (match[3] === 's' ? 1000 : 1));
    runs.push({ round, state, name, result, pageMs });
    await writeFile(join(root, 'comparison.json'), JSON.stringify({ sources, mode: values.mode, project, byteIdentical: !values.edits, runs }, null, 2), { mode: 0o600 });
  }
}
