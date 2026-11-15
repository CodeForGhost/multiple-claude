// End-to-end: two real daemons ("laptop" hosts a backend, "mac" uses it) with the mock engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(here, '..', 'dist', 'bridge.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'));

const laptop = { name: 'laptop', home: path.join(root, 'home-laptop'), hostPort: 47700, localPort: 47701 };
const mac = { name: 'mac', home: path.join(root, 'home-mac'), hostPort: 47710, localPort: 47711 };
const backend = path.join(root, 'shop-backend');
const mobile = path.join(root, 'shop-mobile');
const procs = [];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function startDaemon(d) {
  const p = spawn(process.execPath, [BUNDLE, 'daemon'], {
    env: {
      ...process.env,
      BRIDGE_HOME: d.home,
      BRIDGE_NAME: d.name,
      BRIDGE_HOST_PORT: String(d.hostPort),
      BRIDGE_LOCAL_PORT: String(d.localPort),
      BRIDGE_ENGINE: 'mock',
      BRIDGE_NO_MDNS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (x) => process.stderr.write(`[${d.name}] ${x}`));
  procs.push(p);
}

async function api(d, method, p, body) {
  const token = fs.readFileSync(path.join(d.home, 'local-token'), 'utf8').trim();
  const r = await fetch(`http://127.0.0.1:${d.localPort}${p}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-bridge-token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const jobIdOf = (text) => text.match(/job `([0-9a-f]+)`/)[1];

before(async () => {
  // A small backend repo with dependencies and an .env that must survive worktree cleanup.
  fs.mkdirSync(path.join(backend, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(backend, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(backend, '.env'), 'PORT=4000\n');
  fs.writeFileSync(path.join(backend, '.gitignore'), 'node_modules\n.env\n');
  fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({
    name: 'shop-backend',
    scripts: { dev: 'node server.js', test: 'node -e "require(\'dep\'); console.log(\'tests ok\')"' },
    dependencies: { express: '^4.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(backend, 'server.js'), 'console.log("hi")\n');
  git(backend, 'init', '-q', '-b', 'main');
  git(backend, 'add', '-A');
  git(backend, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  fs.mkdirSync(mobile, { recursive: true });

  startDaemon(laptop);
  startDaemon(mac);
  for (const d of [laptop, mac]) {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${d.localPort}/health`)).ok);
  }
});

after(() => {
  for (const p of procs) p.kill();
  setTimeout(() => fs.rmSync(root, { recursive: true, force: true }), 500);
});

test('share detects the project profile', async () => {
  const p = await api(laptop, 'POST', '/api/projects', { path: backend });
  assert.equal(p.name, 'shop-backend');
  assert.equal(p.permission, 'branch');
  assert.equal(p.testCommand, 'npm test');
  assert.equal(p.devPort, 4000); // from .env
  assert.ok(p.frameworks.includes('Express'));
});

test('local API rejects requests without the token', async () => {
  const r = await fetch(`http://127.0.0.1:${laptop.localPort}/api/state`);
  assert.equal(r.status, 401);
});

test('wrong pairing code is rejected', async () => {
  await api(laptop, 'POST', '/api/pair/start');
  await assert.rejects(api(mac, 'POST', '/api/pair/join', { host: `127.0.0.1:${laptop.hostPort}`, code: '000000' }), /Wrong pairing code/);
});

test('pairing connects both directions over pinned TLS', async () => {
  const { code } = await api(laptop, 'POST', '/api/pair/start');
  const r = await api(mac, 'POST', '/api/pair/join', { host: `127.0.0.1:${laptop.hostPort}`, code });
  assert.equal(r.name, 'laptop');
  await waitFor(async () => (await api(mac, 'GET', '/api/state')).peers[0]?.online);
  await waitFor(async () => (await api(laptop, 'GET', '/api/state')).peers[0]?.online);
  const s = await api(laptop, 'GET', '/api/state');
  assert.equal(s.pairing, null, 'pairing code is consumed');
});

test('mac sees the shared project and auto-links its folder', async () => {
  const t = await api(mac, 'POST', '/api/tools/list_remote_projects', { cwd: mobile });
  assert.match(t, /laptop\/shop-backend/);
  assert.match(t, /linked to \*\*laptop\/shop-backend\*\*/);
});

test('ask answers and resumes the session for follow-ups', async () => {
  const a1 = await api(mac, 'POST', '/api/tools/ask', { cwd: mobile, question: 'What does GET /users return?' });
  assert.match(a1, /Mock answer \(session mock-session-\d+\): What does GET \/users return\?/);
  const a2 = await api(mac, 'POST', '/api/tools/ask', { cwd: mobile, question: 'And POST?' });
  assert.match(a2, /resumed\): And POST\?/);
});

test('change runs in a worktree, tests pass, apply merges and keeps node_modules', async () => {
  const t = await api(mac, 'POST', '/api/tools/change', { cwd: mobile, request: 'Add avatarUrl to GET /users/:id' });
  assert.match(t, /Change ready for review/);
  assert.match(t, /BRIDGE_MOCK\.md/);
  assert.match(t, /Tests: passed/);
  const id = jobIdOf(t);
  assert.ok(!fs.existsSync(path.join(backend, 'BRIDGE_MOCK.md')), 'working copy untouched before apply');
  assert.match(git(backend, 'branch', '--list'), new RegExp(`bridge/${id}`));

  const applied = await api(mac, 'POST', '/api/tools/apply', { jobId: id });
  assert.match(applied, /is applied/);
  assert.match(fs.readFileSync(path.join(backend, 'BRIDGE_MOCK.md'), 'utf8'), /Add avatarUrl/);
  assert.ok(fs.existsSync(path.join(backend, 'node_modules', 'dep', 'index.js')), 'node_modules survived worktree cleanup');
  assert.ok(fs.existsSync(path.join(backend, '.env')), '.env survived');
  assert.doesNotMatch(git(backend, 'branch', '--list'), /bridge\//);
  assert.equal(git(backend, 'worktree', 'list').split('\n').length, 1);
  assert.match(git(backend, 'log', '-1', '--format=%s'), /bridge: Add avatarUrl/);
});

test('discard throws a change away', async () => {
  const before = fs.readFileSync(path.join(backend, 'BRIDGE_MOCK.md'), 'utf8');
  const t = await api(mac, 'POST', '/api/tools/change', { cwd: mobile, request: 'Something we will not keep' });
  const id = jobIdOf(t);
  const d = await api(mac, 'POST', '/api/tools/discard', { jobId: id });
  assert.match(d, /discarded/);
  assert.equal(fs.readFileSync(path.join(backend, 'BRIDGE_MOCK.md'), 'utf8'), before);
  assert.doesNotMatch(git(backend, 'branch', '--list'), /bridge\//);
});

test('host approval policy holds changes until approved on the host', async () => {
  const s = await api(laptop, 'GET', '/api/state');
  await api(laptop, 'PATCH', `/api/projects/${s.projects[0].id}`, { applyPolicy: 'host' });
  const t = await api(mac, 'POST', '/api/tools/change', { cwd: mobile, request: 'Needs approval' });
  const id = jobIdOf(t);
  const w = await api(mac, 'POST', '/api/tools/apply', { jobId: id });
  assert.match(w, /waiting for approval/);
  assert.doesNotMatch(fs.readFileSync(path.join(backend, 'BRIDGE_MOCK.md'), 'utf8'), /Needs approval/);
  await api(laptop, 'POST', `/api/jobs/${id}/approve`);
  assert.match(fs.readFileSync(path.join(backend, 'BRIDGE_MOCK.md'), 'utf8'), /Needs approval/);
  const st = await api(mac, 'POST', '/api/tools/job_status', { jobId: id, waitSeconds: 0 });
  assert.match(st, /is applied/);
});

test('read-only projects refuse changes', async () => {
  const s = await api(laptop, 'GET', '/api/state');
  await api(laptop, 'PATCH', `/api/projects/${s.projects[0].id}`, { permission: 'read' });
  await assert.rejects(api(mac, 'POST', '/api/tools/change', { cwd: mobile, request: 'x' }), /read-only/);
});

test('status reports branch, dev server and recent jobs', async () => {
  const t = await api(mac, 'POST', '/api/tools/status', { cwd: mobile });
  assert.match(t, /Branch: main/);
  assert.match(t, /dev server on port 4000|Dev server on port 4000/i);
  assert.match(t, /Recent jobs/);
});

test('MCP server over stdio exposes the tools and answers from the linked project', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BUNDLE, 'mcp'],
    cwd: mobile,
    env: { ...process.env, BRIDGE_HOME: mac.home, BRIDGE_LOCAL_PORT: String(mac.localPort), CLAUDE_PROJECT_DIR: mobile },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(),
      ['apply', 'ask', 'change', 'discard', 'job_status', 'list_remote_projects', 'review', 'status']);
    const r = await client.callTool({ name: 'ask', arguments: { question: 'via MCP?' } });
    assert.equal(r.isError, false);
    assert.match(r.content[0].text, /via MCP\?/);
  } finally {
    await client.close();
  }
});

test('the reverse direction works: laptop sees mac has nothing shared', async () => {
  await assert.rejects(api(laptop, 'POST', '/api/tools/ask', { cwd: backend, question: 'hi' }), /share no projects/);
});
