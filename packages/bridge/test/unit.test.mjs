// Unit tests for pure helpers, run against the TypeScript sources via esbuild's transform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-unit-')), 'helpers.mjs');
await build({
  stdin: {
    contents: `export { normalizeRemote, detectProfile } from './src/profile.ts';
               export { nameScore } from './src/tools.ts';
               export { parseHostPort } from './src/peers.ts';`,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
const h = await import(pathToFileURL(out).href);

test('normalizeRemote treats ssh and https forms of a repo as equal', () => {
  const a = h.normalizeRemote('git@github.com:Acme/Shop.git');
  assert.equal(a, 'github.com/acme/shop');
  assert.equal(h.normalizeRemote('https://github.com/acme/shop'), a);
  assert.equal(h.normalizeRemote('ssh://git@github.com:22/acme/shop.git'), a);
  assert.equal(h.normalizeRemote(undefined), undefined);
});

test('nameScore ignores generic words like backend/mobile', () => {
  assert.ok(h.nameScore('shop-mobile', 'shop-backend') > 0);
  assert.equal(h.nameScore('mobile-app', 'api-server'), 0);
  assert.ok(h.nameScore('shop-mobile', 'shop-backend') > h.nameScore('shop-mobile', 'blog-backend'));
});

test('parseHostPort handles names, ports and IPv6', () => {
  assert.deepEqual(h.parseHostPort('laptop', 47600), { host: 'laptop', port: 47600 });
  assert.deepEqual(h.parseHostPort('laptop.tail1234.ts.net:5000', 47600), { host: 'laptop.tail1234.ts.net', port: 5000 });
  assert.deepEqual(h.parseHostPort('[fe80::1]:47600', 1), { host: 'fe80::1', port: 47600 });
  assert.deepEqual(h.parseHostPort('https://10.0.0.5:47600/', 1), { host: '10.0.0.5', port: 47600 });
});

test('detectProfile recognises Python/FastAPI and Go projects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-prof-'));
  const py = path.join(root, 'py');
  fs.mkdirSync(py);
  fs.writeFileSync(path.join(py, 'pyproject.toml'), 'name = "orders"\ndependencies = ["fastapi", "pytest"]\n');
  const p = await h.detectProfile(py);
  assert.equal(p.name, 'orders');
  assert.ok(p.frameworks.includes('FastAPI'));
  assert.equal(p.testCommand, 'pytest -q');
  assert.equal(p.devPort, 8000);

  const go = path.join(root, 'go');
  fs.mkdirSync(go);
  fs.writeFileSync(path.join(go, 'go.mod'), 'module github.com/acme/payments\n\nrequire github.com/gin-gonic/gin v1.9.0\n');
  fs.mkdirSync(path.join(go, 'docs'));
  fs.writeFileSync(path.join(go, 'docs', 'openapi.yaml'), 'openapi: 3.0.0\n');
  const g = await h.detectProfile(go);
  assert.equal(g.name, 'payments');
  assert.equal(g.testCommand, 'go test ./...');
  assert.ok(g.frameworks.includes('Gin'));
  assert.equal(g.apiSpec, 'docs/openapi.yaml');
  assert.equal(g.git.isRepo, false);
});
