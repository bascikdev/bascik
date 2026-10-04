import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runPair, assertOutsideRepository } from './runner.mjs';

const source = fileURLToPath(new URL('../fixtures/tiny-upstream/', import.meta.url));
const spec = { source, build: [process.execPath, 'build.mjs'], serve: [process.execPath, 'serve.mjs'] };
const repository = fileURLToPath(new URL('../../', import.meta.url));

async function check({ upstream, bascik }) {
  for (const route of ['/', '/about/']) {
    const responses = await Promise.all([upstream, bascik].map((site) => fetch(site.url + route)));
    const bodies = await Promise.all(responses.map((response) => response.text()));
    assert.equal(responses[0].status, 200, `upstream route ${route}`);
    assert.equal(responses[1].status, 200, `bascik route ${route}`);
    assert.equal(bodies[1], bodies[0], `content mismatch on ${route}`);
  }
}

async function clean(observed) {
  for (const site of observed) {
    assertOutsideRepository(site.cwd, repository);
    await assert.rejects(access(site.cwd), { code: 'ENOENT' });
    assert.throws(() => process.kill(site.pid, 0), { code: 'ESRCH' });
    await assert.rejects(fetch(site.url), /fetch failed/);
  }
}

test('known content mismatch fails, corrected fixture passes, both runs clean up', async () => {
  const original = await readFile(join(source, 'build.mjs'), 'utf8');
  const observed = [];
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, check, observe: (site) => observed.push(site),
    prepare: async (name, site) => {
      if (name === 'bascik') await writeFile(join(site.cwd, 'build.mjs'), original.replace('Original fixture', 'Wrong fixture'));
    },
  }), /content mismatch on \//);
  await clean(observed);
  const corrected = [];
  await runPair({ upstream: spec, bascik: spec, check, observe: (site) => corrected.push(site) });
  assert.notEqual(corrected[0].port, corrected[1].port);
  assert.notEqual(corrected[0].cwd, corrected[1].cwd);
  await clean(corrected);
  assert.equal(await readFile(join(source, 'build.mjs'), 'utf8'), original);
});

test('missing route is detected without modifying authoring input', async () => {
  const observed = [];
  await assert.rejects(runPair({
    upstream: spec, bascik: spec, check, observe: (site) => observed.push(site),
    prepare: async (name, site) => {
      if (name === 'bascik') {
        const text = await readFile(join(site.cwd, 'serve.mjs'), 'utf8');
        await writeFile(join(site.cwd, 'serve.mjs'), text.replace("'/about/':", "'/missing/':"));
      }
    },
  }), /bascik route \/about\//);
  await clean(observed);
});

test('startup failure propagates and shuts down the already running peer', async () => {
  const observed = [];
  await assert.rejects(runPair({
    upstream: spec,
    bascik: { ...spec, serve: [process.execPath, '-e', 'console.error("intentional startup failure"); process.exit(7)'] },
    check, observe: (site) => observed.push(site),
  }), /intentional startup failure/);
  await clean(observed);
});

test('build failure propagates and removes both isolated copies', async () => {
  const observed = [];
  await assert.rejects(runPair({
    upstream: spec,
    bascik: { ...spec, build: [process.execPath, '-e', 'process.exit(9)'] },
    check, observe: (site) => observed.push(site),
  }), /Command failed \(9\)/);
  await clean(observed);
});

// Like the Bascik dev server: the home page is real while unknown paths still get the boot page
// (post-phase exec scripts are running), then the boot ends and the late file appears.
// Waiting for the home page alone was the cause of the flaky Eleventy dev lane (feed 404).
test('startup waits until unknown paths stop getting the dev boot page', async () => {
  const observed = [];
  const booting = `
    const { createServer } = require('node:http');
    const started = Date.now();
    createServer((request, response) => {
      const booted = Date.now() - started > 1500;
      if (request.url === '/') return response.end('<p>home</p>');
      // A file path is 404 until the script that writes it finishes, as /feed/feed.xml is.
      if (request.url === '/late.xml') return booted ? response.end('<feed/>') : response.writeHead(404).end();
      if (!booted) return response.end('<script src="/bascik-live-reload?boot=1"></script>');
      response.writeHead(404).end('Not found');
    }).listen(Number(process.env.PORT), '127.0.0.1');`;
  const serve = { source, serve: [process.execPath, '-e', booting] };
  await runPair({
    upstream: serve, bascik: serve, observe: (site) => observed.push(site),
    check: async ({ bascik }) => {
      assert.equal((await fetch(bascik.url + '/late.xml')).status, 200, 'late file is served');
      assert.equal((await fetch(bascik.url + '/missing/')).status, 404, 'unknown path is a real 404');
    },
  });
  await clean(observed);
});

test('startup deadline cleans up a process that never listens', async () => {
  const observed = [];
  await assert.rejects(runPair({
    upstream: spec,
    bascik: { ...spec, serve: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] },
    check, timeoutMs: 500, observe: (site) => observed.push(site),
  }), /Startup timed out/);
  await clean(observed);
});

test('check failure kills a signal-resistant descendant as well as the peer', async () => {
  let descendant;
  const live = [];
  await assert.rejects(runPair({
    upstream: spec, bascik: spec,
    prepare: async (name, site) => {
      if (name !== 'bascik') return;
      await writeFile(join(site.cwd, 'serve.mjs'), `
        import { spawn } from 'node:child_process';
        import { writeFileSync } from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)']);
        child.stdout.once('data', () => writeFileSync('descendant.pid', String(child.pid)));
        await import('./actual-server.mjs');
      `);
      await writeFile(join(site.cwd, 'actual-server.mjs'), await readFile(join(source, 'serve.mjs')));
    },
    observe: (site) => live.push(site),
    check: async (sites) => {
      const deadline = Date.now() + 2000;
      while (!descendant && Date.now() < deadline) {
        try { descendant = Number(await readFile(join(sites.bascik.cwd, 'descendant.pid'), 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; await delay(10); }
      }
      assert.ok(descendant, 'descendant startup acknowledged');
      throw new Error('intentional check failure with descendant');
    },
  }), /intentional check failure with descendant/);
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try { process.kill(descendant, 0); }
    catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await delay(10);
  }
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  await clean(live);
});