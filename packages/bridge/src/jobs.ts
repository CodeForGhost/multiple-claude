// Host side: runs ask/change jobs for paired peers against shared projects.
//  - ask:    read-only Claude session per (project, peer), resumed for follow-ups
//  - change: isolated git worktree + branch, Claude edits, Bridge commits, runs tests,
//            returns diff; apply merges into the project, discard throws it away.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Engine } from './engine.js';
import { git, gitOk, runShell, tail, head } from './proc.js';
import { State, Job, Project, Peer, files, ensureDir, randomId, now } from './state.js';

const ASK_TIMEOUT = Number(process.env.BRIDGE_ASK_TIMEOUT_MS || 10 * 60_000);
const CHANGE_TIMEOUT = Number(process.env.BRIDGE_CHANGE_TIMEOUT_MS || 30 * 60_000);
const TEST_TIMEOUT = Number(process.env.BRIDGE_TEST_TIMEOUT_MS || 10 * 60_000);

/** Dependency folders/files made available inside a worktree so tests can run. */
const LINK_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];
const ENV_FILE = /^\.env(\..+)?$/;

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'];

const ASK_SYSTEM = `You are the resident expert on this codebase, answering questions from a developer
on another machine who is building a client (often a mobile or web app) against it.
Be precise and concrete: exact endpoint paths, methods, request/response field names and types,
status codes, auth requirements, and file:line references. Prefer reading the code over guessing.
Do not modify any files.`;

const CHANGE_SYSTEM = `You are making a change to this codebase requested by a developer on another machine
who is building a client against it. Rules:
- Make the smallest change that fully satisfies the request; follow existing conventions.
- Update related types, serializers/DTOs, validation, docs (e.g. OpenAPI) and tests.
- If a test command is available, run it and fix failures you caused.
- Do NOT run git commands or commit; Bridge commits for you.
- Finish with a short summary of what changed and anything the client developer must know
  (new/changed fields, types, nullability, migrations).`;

export class JobRunner extends EventEmitter {
  private chains = new Map<string, Promise<void>>();
  private waiters = new Map<string, Set<() => void>>();

  constructor(private state: State, private engine: Engine) {
    super();
  }

  private touch(job: Job, patch: Partial<Job>) {
    Object.assign(job, patch, { updatedAt: now() });
    this.state.saveJobs();
    this.emit('job', job);
    if (!['queued', 'running'].includes(job.status)) {
      for (const w of this.waiters.get(job.id) || []) w();
      this.waiters.delete(job.id);
    }
  }

  get(id: string): Job | undefined {
    return this.state.jobs.find((j) => j.id === id);
  }

  /** Wait until the job leaves queued/running or the timeout elapses. */
  wait(id: string, ms: number): Promise<Job | undefined> {
    const job = this.get(id);
    if (!job || !['queued', 'running'].includes(job.status) || ms <= 0) return Promise.resolve(job);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(this.get(id)); };
      const t = setTimeout(() => { this.waiters.get(id)?.delete(done); resolve(this.get(id)); }, ms);
      if (!this.waiters.has(id)) this.waiters.set(id, new Set());
      this.waiters.get(id)!.add(done);
    });
  }

  start(peer: Peer, projectId: string, type: 'ask' | 'change', input: string, opts: { fresh?: boolean } = {}): Job {
    const project = this.state.project(projectId);
    if (!project) throw new Error(`Unknown project "${projectId}".`);
    if (type === 'change' && project.permission === 'read') {
      throw new Error(`Project "${project.name}" is shared read-only. Ask the host to allow changes in the Bridge app.`);
    }
    if (!input.trim()) throw new Error('Empty request.');
    const job: Job = {
      id: randomId(6),
      type,
      projectId: project.id,
      projectName: project.name,
      peerId: peer.id,
      peerName: peer.name,
      input,
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.jobs.push(job);
    this.state.saveJobs();
    this.emit('job', job);
    // Serialise jobs per project so sessions and the working copy aren't raced.
    const prev = this.chains.get(project.id) || Promise.resolve();
    const next = prev
      .then(() => (type === 'ask' ? this.runAsk(job, project, peer, opts.fresh) : this.runChange(job, project)))
      .catch((e) => this.touch(job, { status: 'error', error: String(e?.message || e) }));
    this.chains.set(project.id, next);
    return job;
  }

  // ---------- ask ----------
  private async runAsk(job: Job, project: Project, peer: Peer, fresh?: boolean) {
    this.touch(job, { status: 'running' });
    const resume = fresh ? undefined : project.askSessions[peer.id];
    let r = await this.engine.run({
      cwd: project.path,
      prompt: job.input,
      allowedTools: READ_TOOLS,
      resume,
      timeoutMs: ASK_TIMEOUT,
      appendSystemPrompt: ASK_SYSTEM,
    });
    if (r.isError && resume) {
      // Session may have expired or been deleted; retry fresh.
      r = await this.engine.run({ cwd: project.path, prompt: job.input, allowedTools: READ_TOOLS, timeoutMs: ASK_TIMEOUT, appendSystemPrompt: ASK_SYSTEM });
    }
    if (r.sessionId) {
      project.askSessions[peer.id] = r.sessionId;
      this.state.saveProjects();
    }
    this.touch(job, r.isError
      ? { status: 'error', error: r.text, costUsd: r.costUsd }
      : { status: 'done', result: r.text, costUsd: r.costUsd });
  }

  // ---------- change ----------
  private async runChange(job: Job, project: Project) {
    this.touch(job, { status: 'running' });
    if (project.permission === 'direct') return this.runDirectChange(job, project);
    if (!project.profile.git.isRepo) {
      throw new Error(`"${project.name}" is not a git repository, so changes can't be isolated on a branch. ` +
        `Initialise git, or set the project's permission to "direct" in the Bridge app.`);
    }

    const base = await gitOk(project.path, ['rev-parse', 'HEAD']);
    const branch = `bridge/${job.id}`;
    const wt = path.join(ensureDir(path.join(files.worktrees, project.id)), job.id);
    await gitOk(project.path, ['worktree', 'add', '-b', branch, wt, base]);
    const linked = linkDependencies(project.path, wt);
    this.touch(job, { branch, worktree: wt, baseCommit: base, linked });

    const r = await this.engine.run({
      cwd: wt,
      prompt: changePrompt(project, job.input),
      allowedTools: changeTools(project),
      permissionMode: 'acceptEdits',
      timeoutMs: CHANGE_TIMEOUT,
      appendSystemPrompt: CHANGE_SYSTEM,
    });
    if (r.isError) {
      await this.cleanup(job, project, true);
      this.touch(job, { status: 'error', error: r.text, costUsd: r.costUsd });
      return;
    }

    // Commit everything Claude changed, excluding linked dependency folders/env files.
    // (Excluding a path git already ignores is an error, so only exclude the non-ignored ones.)
    const exclude: string[] = [];
    for (const l of linked) {
      if ((await git(wt, ['check-ignore', '-q', l])).code !== 0) exclude.push(`:(exclude)${l}`);
    }
    await gitOk(wt, ['add', '-A', '--', '.', ...exclude]);
    const staged = await git(wt, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      await this.cleanup(job, project, true);
      this.touch(job, { status: 'done', result: r.text, costUsd: r.costUsd, diffStat: '(no file changes)' });
      return;
    }
    await commit(wt, `bridge: ${job.input.split('\n')[0].slice(0, 72)}\n\nRequested by ${job.peerName} via Bridge (job ${job.id}).`);
    const diffStat = await gitOk(wt, ['diff', '--stat', `${base}..HEAD`]);
    const diff = (await git(wt, ['diff', `${base}..HEAD`])).stdout;
    const tests = project.profile.testCommand ? await runTests(project.profile.testCommand, wt) : undefined;
    this.touch(job, {
      status: 'ready',
      result: r.text,
      costUsd: r.costUsd,
      diffStat,
      diff: head(diff, 200_000),
      tests,
    });
  }

  private async runDirectChange(job: Job, project: Project) {
    const before = project.profile.git.isRepo ? (await git(project.path, ['diff', '--stat'])).stdout : '';
    const r = await this.engine.run({
      cwd: project.path,
      prompt: changePrompt(project, job.input),
      allowedTools: changeTools(project),
      permissionMode: 'acceptEdits',
      timeoutMs: CHANGE_TIMEOUT,
      appendSystemPrompt: CHANGE_SYSTEM,
    });
    if (r.isError) {
      this.touch(job, { status: 'error', error: r.text, costUsd: r.costUsd });
      return;
    }
    let diff = '';
    let diffStat = '(direct mode, not a git repo: no diff available)';
    if (project.profile.git.isRepo) {
      diff = (await git(project.path, ['diff'])).stdout;
      diffStat = (await git(project.path, ['diff', '--stat'])).stdout.trim() || '(no file changes)';
      if (before.trim()) diffStat += '\n(note: the working copy already had uncommitted changes before this job)';
    }
    const tests = project.profile.testCommand ? await runTests(project.profile.testCommand, project.path) : undefined;
    this.touch(job, { status: 'applied', result: r.text, costUsd: r.costUsd, diff: head(diff, 200_000), diffStat, tests });
  }

  // ---------- apply / discard / approve ----------
  async apply(id: string, by: 'peer' | 'host', peerId?: string): Promise<Job> {
    const job = this.mustGet(id, peerId);
    const project = this.state.project(job.projectId);
    if (!project) throw new Error('Project is no longer shared.');
    if (job.status === 'awaiting-approval' && by === 'peer') return job;
    if (!['ready', 'awaiting-approval'].includes(job.status)) {
      throw new Error(`Job ${id} is "${job.status}"; only ready changes can be applied.`);
    }
    if (by === 'peer' && project.applyPolicy === 'host') {
      this.touch(job, { status: 'awaiting-approval' });
      this.emit('approval-needed', job);
      return job;
    }
    // Merge into whatever branch the project currently has checked out.
    const r = await git(project.path, ['merge', '--no-edit', job.branch!]);
    if (r.code !== 0) {
      await git(project.path, ['merge', '--abort']);
      throw new Error(`Could not merge ${job.branch} into the project's working copy ` +
        `(uncommitted changes or conflicts?). Details:\n${(r.stderr || r.stdout).trim()}\n` +
        `The change is still available on branch ${job.branch}.`);
    }
    await this.cleanup(job, project, false);
    this.touch(job, { status: 'applied' });
    return job;
  }

  async discard(id: string, peerId?: string): Promise<Job> {
    const job = this.mustGet(id, peerId);
    if (!['ready', 'awaiting-approval'].includes(job.status)) {
      throw new Error(`Job ${id} is "${job.status}" and can't be discarded.`);
    }
    const project = this.state.project(job.projectId);
    if (project) await this.cleanup(job, project, true);
    this.touch(job, { status: 'discarded' });
    return job;
  }

  async reject(id: string): Promise<Job> {
    const job = this.mustGet(id);
    if (job.status !== 'awaiting-approval') throw new Error(`Job ${id} is not awaiting approval.`);
    const project = this.state.project(job.projectId);
    if (project) await this.cleanup(job, project, true);
    this.touch(job, { status: 'rejected' });
    return job;
  }

  private mustGet(id: string, peerId?: string): Job {
    const job = this.get(id);
    if (!job || (peerId && job.peerId !== peerId)) throw new Error(`Unknown job "${id}".`);
    return job;
  }

  /** Remove the worktree (unlinking shared dependency folders first) and the branch. */
  private async cleanup(job: Job, project: Project, deleteBranch: boolean) {
    if (job.worktree) {
      unlinkDependencies(job.worktree, job.linked || []);
      await git(project.path, ['worktree', 'remove', '--force', job.worktree]);
      fs.rmSync(job.worktree, { recursive: true, force: true });
      await git(project.path, ['worktree', 'prune']);
    }
    if (job.branch) await git(project.path, ['branch', deleteBranch ? '-D' : '-d', job.branch]);
    job.worktree = undefined;
  }
}

function changeTools(project: Project): string[] {
  const tools = [...READ_TOOLS, ...EDIT_TOOLS];
  if (project.profile.testCommand) tools.push(`Bash(${project.profile.testCommand}:*)`);
  return tools;
}

function changePrompt(project: Project, request: string): string {
  const p = project.profile;
  const ctx = [
    `Project: ${p.name} (${[...p.stacks, ...p.frameworks].join(', ') || 'unknown stack'})`,
    p.testCommand ? `Test command: ${p.testCommand}` : 'No test command detected.',
    p.apiSpec ? `API spec file: ${p.apiSpec} (keep it in sync).` : '',
  ].filter(Boolean).join('\n');
  return `${ctx}\n\nRequest:\n${request}`;
}

async function commit(cwd: string, message: string) {
  const email = await git(cwd, ['config', 'user.email']);
  const identity = email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.name=Bridge', '-c', 'user.email=bridge@localhost'];
  await gitOk(cwd, [...identity, 'commit', '--no-verify', '-q', '-m', message]);
}

async function runTests(command: string, cwd: string) {
  const r = await runShell(command, cwd, TEST_TIMEOUT);
  return {
    command,
    ok: r.code === 0 && !r.timedOut,
    exitCode: r.code,
    output: tail(`${r.stdout}\n${r.stderr}`.trim(), 6000) + (r.timedOut ? '\n(test run timed out)' : ''),
  };
}

/** Make dependency folders and untracked .env files from the project available in the worktree. */
function linkDependencies(projectDir: string, wt: string): string[] {
  const linked: string[] = [];
  for (const d of LINK_DIRS) {
    const src = path.join(projectDir, d);
    const dst = path.join(wt, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.symlinkSync(src, dst, 'junction');
        linked.push(d);
      } catch { /* tests may fail without deps; not fatal */ }
    }
  }
  try {
    for (const f of fs.readdirSync(projectDir)) {
      if (ENV_FILE.test(f) && !fs.existsSync(path.join(wt, f))) {
        fs.copyFileSync(path.join(projectDir, f), path.join(wt, f));
        linked.push(f);
      }
    }
  } catch { /* ignore */ }
  return linked;
}

/** Remove links without following them, so the project's real folders are never deleted. */
function unlinkDependencies(wt: string, linked: string[]) {
  for (const l of linked) {
    const p = path.join(wt, l);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) fs.unlinkSync(p);
      else if (st.isFile()) fs.unlinkSync(p);
      // A real directory here would be unexpected; leave it for `worktree remove`.
    } catch { /* already gone */ }
  }
}
