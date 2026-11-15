// bridge CLI entry point.
import path from 'node:path';
import { api, ensureDaemon } from './client.js';
import { VERSION } from './version.js';

const USAGE = `Bridge ${VERSION} - share projects with Claude Code on your other machines

Usage: bridge <command> [args]

  daemon                         Run the Bridge daemon in the foreground
  mcp                            Run the MCP server (stdio) - used by Claude Code
  install-mcp                    Register Bridge with Claude Code (user scope, once per machine)
  status                         Show device, peers, shared projects and recent jobs
  share [path]                   Share a project folder (default: current folder)
  unshare <project>              Stop sharing a project
  suggest                        List projects found on this machine that you could share
  set <project> <key> <value>    key: permission (read|branch|direct), apply (peer|host), test, port, name
  pair                           Show a pairing code for another device to enter
  join <host[:port]> <code>      Pair with a device showing a pairing code
  unpair <device-id>             Remove a paired device
  ask [--project p] <question>   Ask a remote project a question (from the current folder)
  change [--project p] <request> Request a change in a remote project
  job <id> | review <id> | apply <id> | discard <id>
  approve <id> | reject <id>     Approve/reject a change waiting for approval on this host
`;

function out(x: any) {
  console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
}

function takeProject(args: string[]): { project?: string; rest: string } {
  const i = args.indexOf('--project');
  let project: string | undefined;
  if (i >= 0) { project = args[i + 1]; args.splice(i, 2); }
  return { project, rest: args.join(' ') };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'daemon': {
      const { startDaemon } = await import('./daemon.js');
      await startDaemon();
      return;
    }
    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      await startMcp();
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out(USAGE);
      return;
    case '--version':
    case 'version':
      out(VERSION);
      return;
  }

  await ensureDaemon();
  const cwd = process.cwd();
  switch (cmd) {
    case 'install-mcp':
      out(await api('POST', '/api/mcp/install'));
      out('Done. Claude Code in any folder on this machine now has the Bridge tools (restart open sessions).');
      break;
    case 'status': {
      const s = await api('GET', '/api/state');
      out(`${s.device.name} (${s.device.id}) · fingerprint ${s.device.shortFingerprint} · port ${s.device.hostPort} · engine ${s.engine}`);
      out('\nPeers:');
      for (const p of s.peers) out(`  ${p.online ? '🟢' : '⚪'} ${p.name} (${p.id}) ${p.address || ''} fp ${p.shortFingerprint}`);
      if (!s.peers.length) out('  (none - run "bridge pair" here and "bridge join" on the other device)');
      out('\nShared projects:');
      for (const p of s.projects) out(`  ${p.name} [${p.permission}/${p.applyPolicy}] ${p.path}  test: ${p.testCommand || '-'}`);
      if (!s.projects.length) out('  (none - run "bridge share" in a project folder)');
      if (s.pairing) out(`\nPairing code active: ${s.pairing.code}`);
      out('\nRecent jobs:');
      for (const j of s.jobs.slice(0, 10)) out(`  ${j.id} ${j.type} ${j.status} ${j.peerName} → ${j.projectName}: ${j.input.split('\n')[0].slice(0, 60)}`);
      break;
    }
    case 'share': {
      const p = await api('POST', '/api/projects', { path: path.resolve(args[0] || cwd) });
      out(`Shared "${p.name}" [${p.permission}] stack: ${[...p.stacks, ...p.frameworks].join(', ') || 'unknown'}; tests: ${p.testCommand || 'none detected'}`);
      break;
    }
    case 'unshare': {
      const s = await api('GET', '/api/state');
      const p = s.projects.find((x: any) => x.id === args[0] || x.name === args[0]);
      if (!p) throw new Error(`No shared project "${args[0]}"`);
      await api('DELETE', `/api/projects/${p.id}`);
      out(`Stopped sharing ${p.name}.`);
      break;
    }
    case 'suggest': {
      const c = await api('GET', '/api/candidates');
      if (!c.length) out('No candidates found. Add scan roots in the app settings, or run "bridge share <path>".');
      for (const x of c) out(`  ${x.name.padEnd(28)} ${x.path}  (${x.source})`);
      break;
    }
    case 'set': {
      const [ref, key, ...v] = args;
      const value = v.join(' ');
      const s = await api('GET', '/api/state');
      const p = s.projects.find((x: any) => x.id === ref || x.name === ref);
      if (!p) throw new Error(`No shared project "${ref}"`);
      const map: Record<string, string> = { permission: 'permission', apply: 'applyPolicy', test: 'testCommand', port: 'devPort', name: 'name' };
      if (!map[key]) throw new Error('key must be one of: permission, apply, test, port, name');
      out(await api('PATCH', `/api/projects/${p.id}`, { [map[key]]: value }));
      break;
    }
    case 'pair': {
      const r = await api('POST', '/api/pair/start');
      const s = await api('GET', '/api/state');
      out(`Pairing code: ${r.code}  (valid 5 minutes)\nOn the other device run:  bridge join <this-machine-address>:${r.port} ${r.code}\nThis device's fingerprint: ${s.device.shortFingerprint}`);
      break;
    }
    case 'join': {
      if (args.length < 2) throw new Error('usage: bridge join <host[:port]> <code>');
      const r = await api('POST', '/api/pair/join', { host: args[0], code: args[1] });
      out(`Paired with ${r.name}.`);
      break;
    }
    case 'unpair':
      await api('DELETE', `/api/peers/${args[0]}`);
      out('Removed.');
      break;
    case 'ask': {
      const { project, rest } = takeProject(args);
      out(await api('POST', '/api/tools/ask', { cwd, project, question: rest, waitSeconds: 900 }));
      break;
    }
    case 'change': {
      const { project, rest } = takeProject(args);
      out(await api('POST', '/api/tools/change', { cwd, project, request: rest, waitSeconds: 1800 }));
      break;
    }
    case 'job':
      out(await api('POST', '/api/tools/job_status', { jobId: args[0], waitSeconds: 600 }));
      break;
    case 'review':
      out(await api('POST', '/api/tools/review', { jobId: args[0] }));
      break;
    case 'apply':
      out(await api('POST', '/api/tools/apply', { jobId: args[0] }));
      break;
    case 'discard':
      out(await api('POST', '/api/tools/discard', { jobId: args[0] }));
      break;
    case 'approve':
      out(await api('POST', `/api/jobs/${args[0]}/approve`));
      break;
    case 'reject':
      out(await api('POST', `/api/jobs/${args[0]}/reject`));
      break;
    default:
      out(USAGE);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`bridge: ${e?.message || e}`);
  process.exit(1);
});
