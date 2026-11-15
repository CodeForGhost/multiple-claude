// Small cross-platform process helpers.
import { spawn, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run through the platform shell (needed for user-supplied command lines). */
  shell?: boolean;
  maxOutput?: number;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const max = opts.maxOutput ?? 4 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    };
    let child;
    try {
      child = spawn(cmd, args, spawnOpts);
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d) => { if (stdout.length < max) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < max) stderr += d; });
    child.on('error', (e) => { stderr += String(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function killTree(pid?: number) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Run a user-defined command line (e.g. "npm test") through the shell. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return run(command, [], { cwd, shell: true, timeoutMs });
}

export async function git(cwd: string, args: string[], input?: string): Promise<RunResult> {
  return run('git', args, { cwd, input });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Locate an executable on PATH (handles Windows PATHEXT). */
export function which(name: string): string | undefined {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  // Common install locations that are often missing from a GUI app's PATH.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  dirs.push(
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  );
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch { /* next */ }
    }
  }
  return undefined;
}

/** Quote an argument for cmd.exe when we must go through the shell (.cmd shims). */
export function quoteWin(arg: string): string {
  if (/^[\w.,:\-/\\=]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Run an executable found via `which`. Windows .cmd/.bat shims can't be spawned directly,
 * so those go through cmd.exe as one quoted command line.
 */
export function runBin(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    return run([quoteWin(bin), ...args.map(quoteWin)].join(' '), [], { ...opts, shell: true });
  }
  return run(bin, args, { ...opts, shell: false });
}

export function tail(s: string, n: number): string {
  return s.length > n ? `…(truncated)\n${s.slice(-n)}` : s;
}

export function head(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…(truncated, ${s.length - n} more chars)` : s;
}
