// Find projects worth sharing without the user typing paths:
//  1. Folders where Claude Code has been used (~/.claude/projects/*/*.jsonl "cwd" fields)
//  2. Projects under user-configured scan roots (depth 2)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { looksLikeProject } from './profile.js';
import { normPath } from './state.js';

export interface Candidate { path: string; name: string; source: 'claude-history' | 'scan'; lastUsed?: string }

async function firstCwd(file: string): Promise<string | undefined> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (++n > 50) break;
      const m = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse(`"${m[1]}"`);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}

export async function fromClaudeHistory(): Promise<Candidate[]> {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return []; }
  const out = new Map<string, Candidate>();
  for (const d of dirs) {
    const full = path.join(root, d);
    let sessions: { f: string; m: number }[] = [];
    try {
      sessions = fs.readdirSync(full)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: path.join(full, f), m: fs.statSync(path.join(full, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    } catch { continue; }
    for (const s of sessions.slice(0, 3)) {
      const cwd = await firstCwd(s.f).catch(() => undefined);
      if (!cwd || !fs.existsSync(cwd) || !looksLikeProject(cwd)) continue;
      const key = normPath(cwd);
      if (!out.has(key)) {
        out.set(key, { path: cwd, name: path.basename(cwd), source: 'claude-history', lastUsed: new Date(s.m).toISOString() });
      }
      break;
    }
  }
  return [...out.values()].sort((a, b) => (b.lastUsed || '').localeCompare(a.lastUsed || ''));
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next']);

export function scanRoots(roots: string[], depth = 2): Candidate[] {
  const out: Candidate[] = [];
  const walk = (dir: string, d: number) => {
    if (looksLikeProject(dir)) {
      out.push({ path: dir, name: path.basename(dir), source: 'scan' });
      return; // don't descend into a project
    }
    if (d === 0) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(path.join(dir, e.name), d - 1);
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r, depth);
  return out;
}

export async function discover(roots: string[], exclude: string[]): Promise<Candidate[]> {
  const skip = new Set(exclude.map(normPath));
  const seen = new Set<string>();
  const res: Candidate[] = [];
  for (const c of [...(await fromClaudeHistory()), ...scanRoots(roots)]) {
    const k = normPath(c.path);
    if (skip.has(k) || seen.has(k)) continue;
    seen.add(k);
    res.push(c);
  }
  return res;
}
