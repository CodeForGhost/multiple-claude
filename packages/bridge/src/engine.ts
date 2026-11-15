// Runs Claude Code headless (`claude -p`) inside a project directory.
// BRIDGE_ENGINE=mock swaps in a deterministic fake for tests.
import fs from 'node:fs';
import path from 'node:path';
import { runBin, which } from './proc.js';

export interface EngineRequest {
  cwd: string;
  prompt: string;
  allowedTools: string[];
  permissionMode?: 'default' | 'acceptEdits';
  resume?: string;
  timeoutMs: number;
  appendSystemPrompt?: string;
}

export interface EngineResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
  isError: boolean;
}

export interface Engine {
  name: string;
  run(req: EngineRequest): Promise<EngineResult>;
}

export class ClaudeCliEngine implements Engine {
  name = 'claude-cli';

  async run(req: EngineRequest): Promise<EngineResult> {
    const bin = process.env.BRIDGE_CLAUDE_BIN || which('claude');
    if (!bin) {
      return { text: 'Claude Code CLI (`claude`) was not found on this machine. Install it and log in.', isError: true };
    }
    const args = ['-p', '--output-format', 'json'];
    if (req.allowedTools.length) args.push('--allowedTools', ...req.allowedTools);
    if (req.permissionMode && req.permissionMode !== 'default') args.push('--permission-mode', req.permissionMode);
    if (req.resume) args.push('--resume', req.resume);
    if (req.appendSystemPrompt) args.push('--append-system-prompt', req.appendSystemPrompt);

    const env = { ...process.env };
    delete env.CLAUDECODE; // allow running when the daemon was started from inside Claude Code
    const r = await runBin(bin, args, { cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, env });

    if (r.timedOut) return { text: `Claude timed out after ${Math.round(req.timeoutMs / 1000)}s.`, isError: true };
    const parsed = parseJsonOutput(r.stdout);
    if (!parsed) {
      return { text: `Claude exited with code ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`, isError: true };
    }
    return {
      text: String(parsed.result ?? ''),
      sessionId: parsed.session_id,
      costUsd: parsed.total_cost_usd,
      isError: Boolean(parsed.is_error) || r.code !== 0,
    };
  }
}

function parseJsonOutput(out: string): any {
  const t = out.trim();
  if (!t) return undefined;
  try { return JSON.parse(t); } catch { /* maybe log lines before the JSON */ }
  const last = t.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (last) { try { return JSON.parse(last); } catch { /* give up */ } }
  return undefined;
}

/** Deterministic engine for tests: answers echo the prompt; edits write BRIDGE_MOCK.md. */
export class MockEngine implements Engine {
  name = 'mock';
  private n = 0;

  async run(req: EngineRequest): Promise<EngineResult> {
    const sessionId = req.resume || `mock-session-${++this.n}`;
    const question = req.prompt.split('\n').filter(Boolean).pop() || '';
    if (req.allowedTools.includes('Edit')) {
      fs.appendFileSync(path.join(req.cwd, 'BRIDGE_MOCK.md'), `- ${question}\n`);
      return { text: `Mock change applied: ${question}`, sessionId, isError: false, costUsd: 0 };
    }
    return { text: `Mock answer (session ${sessionId}${req.resume ? ', resumed' : ''}): ${question}`, sessionId, isError: false, costUsd: 0 };
  }
}

export function createEngine(): Engine {
  return process.env.BRIDGE_ENGINE === 'mock' ? new MockEngine() : new ClaudeCliEngine();
}
