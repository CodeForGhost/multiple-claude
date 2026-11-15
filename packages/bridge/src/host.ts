// Peer-facing HTTPS + WebSocket server: pairing and the project/job RPC API.
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { serveRpc } from './rpc.js';
import { fingerprintOf, type Identity } from './tls.js';
import { State, Peer, Job, Project, randomToken, safeEqual, now } from './state.js';
import type { JobRunner } from './jobs.js';
import { git } from './proc.js';

const PAIR_TTL_MS = 5 * 60_000;
const MAX_PAIR_ATTEMPTS = 5;

export interface PairingCode { code: string; expiresAt: number; attempts: number }

export function publicJob(j: Job, withDiff = false) {
  const { worktree, linked, diff, ...rest } = j;
  return withDiff ? { ...rest, diff } : rest;
}

export function publicProject(p: Project) {
  return {
    id: p.id,
    name: p.name,
    permission: p.permission,
    applyPolicy: p.applyPolicy,
    stacks: p.profile.stacks,
    frameworks: p.profile.frameworks,
    testCommand: p.profile.testCommand,
    devPort: p.profile.devPort,
    apiSpec: p.profile.apiSpec,
    gitRemote: p.profile.git.remote,
    summary: p.profile.summary,
  };
}

export class HostServer extends EventEmitter {
  pairing?: PairingCode;
  private server?: https.Server;
  private sockets = new Map<string, Set<WebSocket>>();

  constructor(private state: State, private identity: Identity, private jobs: JobRunner) {
    super();
    jobs.on('job', (job: Job) => this.sendTo(job.peerId, 'job', publicJob(job)));
  }

  startPairing(): PairingCode {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.pairing = { code, expiresAt: Date.now() + PAIR_TTL_MS, attempts: 0 };
    this.emit('pairing', this.pairing);
    return this.pairing;
  }

  cancelPairing() {
    this.pairing = undefined;
    this.emit('pairing', undefined);
  }

  isConnected(peerId: string): boolean {
    return (this.sockets.get(peerId)?.size || 0) > 0;
  }

  private sendTo(peerId: string, event: string, data: any) {
    for (const ws of this.sockets.get(peerId) || []) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ event, data }));
    }
  }

  disconnectPeer(peerId: string) {
    for (const ws of this.sockets.get(peerId) || []) ws.close(4001, 'unpaired');
    this.sockets.delete(peerId);
  }

  listen(port: number): Promise<void> {
    this.server = https.createServer({ cert: this.identity.cert, key: this.identity.key }, (req, res) => {
      this.handleHttp(req, res).catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const peer = auth ? this.state.peers.find((p) => safeEqual(p.tokenForUs, auth)) : undefined;
      if (!peer || !req.url?.startsWith('/rpc')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.onPeerSocket(ws, peer, req.socket.remoteAddress));
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '0.0.0.0', () => resolve());
    });
  }

  close() {
    this.server?.close();
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
  }

  private async handleHttp(req: import('http').IncomingMessage, res: import('http').ServerResponse) {
    const json = (code: number, body: any) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/hello') {
      return json(200, { app: 'bridge', id: this.state.config.id, name: this.state.config.name, fingerprint: this.identity.fingerprint });
    }
    if (req.method === 'POST' && req.url === '/pair') {
      const body = await readBody(req);
      return json(...this.pair(body, req.socket.remoteAddress));
    }
    json(404, { error: 'not found' });
  }

  /** Pairing exchanges pinned certificates and a token in each direction. */
  private pair(body: any, remoteAddress?: string): [number, any] {
    const p = this.pairing;
    if (!p || Date.now() > p.expiresAt) return [403, { error: 'No active pairing code on this device. Click "Pair a device" first.' }];
    if (++p.attempts > MAX_PAIR_ATTEMPTS) {
      this.cancelPairing();
      return [429, { error: 'Too many attempts; pairing code invalidated. Start pairing again.' }];
    }
    if (!body || !safeEqual(String(body.code || ''), p.code)) return [403, { error: 'Wrong pairing code.' }];
    if (typeof body.id !== 'string' || typeof body.cert !== 'string' || typeof body.token !== 'string') {
      return [400, { error: 'Malformed pairing request.' }];
    }
    if (body.id === this.state.config.id) return [400, { error: 'A device cannot pair with itself.' }];
    let fingerprint: string;
    try { fingerprint = fingerprintOf(body.cert); } catch { return [400, { error: 'Invalid certificate.' }]; }

    const tokenForUs = randomToken();
    const addr = cleanAddress(remoteAddress);
    const existing = this.state.peer(body.id);
    const peer: Peer = {
      id: body.id,
      name: String(body.name || 'device').slice(0, 64),
      cert: body.cert,
      fingerprint,
      tokenForThem: body.token,
      tokenForUs,
      port: Number(body.port) || 47600,
      hosts: existing?.hosts || [],
      lastAddresses: addr ? [addr] : [],
      pairedAt: now(),
    };
    this.state.peers = this.state.peers.filter((x) => x.id !== peer.id);
    this.state.peers.push(peer);
    this.state.savePeers();
    this.cancelPairing();
    this.emit('paired', peer);
    return [200, {
      id: this.state.config.id,
      name: this.state.config.name,
      cert: this.identity.cert,
      port: this.state.config.hostPort,
      token: tokenForUs,
    }];
  }

  private onPeerSocket(ws: WebSocket, peer: Peer, remoteAddress?: string) {
    const addr = cleanAddress(remoteAddress);
    if (addr && !peer.lastAddresses.includes(addr)) {
      peer.lastAddresses = [addr, ...peer.lastAddresses].slice(0, 4);
      this.state.savePeers();
    }
    if (!this.sockets.has(peer.id)) this.sockets.set(peer.id, new Set());
    this.sockets.get(peer.id)!.add(ws);
    this.emit('peer-socket', peer.id, true);
    ws.on('close', () => {
      this.sockets.get(peer.id)?.delete(ws);
      this.emit('peer-socket', peer.id, this.isConnected(peer.id));
    });

    const live = () => this.state.peer(peer.id) || peer;
    const ownJob = (id: string) => {
      const j = this.jobs.get(String(id));
      if (!j || j.peerId !== peer.id) throw new Error(`Unknown job "${id}".`);
      return j;
    };
    serveRpc(ws, {
      hello: () => ({ id: this.state.config.id, name: this.state.config.name }),
      'projects.list': () => this.state.projects.map(publicProject),
      'projects.status': async ({ projectId }) => {
        const p = this.state.project(String(projectId));
        if (!p) throw new Error(`Unknown project "${projectId}".`);
        const branch = p.profile.git.isRepo ? (await git(p.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() : undefined;
        const dirty = p.profile.git.isRepo ? (await git(p.path, ['status', '--porcelain'])).stdout.trim().split('\n').filter(Boolean).length : undefined;
        const devServerUp = p.profile.devPort ? await portOpen(p.profile.devPort) : undefined;
        const recent = this.state.jobs.filter((j) => j.projectId === p.id).slice(-5).map((j) => publicJob(j));
        return { project: publicProject(p), branch, uncommittedFiles: dirty, devServerUp, recentJobs: recent };
      },
      'jobs.start': ({ projectId, type, input, fresh }) => {
        if (type !== 'ask' && type !== 'change') throw new Error('type must be ask or change');
        return publicJob(this.jobs.start(live(), String(projectId), type, String(input ?? ''), { fresh: !!fresh }));
      },
      'jobs.get': async ({ id, waitMs, withDiff }) => {
        ownJob(id);
        const j = await this.jobs.wait(String(id), Math.min(Number(waitMs) || 0, 55_000));
        return publicJob(j!, !!withDiff);
      },
      'jobs.list': () => this.state.jobs.filter((j) => j.peerId === peer.id).slice(-30).map((j) => publicJob(j)),
      'jobs.apply': async ({ id }) => { ownJob(id); return publicJob(await this.jobs.apply(String(id), 'peer', peer.id)); },
      'jobs.discard': async ({ id }) => { ownJob(id); return publicJob(await this.jobs.discard(String(id), peer.id)); },
    });
  }
}

export function cleanAddress(a?: string): string | undefined {
  if (!a) return undefined;
  return a.replace(/^::ffff:/, '');
}

function readBody(req: import('http').IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(undefined); } });
  });
}

export function portOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
