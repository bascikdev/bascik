import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', '<!doctype html><html lang="en"><title>Fixture</title><h1 data-testid="title">Original fixture</h1><a data-testid="about-link" href="/about/">About</a></html>');
await mkdir('dist/about', { recursive: true });
await writeFile('dist/about/index.html', '<!doctype html><html lang="en"><title>About</title><h1 data-testid="title">About this fixture</h1></html>');