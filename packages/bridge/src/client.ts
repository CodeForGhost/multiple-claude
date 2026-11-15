// Talks to the local daemon's control API; starts the daemon in the background if needed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DEFAULT_LOCAL_PORT, files, localToken, readJson, ensureDir, HOME } from './state.js';

function localPort(): number {
  const cfg = readJson<{ localPort?: number }>(files.config, {});
  return Number(process.env.BRIDGE_LOCAL_PORT || cfg.localPort || DEFAULT_LOCAL_PORT);
}

const base = () => `http://127.0.0.1:${localPort()}`;

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.json()).app === 'bridge';
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  ensureDir(HOME);
  const out = fs.openSync(files.log, 'a');
  const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await healthy()) return;
  }
  throw new Error(`Bridge daemon did not start. See ${files.log}`);
}

export async function api<T = any>(method: string, path: string, body?: any, timeoutMs = 15 * 60_000): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-bridge-token': localToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data as T;
}
