// The Bridge daemon: one per machine. Hosts shared projects for peers, connects to peers,
// and exposes a localhost control API for the desktop app, the CLI and the MCP server.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { State, Project, files, ensureDir, localToken, randomId, now, normPath, safeEqual } from './state.js';
import { loadIdentity, shortFingerprint } from './tls.js';
import { createEngine } from './engine.js';
import { JobRunner } from './jobs.js';
import { HostServer, publicJob, publicProject } from './host.js';
import { PeerManager } from './peers.js';
import { Discovery } from './mdns.js';
import { Tools } from './tools.js';
import { detectProfile, looksLikeProject } from './profile.js';
import { discover } from './discover.js';
import { runBin, which } from './proc.js';
import { VERSION } from './version.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function log(...args: any[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(files.log, line + '\n'); } catch { /* ignore */ }
}

export async function startDaemon() {
  const state = new State();
  const identity = loadIdentity(state.config.name);
  const engine = createEngine();
  const jobs = new JobRunner(state, engine);
  const host = new HostServer(state, identity, jobs);
  const peers = new PeerManager(state, identity);
  const discovery = new Discovery();
  const tools = new Tools(state, peers);
  const token = localToken();

  // ---- SSE fan-out to local UIs ----
  const sse = new Set<http.ServerResponse>();
  const push = (event: string, data: any = {}) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(msg);
  };
  const notify = (title: string, body: string) => push('notify', { title, body });
  const changed = () => push('state');

  jobs.on('job', changed);
  jobs.on('approval-needed', (j) => notify('Change awaiting your approval', `${j.peerName} → ${j.projectName}: ${j.input.slice(0, 120)}`));
  host.on('pairing', changed);
  host.on('peer-socket', changed);
  host.on('paired', (peer) => {
    log('paired with', peer.name);
    peers.adopt(peer);
    notify('Device paired', `${peer.name} is now paired with this device.`);
    changed();
  });
  peers.on('peer-status', changed);
  peers.on('peer-event', (peerId: string, e: any) => {
    if (e.event === 'job' && state.remoteJobs[e.data?.id]) {
      const j = e.data;
      const msgs: Record<string, string> = {
        ready: 'Change ready for review',
        error: 'Request failed',
        applied: 'Change applied',
        rejected: 'Change rejected by host',
        done: j.type === 'ask' ? 'Answer received' : 'Request finished',
      };
      if (msgs[j.status]) notify(msgs[j.status], `${j.projectName}: ${String(j.input).slice(0, 120)}`);
      changed();
    }
  });
  discovery.on('up', (d) => {
    if (state.peer(d.id)) {
      peers.seen(d.id, d.addresses.map((a: string) => (a.includes(':') ? `[${a}]:${d.port}` : `${a}:${d.port}`)));
    }
  });
  discovery.on('change', changed);
  discovery.on('error', (e) => log('mDNS error', String(e)));

  // ---- project sharing ----
  async function share(dir: string): Promise<Project> {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`Folder not found: ${abs}`);
    const existing = state.projects.find((p) => normPath(p.path) === normPath(abs));
    if (existing) return existing;
    const profile = await detectProfile(abs);
    let name = profile.name;
    if (state.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${name}-${state.projects.length + 1}`;
    const project: Project = {
      id: randomId(4),
      name,
      path: abs,
      permission: profile.git.isRepo ? 'branch' : 'read',
      applyPolicy: 'peer',
      profile,
      askSessions: {},
      sharedAt: now(),
    };
    state.projects.push(project);
    state.saveProjects();
    log('shared', abs);
    changed();
    if (state.config.aiProfile) void aiSummary(project);
    return project;
  }

  async function aiSummary(project: Project) {
    const r = await engine.run({
      cwd: project.path,
      prompt: 'In at most 120 words, summarise this project for a client developer: what it is, its main API surface ' +
        '(resource names / route prefixes), auth scheme, and where the routes are defined. Plain text, no headings.',
      allowedTools: ['Read', 'Grep', 'Glob', 'LS'],
      timeoutMs: 4 * 60_000,
    });
    const p = state.project(project.id);
    if (p && !r.isError && r.text.trim()) {
      p.profile.summary = r.text.trim();
      state.saveProjects();
      changed();
    }
  }

  // ---- MCP registration with Claude Code ----
  function stableBundlePath(): string {
    const src = process.argv[1];
    ensureDir(files.bin);
    const dst = path.join(files.bin, 'bridge.cjs');
    try {
      if (src && fs.existsSync(src) && path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
    } catch { /* keep previous copy */ }
    return dst;
  }

  async function mcpStatus() {
    const claude = which('claude');
    if (!claude) return { claudeFound: false, registered: false };
    const r = await runBin(claude, ['mcp', 'get', 'bridge'], { timeoutMs: 20_000 });
    return { claudeFound: true, registered: r.code === 0 };
  }

  async function installMcp() {
    const claude = which('claude');
    if (!claude) throw new Error('Claude Code CLI not found. Install it first: https://claude.com/claude-code');
    const bundle = stableBundlePath();
    await runBin(claude, ['mcp', 'remove', 'bridge', '-s', 'user'], { timeoutMs: 20_000 });
    const r = await runBin(claude, ['mcp', 'add', '--scope', 'user', 'bridge', '--', process.execPath, bundle, 'mcp'], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim()}`);
    return { registered: true, command: `${process.execPath} ${bundle} mcp` };
  }

  // ---- localhost control API ----
  const routes: [string, RegExp, (m: RegExpMatchArray, body: any, url: URL) => Promise<any> | any][] = [
    ['GET', /^\/api\/state$/, async () => ({
      version: VERSION,
      engine: engine.name,
      device: {
        id: state.config.id,
        name: state.config.name,
        hostPort: state.config.hostPort,
        fingerprint: identity.fingerprint,
        shortFingerprint: shortFingerprint(identity.fingerprint),
        addresses: lanAddresses(),
        hostname: os.hostname(),
      },
      settings: { scanRoots: state.config.scanRoots, aiProfile: state.config.aiProfile },
      pairing: host.pairing && host.pairing.expiresAt > Date.now() ? { code: host.pairing.code, expiresAt: host.pairing.expiresAt } : null,
      peers: peers.status().map((p) => ({ ...p, connectedToUs: host.isConnected(p.id), shortFingerprint: shortFingerprint(p.fingerprint) })),
      discovered: discovery.list().map((d) => ({ ...d, paired: !!state.peer(d.id) })),
      projects: state.projects.map((p) => ({ ...publicProject(p), path: p.path, profile: p.profile })),
      jobs: state.jobs.slice(-50).reverse().map((j) => publicJob(j)),
    })],
    ['GET', /^\/api\/remote-projects$/, async () => {
      const { list, errors } = await tools.remoteProjects(true);
      return { projects: list, errors };
    }],
    ['GET', /^\/api\/candidates$/, () => discover(state.config.scanRoots, state.projects.map((p) => p.path))],
    ['POST', /^\/api\/projects$/, async (_m, b) => publicProject(await share(String(b.path || '')))],
    ['PATCH', /^\/api\/projects\/([\w-]+)$/, (m, b) => {
      const p = state.project(m[1]);
      if (!p) throw new Error('Unknown project');
      if (b.permission) {
        if (!['read', 'branch', 'direct'].includes(b.permission)) throw new Error('Invalid permission');
        if (b.permission === 'branch' && !p.profile.git.isRepo) throw new Error('Branch mode needs a git repository.');
        p.permission = b.permission;
      }
      if (b.applyPolicy) {
        if (!['peer', 'host'].includes(b.applyPolicy)) throw new Error('Invalid applyPolicy');
        p.applyPolicy = b.applyPolicy;
      }
      if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim();
      if (typeof b.testCommand === 'string') p.profile.testCommand = b.testCommand.trim() || undefined;
      if (b.devPort !== undefined) p.profile.devPort = Number(b.devPort) || undefined;
      state.saveProjects();
      changed();
      return publicProject(p);
    }],
    ['POST', /^\/api\/projects\/([\w-]+)\/refresh$/, async (m) => {
      const p = state.project(m[1]);
      if (!p) throw new Error('Unknown project');
      const summary = p.profile.summary;
      const keepTest = p.profile.testCommand;
      p.profile = await detectProfile(p.path);
      p.profile.summary = summary;
      p.profile.testCommand ??= keepTest;
      state.saveProjects();
      changed();
      if (state.config.aiProfile) void aiSummary(p);
      return publicProject(p);
    }],
    ['DELETE', /^\/api\/projects\/([\w-]+)$/, (m) => {
      state.projects = state.projects.filter((p) => p.id !== m[1]);
      state.saveProjects();
      changed();
      return { ok: true };
    }],
    ['POST', /^\/api\/pair\/start$/, () => {
      const p = host.startPairing();
      return { code: p.code, expiresAt: p.expiresAt, port: state.config.hostPort };
    }],
    ['POST', /^\/api\/pair\/cancel$/, () => { host.cancelPairing(); return { ok: true }; }],
    ['POST', /^\/api\/pair\/join$/, async (_m, b) => {
      const peer = await peers.pair(String(b.host || ''), String(b.code || ''));
      log('paired with', peer.name);
      notify('Device paired', `Paired with ${peer.name}.`);
      return { id: peer.id, name: peer.name };
    }],
    ['PATCH', /^\/api\/peers\/([\w-]+)$/, (m, b) => {
      const p = state.peer(m[1]);
      if (!p) throw new Error('Unknown peer');
      if (Array.isArray(b.hosts)) p.hosts = b.hosts.map(String).map((s: string) => s.trim()).filter(Boolean);
      state.savePeers();
      peers.adopt(p);
      return { ok: true };
    }],
    ['DELETE', /^\/api\/peers\/([\w-]+)$/, (m) => {
      host.disconnectPeer(m[1]);
      peers.remove(m[1]);
      return { ok: true };
    }],
    ['GET', /^\/api\/jobs\/([\w-]+)$/, (m) => {
      const j = jobs.get(m[1]);
      if (!j) throw new Error('Unknown job');
      return publicJob(j, true);
    }],
    ['POST', /^\/api\/jobs\/([\w-]+)\/approve$/, async (m) => publicJob(await jobs.apply(m[1], 'host'))],
    ['POST', /^\/api\/jobs\/([\w-]+)\/reject$/, async (m) => publicJob(await jobs.reject(m[1]))],
    ['POST', /^\/api\/jobs\/([\w-]+)\/discard$/, async (m) => publicJob(await jobs.discard(m[1]))],
    ['POST', /^\/api\/settings$/, (_m, b) => {
      if (typeof b.name === 'string' && b.name.trim()) state.config.name = b.name.trim().slice(0, 64);
      if (Array.isArray(b.scanRoots)) state.config.scanRoots = b.scanRoots.map(String).filter(Boolean);
      if (typeof b.aiProfile === 'boolean') state.config.aiProfile = b.aiProfile;
      state.saveConfig();
      changed();
      return { ok: true };
    }],
    ['GET', /^\/api\/mcp$/, () => mcpStatus()],
    ['POST', /^\/api\/mcp\/install$/, () => installMcp()],
    // ---- tools (used by the MCP server and CLI) ----
    ['POST', /^\/api\/tools\/list_remote_projects$/, (_m, b) => tools.listProjects(b.cwd)],
    ['POST', /^\/api\/tools\/ask$/, (_m, b) => tools.ask(String(b.cwd || process.cwd()), b.project || undefined, String(b.question || ''), !!b.fresh, Number(b.waitSeconds ?? 240))],
    ['POST', /^\/api\/tools\/change$/, (_m, b) => tools.change(String(b.cwd || process.cwd()), b.project || undefined, String(b.request || ''), Number(b.waitSeconds ?? 240))],
    ['POST', /^\/api\/tools\/job_status$/, (_m, b) => tools.jobStatus(String(b.jobId || ''), Number(b.waitSeconds ?? 120))],
    ['POST', /^\/api\/tools\/review$/, (_m, b) => tools.jobStatus(String(b.jobId || ''), 0, true)],
    ['POST', /^\/api\/tools\/apply$/, (_m, b) => tools.apply(String(b.jobId || ''))],
    ['POST', /^\/api\/tools\/discard$/, (_m, b) => tools.discard(String(b.jobId || ''))],
    ['POST', /^\/api\/tools\/status$/, (_m, b) => tools.status(String(b.cwd || process.cwd()), b.project || undefined)],
  ];

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, x-bridge-token');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'bridge', id: state.config.id, version: VERSION, pid: process.pid }));
      return;
    }
    const given = String(req.headers['x-bridge-token'] || url.searchParams.get('token') || '');
    if (!given || !safeEqual(given, token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('event: hello\ndata: {}\n\n');
      sse.add(res);
      const ka = setInterval(() => res.write(': ka\n\n'), 25_000);
      req.on('close', () => { clearInterval(ka); sse.delete(res); });
      return;
    }
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body: any = {};
    if (req.method !== 'GET') {
      const raw = await new Promise<string>((resolve) => {
        let d = '';
        req.on('data', (c) => { d += c; });
        req.on('end', () => resolve(d));
      });
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    }
    try {
      const result = await route[2](url.pathname.match(route[1])!, body, url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result ?? null));
    } catch (e: any) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  });

  // ---- start everything ----
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: any) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${state.config.localPort} is in use; is Bridge already running?`) : e));
    server.listen(state.config.localPort, '127.0.0.1', () => resolve());
  });
  await host.listen(state.config.hostPort);
  peers.start();
  discovery.start({ id: state.config.id, name: state.config.name, port: state.config.hostPort });
  log(`Bridge ${VERSION} "${state.config.name}" (${state.config.id}) engine=${engine.name}`);
  log(`peer port ${state.config.hostPort} (0.0.0.0), control API 127.0.0.1:${state.config.localPort}, state ${files.config.replace(/config\.json$/, '')}`);

  const shutdown = () => {
    log('shutting down');
    discovery.stop();
    peers.stop();
    host.close();
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { state, shutdown, share };
}

export { looksLikeProject };
