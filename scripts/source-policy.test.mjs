import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let fixture;
let policy;
let bundled;

before(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'codesensei-policy-test-'));
  bundled = path.join(os.tmpdir(), `codesensei-source-policy-${process.pid}.mjs`);
  await build({ entryPoints: [path.resolve('src/tutor/sourcePolicy.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundled });
  policy = await import(pathToFileURL(bundled).href);
});

after(async () => {
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(bundled, { force: true });
});

async function write(relative, contents = '') {
  const file = path.join(fixture, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

test('source-only analysis includes source and lightweight manifests but excludes dependencies, secrets, and build files', async () => {
  await write('package.json', '{"name":"fixture"}');
  await write('package-lock.json', '{"lockfileVersion":3}');
  await write('src/index.ts', 'export const value = 1;');
  await write('node_modules/pkg/index.js', 'secret dependency');
  await write('.env', 'TOKEN=secret');
  await write('Dockerfile', 'FROM node');
  const result = await policy.createAnalysisWorkspace(fixture, 'source-only');
  try {
    assert(result.files.includes('package.json'));
    assert(!result.files.includes('package-lock.json'));
    assert(result.files.includes('src/index.ts'));
    assert(!result.files.some((file) => file.includes('node_modules')));
    assert(!result.files.includes('.env'));
    assert(!result.files.includes('Dockerfile'));
  } finally { await result.cleanup(); }
});

test('approved build access includes classified root build files', async () => {
  const result = await policy.createAnalysisWorkspace(fixture, 'include-build-config');
  try { assert(result.files.includes('Dockerfile')); }
  finally { await result.cleanup(); }
});

test('project detection recognizes Java without reading the build file', () => {
  assert.equal(policy.detectProjectType(new Set(['pom.xml', 'src'])), 'Java / Spring-compatible');
});
