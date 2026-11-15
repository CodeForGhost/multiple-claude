# Bridge

Use Claude Code on one machine to ask about, and change, a project that lives on another machine.

A typical setup: you build a **mobile app on a Mac mini** while the **backend runs on a laptop**.
With Bridge, Claude on the Mac can:

- **`ask`** the laptop's backend exact questions ("what does `GET /users/:id` return, including nullability?").
  Claude runs on the laptop with read-only access to the whole codebase and answers. Follow-up questions keep context.
- **`change`** the backend ("add `avatarUrl: string | null` to that response"). Claude edits an
  **isolated git worktree and branch** on the laptop, Bridge commits the change and runs the tests, and the Mac gets a summary, the diff and the test results.
- **`apply`** the change (merge it into the laptop's working copy, where the dev server hot-reloads) or **`discard`** it.

None of this needs per-project setup. Install the app on each machine, pair them once, and click **Share** on a project.

```
LAPTOP (Bridge app)                                 MAC MINI (Bridge app)
┌───────────────────────────────┐                   ┌──────────────────────────────────┐
│ tray app + daemon             │   TLS, pinned     │ daemon + MCP server (user scope) │
│ • shared projects, auto-      │◀─────────────────▶│ Claude Code in ANY folder gets:  │
│   profiled (stack/tests/port) │  certs + tokens   │  list_remote_projects  ask       │
│ • runs `claude -p` per job    │  mDNS discovery   │  change  job_status  review      │
│ • git worktree per change     │  or Tailscale     │  apply  discard  status          │
│ • approvals + notifications   │                   │ (folder ↔ project auto-linked)   │
└───────────────────────────────┘                   └──────────────────────────────────┘
```

Every device works both ways: each one can share projects and use the projects others share.

---

## Requirements (each machine)

- **Node.js 20+** (the daemon runs on Node)
- **git**
- **Claude Code CLI**, logged in (`claude` on PATH). The host machine uses it to run jobs, and the client machine needs it to use the tools.
- Both machines on the same LAN, **or** on [Tailscale](https://tailscale.com) (recommended when you're away from home)

## Quick start

1. **Install** Bridge on both machines (build it, see below) and open it. It starts its daemon and sits in the tray or menu bar.
2. **Pair:** on the laptop click **Pair a device**, which shows a 6-digit code. On the Mac click **Join a device**, pick the laptop from the "Found on your network" list (or type its address) and enter the code.
3. **Share:** on the laptop click **Share a folder…** or open **Suggestions**, which lists folders you've already used Claude Code in. Bridge detects the stack, test command, dev port, OpenAPI spec and git remote.
4. **Connect Claude Code:** on the Mac, under Settings, click **Connect Claude Code**. This runs a one-time
   `claude mcp add --scope user bridge …`, so every folder on the Mac gets the Bridge tools.
5. Turn on **Start Bridge at login** on both machines, so the connection is available whenever they're on.

Then, in your mobile project on the Mac:

> *"Check with the backend what the order endpoints return and build the API client. If the order list is missing `thumbnailUrl`, ask the backend to add it."*

Claude calls `ask`, then `change`. It gets back a diff with tests passing and calls `apply`. The laptop's dev server reloads, and Claude carries on with the app.

### Which remote project does a folder use?

Bridge links each local folder to a remote project automatically, checking these in order:

1. A choice made earlier for this folder (remembered once Claude passes `project`)
2. The same **git remote** (for a monorepo or shared repo)
3. The **only** shared project, if there is just one
4. **Name similarity**, ignoring words like *backend/mobile/app/api* (`shop-mobile` → `shop-backend`)
5. Otherwise, the tool lists the candidates and Claude picks one. The choice is remembered.

## Per-project controls (on the host)

| Setting | Options |
|---|---|
| Other devices may | **only ask questions** · **propose changes on a branch** (default for git repos) · **edit files directly** |
| Changes are applied | **by the requesting device** (via `apply`) · **only after I approve here** (approve/reject in the app, with a notification) |
| Tests / dev port | Detected automatically; editable |

In branch mode a change never touches your working copy until it's applied. `node_modules`, `.venv`, `vendor` and `.env*`
are linked or copied into the worktree so tests can run, and they're removed safely afterwards, without following the links.

## Security model

- **Pairing:** a 6-digit code that is valid for 5 minutes and allows 5 attempts. Pairing exchanges each device's self-signed TLS certificate and a random 256-bit token in each direction. After that, every connection is **TLS with the peer's certificate pinned**, plus a bearer token. Both UIs show a short **Device ID** (certificate fingerprint) that you can compare. The pairing exchange is trust-on-first-use: pair on a network you trust, or over Tailscale.
- **Local control API** (`127.0.0.1` only) requires the token in `~/.bridge/local-token` (file mode 600).
- **What remote Claude can do:** asks use only `Read/Grep/Glob/LS`. Changes add `Edit/Write` plus `Bash(<the project's test command>:*)`, and only inside the worktree. Bridge itself does the git operations.
- State lives in `~/.bridge/` (config, pinned peers, projects, job history, TLS key, log).

## CLI

The daemon bundle is also a CLI (`node packages/bridge/dist/bridge.cjs …`, or `bridge …` after `npm link`):

```
bridge status                     bridge pair / bridge join <host[:port]> <code>
bridge share [path]               bridge suggest
bridge set <project> permission branch|read|direct
bridge set <project> apply peer|host
bridge ask "<question>"           bridge change "<request>"
bridge review <job> / apply <job> / discard <job> / approve <job> / reject <job>
bridge install-mcp                bridge daemon / bridge mcp
```

This means a headless machine (a server or an SSH box) can share projects without the desktop app: run `bridge daemon` under your service manager.

## Building

```bash
npm run setup          # install deps for daemon + app
npm test               # build daemon, run unit + end-to-end tests (two real daemons, mock engine)
npm run app:dev        # run the desktop app in dev mode
npm run app:build      # produce installers (.msi/.exe on Windows, .dmg/.app on macOS)
```

Build the macOS app **on the Mac** (`npm run setup && npm run app:build`) and the Windows app on Windows.

Useful environment variables (mostly for development and testing):

| Variable | Purpose |
|---|---|
| `BRIDGE_HOME` | State directory (default `~/.bridge`) |
| `BRIDGE_HOST_PORT` / `BRIDGE_LOCAL_PORT` | Peer port (default 47600) and localhost API port (default 47601) |
| `BRIDGE_NAME` | Device name override |
| `BRIDGE_ENGINE=mock` | Fake engine for tests; never calls Claude |
| `BRIDGE_NO_MDNS=1` | Disable LAN discovery |
| `BRIDGE_CLAUDE_BIN`, `BRIDGE_NODE`, `BRIDGE_SCRIPT` | Override binary/script locations |
| `BRIDGE_ASK_TIMEOUT_MS`, `BRIDGE_CHANGE_TIMEOUT_MS`, `BRIDGE_TEST_TIMEOUT_MS` | Job timeouts |

## Layout

```
packages/bridge/        daemon, CLI and MCP server (TypeScript → one bundled dist/bridge.cjs)
  src/daemon.ts         wiring + localhost control API (UI/CLI/MCP)
  src/host.ts           peer-facing HTTPS/WebSocket server: pairing + project/job RPC
  src/peers.ts          pinned-TLS client connections to peers, auto-reconnect
  src/mdns.ts           LAN discovery (_bridge._tcp)
  src/jobs.ts           ask/change jobs, worktrees, tests, apply/discard/approve
  src/engine.ts         runs `claude -p` headless (or the mock engine)
  src/profile.ts        zero-config project detection
  src/discover.ts       share suggestions from Claude Code history + scan roots
  src/tools.ts          folder→project linking and tool logic for the MCP server
  src/mcp.ts            stdio MCP server (registered once, user scope)
  test/                 unit + end-to-end tests
app/                    Tauri 2 desktop shell
  src-tauri/src/lib.rs  daemon supervisor, tray, autostart, notifications, folder picker
  ui/                   the app UI (plain HTML/CSS/JS)
```

## Notes and limits

- The backend's dev server must listen on `0.0.0.0` (not `localhost`) for the Mac app or simulator to reach it. The `status` tool prints the likely URL.
- Jobs for the same project run one at a time. A job interrupted by a restart is marked as failed.
- If a merge conflicts on `apply` (for example, you edited the same lines meanwhile), Bridge aborts the merge and keeps the branch, so you can resolve it by hand.
- Jobs use the host's Claude Code login and count toward that account's usage.
