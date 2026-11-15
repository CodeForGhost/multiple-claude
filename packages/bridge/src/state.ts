// Persistent state for a Bridge device, stored as JSON files under ~/.bridge (or $BRIDGE_HOME).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Profile } from './profile.js';

export const HOME = process.env.BRIDGE_HOME || path.join(os.homedir(), '.bridge');
export const DEFAULT_HOST_PORT = Number(process.env.BRIDGE_HOST_PORT || 47600);
export const DEFAULT_LOCAL_PORT = Number(process.env.BRIDGE_LOCAL_PORT || 47601);

export const files = {
  config: path.join(HOME, 'config.json'),
  projects: path.join(HOME, 'projects.json'),
  peers: path.join(HOME, 'peers.json'),
  jobs: path.join(HOME, 'jobs.json'),
  links: path.join(HOME, 'links.json'),
  remoteJobs: path.join(HOME, 'remote-jobs.json'),
  cert: path.join(HOME, 'tls', 'cert.pem'),
  key: path.join(HOME, 'tls', 'key.pem'),
  localToken: path.join(HOME, 'local-token'),
  log: path.join(HOME, 'bridge.log'),
  worktrees: path.join(HOME, 'worktrees'),
  bin: path.join(HOME, 'bin'),
};

export type Permission = 'read' | 'branch' | 'direct';
export type ApplyPolicy = 'peer' | 'host';

export interface DeviceConfig {
  id: string;
  name: string;
  hostPort: number;
  localPort: number;
  scanRoots: string[];
  /** Run a one-off Claude pass to summarise a project's API when it is shared. */
  aiProfile: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  permission: Permission;
  applyPolicy: ApplyPolicy;
  profile: Profile;
  /** Claude session id per peer, so follow-up questions keep context. */
  askSessions: Record<string, string>;
  sharedAt: string;
}

export interface Peer {
  id: string;
  name: string;
  /** PEM certificate of the peer, pinned at pairing time. */
  cert: string;
  fingerprint: string;
  /** Token the peer issued to us; we present it when calling the peer. */
  tokenForThem: string;
  /** Token we issued to the peer; the peer presents it when calling us. */
  tokenForUs: string;
  port: number;
  /** User-supplied addresses (e.g. a Tailscale name). Tried first. */
  hosts: string[];
  /** Last address that worked or was seen via mDNS/pairing. */
  lastAddresses: string[];
  pairedAt: string;
}

export type JobStatus =
  | 'queued' | 'running' | 'ready' | 'awaiting-approval'
  | 'applied' | 'done' | 'discarded' | 'rejected' | 'error';

export interface TestRun { command: string; ok: boolean; exitCode: number | null; output: string }

export interface Job {
  id: string;
  type: 'ask' | 'change';
  projectId: string;
  projectName: string;
  peerId: string;
  peerName: string;
  input: string;
  status: JobStatus;
  result?: string;
  error?: string;
  branch?: string;
  worktree?: string;
  baseCommit?: string;
  linked?: string[];
  diff?: string;
  diffStat?: string;
  tests?: TestRun;
  costUsd?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Link { peerId: string; projectId: string; savedAt: string }

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function randomId(bytes = 8): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function now(): string {
  return new Date().toISOString();
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function normPath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** In-memory view of all state with save helpers. One instance per daemon. */
export class State {
  config: DeviceConfig;
  projects: Project[];
  peers: Peer[];
  jobs: Job[];
  links: Record<string, Link>;
  remoteJobs: Record<string, string>; // jobId -> peerId

  constructor() {
    ensureDir(HOME);
    const cfg = readJson<Partial<DeviceConfig>>(files.config, {});
    this.config = {
      id: cfg.id || randomId(8),
      name: process.env.BRIDGE_NAME || cfg.name || os.hostname(),
      hostPort: Number(process.env.BRIDGE_HOST_PORT || cfg.hostPort || DEFAULT_HOST_PORT),
      localPort: Number(process.env.BRIDGE_LOCAL_PORT || cfg.localPort || DEFAULT_LOCAL_PORT),
      scanRoots: cfg.scanRoots || [],
      aiProfile: cfg.aiProfile ?? true,
    };
    this.projects = readJson(files.projects, []);
    this.peers = readJson(files.peers, []);
    this.jobs = readJson(files.jobs, []);
    this.links = readJson(files.links, {});
    this.remoteJobs = readJson(files.remoteJobs, {});
    // Jobs interrupted by a restart can't resume.
    for (const j of this.jobs) {
      if (j.status === 'running' || j.status === 'queued') {
        j.status = 'error';
        j.error = 'Interrupted: Bridge restarted while this job was running.';
      }
    }
    this.saveConfig();
  }

  saveConfig() { writeJson(files.config, this.config); }
  saveProjects() { writeJson(files.projects, this.projects); }
  savePeers() { writeJson(files.peers, this.peers); }
  saveJobs() {
    // Keep history bounded.
    if (this.jobs.length > 300) this.jobs = this.jobs.slice(-300);
    writeJson(files.jobs, this.jobs);
  }
  saveLinks() { writeJson(files.links, this.links); }
  saveRemoteJobs() {
    const entries = Object.entries(this.remoteJobs);
    if (entries.length > 500) this.remoteJobs = Object.fromEntries(entries.slice(-500));
    writeJson(files.remoteJobs, this.remoteJobs);
  }

  project(idOrName: string): Project | undefined {
    const q = idOrName.toLowerCase();
    return this.projects.find((p) => p.id === idOrName) || this.projects.find((p) => p.name.toLowerCase() === q);
  }

  peer(id: string): Peer | undefined {
    return this.peers.find((p) => p.id === id);
  }
}

/** Token protecting the localhost control API (UI, CLI, MCP). */
export function localToken(): string {
  try {
    const t = fs.readFileSync(files.localToken, 'utf8').trim();
    if (t) return t;
  } catch { /* create below */ }
  ensureDir(HOME);
  const t = randomToken();
  fs.writeFileSync(files.localToken, t, { mode: 0o600 });
  return t;
}
