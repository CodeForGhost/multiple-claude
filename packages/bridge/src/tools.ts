// Client-side tool logic behind the MCP server: resolve which remote project a local
// folder belongs to, start/poll jobs on the peer, and format results for Claude.
import path from 'node:path';
import { git } from './proc.js';
import { normalizeRemote } from './profile.js';
import { State, normPath, now } from './state.js';
import type { PeerManager } from './peers.js';

export interface RemoteProject {
  peerId: string;
  peerName: string;
  id: string;
  name: string;
  permission: string;
  applyPolicy: string;
  stacks: string[];
  frameworks: string[];
  testCommand?: string;
  devPort?: number;
  apiSpec?: string;
  gitRemote?: string;
  summary?: string;
}

const GENERIC = new Set(['app', 'apps', 'api', 'backend', 'server', 'service', 'services', 'client', 'mobile', 'web',
  'frontend', 'front', 'back', 'end', 'ios', 'android', 'native', 'react', 'expo', 'flutter', 'site', 'admin', 'the', 'v2', 'new']);

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !GENERIC.has(t));
}

export function nameScore(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const qualified = (p: RemoteProject) => `${p.peerName}/${p.name}`;

export class Tools {
  private cache?: { at: number; list: RemoteProject[]; errors: string[] };

  constructor(private state: State, private peers: PeerManager) {}

  async remoteProjects(force = false): Promise<{ list: RemoteProject[]; errors: string[] }> {
    if (!force && this.cache && Date.now() - this.cache.at < 10_000) return this.cache;
    const list: RemoteProject[] = [];
    const errors: string[] = [];
    await Promise.all(this.peers.online().map(async (peer) => {
      try {
        const ps = await this.peers.call<any[]>(peer.id, 'projects.list', {}, 15_000);
        for (const p of ps) list.push({ ...p, peerId: peer.id, peerName: peer.name });
      } catch (e: any) {
        errors.push(`${peer.name}: ${e.message}`);
      }
    }));
    this.cache = { at: Date.now(), list, errors };
    return this.cache;
  }

  private async localRoot(cwd: string): Promise<{ root: string; remote?: string }> {
    const top = await git(cwd, ['rev-parse', '--show-toplevel']);
    const root = top.code === 0 ? path.resolve(top.stdout.trim()) : path.resolve(cwd);
    const rem = await git(root, ['remote', 'get-url', 'origin']);
    return { root, remote: rem.code === 0 ? rem.stdout.trim() : undefined };
  }

  /** Decide which remote project a request from `cwd` refers to. */
  async resolve(cwd: string, ref?: string): Promise<RemoteProject> {
    const { list, errors } = await this.remoteProjects();
    if (!this.state.peers.length) throw new Error('This device is not paired with any other device yet. Open the Bridge app and pair it.');
    if (!list.length) {
      const offline = this.state.peers.filter((p) => !this.peers.online().some((o) => o.id === p.id)).map((p) => p.name);
      throw new Error(offline.length
        ? `No shared projects reachable. Offline: ${offline.join(', ')}.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`
        : 'The paired device(s) are online but share no projects. Share a project in the Bridge app on that device.');
    }
    const { root, remote } = await this.localRoot(cwd);
    const key = normPath(root);

    if (ref) {
      const found = this.match(list, ref);
      this.state.links[key] = { peerId: found.peerId, projectId: found.id, savedAt: now() };
      this.state.saveLinks();
      return found;
    }

    const link = this.state.links[key];
    if (link) {
      const p = list.find((x) => x.peerId === link.peerId && x.id === link.projectId);
      if (p) return p;
    }

    const nr = normalizeRemote(remote);
    if (nr) {
      const same = list.filter((p) => normalizeRemote(p.gitRemote) === nr);
      if (same.length === 1) return this.remember(key, same[0]);
    }

    if (list.length === 1) return this.remember(key, list[0]);

    const scored = list.map((p) => ({ p, s: nameScore(path.basename(root), p.name) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length && (scored.length === 1 || scored[0].s > scored[1].s)) return this.remember(key, scored[0].p);

    throw new Error(
      `Several shared projects are available and I can't tell which one "${path.basename(root)}" uses. ` +
      `Call the tool again with project set to one of: ${list.map(qualified).join(', ')}. ` +
      `The choice is remembered for this folder.`);
  }

  private remember(key: string, p: RemoteProject): RemoteProject {
    this.state.links[key] = { peerId: p.peerId, projectId: p.id, savedAt: now() };
    this.state.saveLinks();
    return p;
  }

  private match(list: RemoteProject[], ref: string): RemoteProject {
    const r = ref.trim().toLowerCase();
    let pool = list;
    let proj = r;
    const slash = r.lastIndexOf('/');
    if (slash > 0) {
      const peerPart = r.slice(0, slash);
      proj = r.slice(slash + 1);
      pool = list.filter((p) => p.peerName.toLowerCase() === peerPart || p.peerId === peerPart);
    }
    const hits = pool.filter((p) => p.id === proj || p.name.toLowerCase() === proj);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${ref}" is ambiguous; use one of: ${hits.map(qualified).join(', ')}`);
    throw new Error(`No shared project "${ref}". Available: ${list.map(qualified).join(', ')}`);
  }

  // ---------- tool implementations (return markdown text) ----------

  async listProjects(cwd?: string): Promise<string> {
    const { list, errors } = await this.remoteProjects(true);
    const status = this.peers.status();
    const lines: string[] = [];
    if (!status.length) return 'Not paired with any device. Open the Bridge app to pair.';
    lines.push('## Paired devices');
    for (const s of status) lines.push(`- ${s.name}: ${s.online ? `online (${s.address})` : 'offline'}`);
    lines.push('', '## Shared projects');
    if (!list.length) lines.push('(none reachable)');
    for (const p of list) {
      const stack = [...p.stacks, ...p.frameworks].join(', ');
      lines.push(`- **${qualified(p)}** [${p.permission}${p.permission !== 'read' ? `, apply by ${p.applyPolicy}` : ''}] ${stack}` +
        `${p.devPort ? ` · dev port ${p.devPort}` : ''}${p.testCommand ? ` · tests: \`${p.testCommand}\`` : ''}${p.apiSpec ? ` · spec: ${p.apiSpec}` : ''}`);
      if (p.summary) lines.push(`  ${p.summary.replace(/\n+/g, ' ').slice(0, 400)}`);
    }
    if (cwd) {
      try {
        const linked = await this.resolve(cwd);
        lines.push('', `This folder is linked to **${qualified(linked)}**.`);
      } catch { /* not resolvable; fine */ }
    }
    if (errors.length) lines.push('', `Errors: ${errors.join('; ')}`);
    return lines.join('\n');
  }

  async ask(cwd: string, ref: string | undefined, question: string, fresh: boolean, waitSeconds: number): Promise<string> {
    const p = await this.resolve(cwd, ref);
    const job = await this.peers.call(p.peerId, 'jobs.start', { projectId: p.id, type: 'ask', input: question, fresh });
    this.trackJob(job.id, p.peerId);
    return this.formatJob(await this.poll(p.peerId, job.id, waitSeconds), p);
  }

  async change(cwd: string, ref: string | undefined, request: string, waitSeconds: number): Promise<string> {
    const p = await this.resolve(cwd, ref);
    const job = await this.peers.call(p.peerId, 'jobs.start', { projectId: p.id, type: 'change', input: request });
    this.trackJob(job.id, p.peerId);
    return this.formatJob(await this.poll(p.peerId, job.id, waitSeconds), p);
  }

  async jobStatus(jobId: string, waitSeconds: number, withDiff = false): Promise<string> {
    const peerId = await this.peerForJob(jobId);
    return this.formatJob(await this.poll(peerId, jobId, waitSeconds, withDiff), undefined, withDiff ? 60_000 : undefined);
  }

  async apply(jobId: string): Promise<string> {
    const peerId = await this.peerForJob(jobId);
    const job = await this.peers.call(peerId, 'jobs.apply', { id: jobId }, 120_000);
    return this.formatJob(job);
  }

  async discard(jobId: string): Promise<string> {
    const peerId = await this.peerForJob(jobId);
    const job = await this.peers.call(peerId, 'jobs.discard', { id: jobId }, 60_000);
    return this.formatJob(job);
  }

  async status(cwd: string, ref?: string): Promise<string> {
    const p = await this.resolve(cwd, ref);
    const s = await this.peers.call(p.peerId, 'projects.status', { projectId: p.id }, 20_000);
    const lines = [
      `## ${qualified(p)}`,
      `- Branch: ${s.branch ?? 'n/a'}${s.uncommittedFiles ? ` (${s.uncommittedFiles} uncommitted files)` : ''}`,
      `- Dev server${p.devPort ? ` on port ${p.devPort}` : ''}: ${s.devServerUp === undefined ? 'unknown' : s.devServerUp ? 'running' : 'not running'}`,
      `- Permission: ${p.permission}${p.permission !== 'read' ? `, changes applied by ${p.applyPolicy}` : ''}`,
    ];
    if (p.devPort) {
      const peerHost = this.peers.status().find((x) => x.id === p.peerId)?.address?.replace(/:\d+$/, '');
      if (peerHost) lines.push(`- From this machine the API is likely at http://${peerHost}:${p.devPort} (the server must listen on 0.0.0.0).`);
    }
    if (s.recentJobs?.length) {
      lines.push('', 'Recent jobs:');
      for (const j of s.recentJobs) lines.push(`- ${j.id} ${j.type} [${j.status}] ${j.input.split('\n')[0].slice(0, 80)}`);
    }
    return lines.join('\n');
  }

  // ---------- helpers ----------

  private trackJob(jobId: string, peerId: string) {
    this.state.remoteJobs[jobId] = peerId;
    this.state.saveRemoteJobs();
  }

  private async peerForJob(jobId: string): Promise<string> {
    const known = this.state.remoteJobs[jobId];
    if (known) return known;
    for (const peer of this.peers.online()) {
      try {
        await this.peers.call(peer.id, 'jobs.get', { id: jobId, waitMs: 0 }, 10_000);
        this.trackJob(jobId, peer.id);
        return peer.id;
      } catch { /* not this peer */ }
    }
    throw new Error(`Unknown job "${jobId}".`);
  }

  private async poll(peerId: string, jobId: string, waitSeconds: number, withDiff = false): Promise<any> {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    for (;;) {
      const remaining = deadline - Date.now();
      const waitMs = Math.max(0, Math.min(remaining, 50_000));
      const job = await this.peers.call(peerId, 'jobs.get', { id: jobId, waitMs, withDiff }, waitMs + 15_000);
      if (!['queued', 'running'].includes(job.status) || Date.now() >= deadline) return job;
    }
  }

  formatJob(job: any, p?: RemoteProject, diffLimit?: number): string {
    const where = p ? qualified(p) : job.projectName;
    const L: string[] = [];
    const id = `job \`${job.id}\``;
    switch (job.status) {
      case 'queued':
      case 'running':
        L.push(`⏳ ${job.type} on ${where} is still ${job.status} (${id}). Call \`job_status\` with job_id "${job.id}" to wait for it.`);
        break;
      case 'error':
        L.push(`❌ ${job.type} on ${where} failed (${id}):`, '', job.error || 'unknown error');
        break;
      case 'done':
        if (job.type === 'ask') L.push(job.result || '(empty answer)');
        else L.push(`ℹ️ Change request finished without modifying any files (${id}).`, '', job.result || '');
        break;
      case 'ready':
        L.push(`✅ Change ready for review on ${where} (${id}, branch \`${job.branch}\`).`, '', '### Summary', job.result || '');
        if (job.diffStat) L.push('', '### Files', '```', job.diffStat, '```');
        if (job.tests) L.push('', `### Tests: ${job.tests.ok ? 'passed ✅' : 'FAILED ❌'} (\`${job.tests.command}\`)`, ...(job.tests.ok ? [] : ['```', job.tests.output, '```']));
        if (job.diff) L.push('', '### Diff', '```diff', diffLimit && job.diff.length > diffLimit ? `${job.diff.slice(0, diffLimit)}\n…(truncated)` : job.diff, '```');
        L.push('', `Next: call \`apply\` with job_id "${job.id}" to merge it into the backend's working copy, ` +
          `\`review\` to see the full diff, or \`discard\` to throw it away.`);
        break;
      case 'awaiting-approval':
        L.push(`🕓 Change ${id} is waiting for approval on the host device (${where}). ` +
          `Someone must approve it in the Bridge app there. Call \`job_status\` later to check.`);
        break;
      case 'applied':
        L.push(`✅ Change ${id} is applied to ${where}${job.branch ? ` (merged ${job.branch})` : ''}. If the backend dev server hot-reloads, it's live now.`);
        if (job.type === 'change' && job.result && !job.branch) L.push('', job.result);
        if (job.diffStat && !job.branch) L.push('', '```', job.diffStat, '```');
        if (job.tests && !job.branch) L.push('', `Tests: ${job.tests.ok ? 'passed' : 'FAILED'} (\`${job.tests.command}\`)`);
        break;
      case 'discarded':
        L.push(`🗑️ Change ${id} was discarded.`);
        break;
      case 'rejected':
        L.push(`🚫 Change ${id} was rejected by the host.`);
        break;
      default:
        L.push(`${id}: ${job.status}`);
    }
    return L.join('\n');
  }
}
