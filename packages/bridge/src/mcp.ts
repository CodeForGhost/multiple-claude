// stdio MCP server registered once with Claude Code (user scope). Every project on this
// machine gets tools to talk to projects shared by paired devices.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api, ensureDaemon } from './client.js';
import { VERSION } from './version.js';

const cwd = () => process.env.CLAUDE_PROJECT_DIR || process.cwd();

const projectArg = z.string().optional().describe(
  'Remote project, as "name" or "device/name". Omit to use the project linked to the current folder ' +
  '(auto-detected by git remote, earlier choice, or name). Passing it once remembers the choice for this folder.');

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], isError };
}

async function call(path: string, body: any) {
  try {
    await ensureDaemon();
    return text(await api<string>('POST', `/api/tools/${path}`, body));
  } catch (e: any) {
    return text(String(e?.message || e), true);
  }
}

export async function startMcp() {
  const server = new McpServer(
    { name: 'bridge', version: VERSION },
    {
      instructions:
        'Bridge connects this machine to projects shared from your other machines (for example a backend running on a laptop). ' +
        'Use `ask` instead of guessing about the remote project\'s API: endpoints, fields, types, auth, errors. ' +
        'Use `change` when the client you are building needs the remote project to change (e.g. add a field to a response); ' +
        'it runs Claude on the remote machine in an isolated branch and returns a diff and test results. ' +
        'Then `apply` to merge it (or `discard`). Use `status` to check the remote dev server and branch.',
    },
  );

  server.registerTool('list_remote_projects', {
    title: 'List remote projects',
    description: 'List paired devices, whether they are online, and the projects they share (stack, test command, dev port, permission). Also shows which remote project the current folder is linked to.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => call('list_remote_projects', { cwd: cwd() }));

  server.registerTool('ask', {
    title: 'Ask the remote project',
    description: 'Ask a question about a project on another machine. Claude runs there with read-only access to the full codebase and answers with exact endpoint paths, field names/types, status codes and file references. Follow-up questions keep context.',
    inputSchema: {
      question: z.string().describe('The question, with enough context (e.g. "What is the exact JSON response of GET /users/:id, including nullability?")'),
      project: projectArg,
      fresh: z.boolean().optional().describe('Start a new conversation instead of continuing the previous one.'),
      wait_seconds: z.number().int().min(0).max(1800).optional().describe('How long to wait for the answer before returning a job id (default 240).'),
    },
    annotations: { readOnlyHint: true },
  }, (a) => call('ask', { cwd: cwd(), question: a.question, project: a.project, fresh: a.fresh, waitSeconds: a.wait_seconds ?? 240 }));

  server.registerTool('change', {
    title: 'Request a change in the remote project',
    description: 'Ask the remote machine to change its project (e.g. "add avatarUrl (string|null) to the GET /users/:id response"). ' +
      'Claude edits an isolated git branch there, Bridge commits and runs the tests, and you get a summary, diff and test results. ' +
      'Nothing touches the remote working copy until you call apply.',
    inputSchema: {
      request: z.string().describe('What to change and why, including exact field names, types and nullability the client expects.'),
      project: projectArg,
      wait_seconds: z.number().int().min(0).max(1800).optional().describe('How long to wait before returning a job id (default 240).'),
    },
  }, (a) => call('change', { cwd: cwd(), request: a.request, project: a.project, waitSeconds: a.wait_seconds ?? 240 }));

  server.registerTool('job_status', {
    title: 'Check a job',
    description: 'Wait for / check a running ask or change job by id.',
    inputSchema: {
      job_id: z.string(),
      wait_seconds: z.number().int().min(0).max(1800).optional().describe('How long to wait for completion (default 120).'),
    },
    annotations: { readOnlyHint: true },
  }, (a) => call('job_status', { jobId: a.job_id, waitSeconds: a.wait_seconds ?? 120 }));

  server.registerTool('review', {
    title: 'Review a change',
    description: 'Show the full diff, summary and test output of a change job.',
    inputSchema: { job_id: z.string() },
    annotations: { readOnlyHint: true },
  }, (a) => call('review', { jobId: a.job_id }));

  server.registerTool('apply', {
    title: 'Apply a change',
    description: 'Merge a ready change into the remote project\'s working copy (its dev server will typically hot-reload). The host may require manual approval.',
    inputSchema: { job_id: z.string() },
    annotations: { destructiveHint: false },
  }, (a) => call('apply', { jobId: a.job_id }));

  server.registerTool('discard', {
    title: 'Discard a change',
    description: 'Throw away a change job that has not been applied (deletes its branch and worktree on the remote machine).',
    inputSchema: { job_id: z.string() },
    annotations: { destructiveHint: true },
  }, (a) => call('discard', { jobId: a.job_id }));

  server.registerTool('status', {
    title: 'Remote project status',
    description: 'Show the remote project\'s current branch, uncommitted files, whether its dev server is running, the likely API URL from this machine, and recent jobs.',
    inputSchema: { project: projectArg },
    annotations: { readOnlyHint: true },
  }, (a) => call('status', { cwd: cwd(), project: a.project }));

  await server.connect(new StdioServerTransport());
}
