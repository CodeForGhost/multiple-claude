# Setting up Bridge on the Mac mini

This guide is for the setup Bridge was built for:

- **Laptop (Windows):** runs the backend and shares it through Bridge.
- **Mac mini:** where you build the mobile app. Claude Code there uses the backend through Bridge.

Total time: about 20 minutes, most of it the first build.

---

## 1. Install prerequisites (once)

Open Terminal on the Mac:

```bash
xcode-select --install                       # git + compilers (skip if already installed)
brew install node                            # Node 20+  (or the installer from nodejs.org)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust, only needed for the desktop app
npm install -g @anthropic-ai/claude-code     # skip if Claude Code is already installed
claude                                       # log in once, then exit
```

Check:

```bash
node -v      # v20 or newer
git --version
claude --version
```

## 2. Get the code

```bash
git clone <your-repo-url> multiple-claude
cd multiple-claude
npm run setup        # installs dependencies for the daemon and the app
npm test             # optional: 17 tests in about 15 seconds; all should pass
```

## 3. Choose the app or the CLI

The Mac only *uses* the laptop's projects, so either option works.

### Option A: desktop app (recommended)

Gives you a menu-bar icon, notifications, start at login and a UI.

```bash
npm run app:build    # a few minutes the first time
open app/src-tauri/target/release/bundle/dmg/
```

1. Open the `Bridge_0.1.0_*.dmg` and drag **Bridge** into **Applications**.
2. **First launch:** the app isn't code-signed, so macOS blocks it.
   Right-click **Bridge** in Applications, choose **Open**, then **Open** again.
   If macOS still refuses:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Bridge.app
   ```
3. When macOS asks, **allow incoming network connections** and **allow notifications**.

### Option B: CLI only (no Rust or app build)

```bash
npm run build:daemon
alias bridge="node $PWD/packages/bridge/dist/bridge.cjs"   # add to ~/.zshrc to keep it
bridge status        # starts the daemon in the background
```

The daemon also starts automatically the first time Claude uses a Bridge tool.

## 4. Prepare the laptop (Windows)

1. Install and open Bridge on the laptop. When **Windows Firewall** asks, allow it on **Private networks**.
   Bridge uses TCP port **47600**.
2. Click **Share a folder…** and pick the backend, or use **Suggestions**.
   Keep **"Other devices may: propose changes on a branch"**.
3. Optional: under **"Changes are applied"**, choose **"only after I approve here"** if you want to approve
   each backend change on the laptop.

## 5. Pair the Mac with the laptop

1. **Laptop:** click **Pair a device**. A 6-digit code appears, valid for 5 minutes, along with the laptop's address.
2. **Mac:**
   - **App:** click **Join a device**. The laptop usually appears under "Found on your network". Click it,
     enter the code and click **Join**.
   - **CLI:** `bridge join <laptop-address> <code>`
3. Compare the **Device ID** (for example `7166-BA0B`) shown on each machine; they should match what the other machine shows for it.

If the laptop isn't found automatically, type its address. The laptop app's header shows its addresses (for example `192.168.1.2`).
If you use **Tailscale**, use the laptop's Tailscale name or `100.x.x.x` address. It works from anywhere, and you can add it permanently
under **Devices → Addresses…**.

## 6. Connect Claude Code on the Mac (once)

- **App:** **Settings → Connect Claude Code**
- **CLI:** `bridge install-mcp`

This registers Bridge with Claude Code at user scope, so **every folder on the Mac** gets the Bridge tools.
Restart any Claude sessions that are already open.

Then turn on **Start Bridge at login** on **both** machines.

## 7. Try it

In your mobile app folder on the Mac:

```bash
cd ~/code/my-mobile-app
claude
```

> Use Bridge to check what GET /users/:id returns on the backend.

Claude calls `ask` and answers from the laptop. Some more prompts:

> Build the API client for orders. Ask the backend for the exact request/response shapes first.

> The profile screen needs `avatarUrl` (string or null) on GET /users/:id. Ask the backend to add it,
> review the diff and apply it if the tests pass.

The mobile folder links itself to the backend project automatically, and the choice is remembered.
If the laptop shares several projects, Claude asks once which one to use.

| Tool | What it does |
|---|---|
| `list_remote_projects` | Paired devices, online status, shared projects |
| `ask` | Question answered by Claude on the laptop (read-only, keeps context) |
| `change` | Change made on an isolated branch on the laptop; returns a summary, diff and test results |
| `review` | Full diff of a change |
| `apply` / `discard` | Merge the change into the backend, or throw it away |
| `job_status` | Wait for a long-running job |
| `status` | Backend branch, whether the dev server is running, the likely API URL from the Mac |

## 8. Point the mobile app at the backend

The backend's dev server must listen on **`0.0.0.0`**, not `localhost`, or the Mac, simulator and phone can't reach it.
For example: `app.listen(3000, '0.0.0.0')`, `uvicorn main:app --host 0.0.0.0`, `next dev -H 0.0.0.0`.

The base URL is then `http://<laptop-address>:<port>`. Ask Claude to run the Bridge `status` tool and it prints the likely URL.
iOS needs an App Transport Security exception to allow plain `http` during development.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Laptop shows **offline** on the Mac | Is the laptop awake with Bridge running? Are both on the same network or on Tailscale? Is port 47600 allowed in the Windows firewall (Private)? Try adding its address under **Addresses…**. |
| Laptop not found automatically when pairing | Some routers block mDNS. Type the laptop's address instead. |
| "Wrong pairing code" / "No active pairing code" | Codes expire after 5 minutes or 5 attempts. Click **Pair a device** again. |
| Claude doesn't have the Bridge tools | Click **Connect Claude Code** again, then restart Claude. Check with `claude mcp list`. |
| "Claude Code CLI was not found" on the laptop | Install Claude Code on the laptop and log in. The laptop runs the jobs. |
| A change says **"Could not merge"** | You edited the same lines on the laptop meanwhile. The change stays on branch `bridge/<id>`; merge it by hand or discard it. |
| "share no projects" | Share the backend in the laptop's Bridge app. |
| Daemon log | `~/.bridge/bridge.log` on each machine |

## Keeping it updated

```bash
cd multiple-claude
git pull
npm run setup
npm run app:build    # then replace Bridge.app in Applications
```

Run the same steps on the laptop with its Windows build, so both machines run the same version.
