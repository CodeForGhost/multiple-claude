// Bridge UI: plain JS talking to the local daemon (127.0.0.1) with the token handed over by the
// Tauri shell. Also works in a normal browser with ?port=47601&token=... for development.
'use strict';

const TAURI = window.__TAURI__;
const invoke = (cmd, args) => (TAURI ? TAURI.core.invoke(cmd, args) : Promise.reject(new Error('not in app')));

let conn = null; // { port, token }
let state = null;
let remote = { projects: [], errors: [] };
let lastRemoteFetch = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};

// ---------- connection ----------
async function connect() {
  if (TAURI) return invoke('connection');
  const q = new URLSearchParams(location.search);
  if (!q.get('token')) throw new Error('Open this page from the Bridge app, or pass ?port=47601&token=<~/.bridge/local-token>.');
  return { port: Number(q.get('port') || 47601), token: q.get('token') };
}

async function api(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-bridge-token': conn.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

/** Run an action, show errors, refresh afterwards. */
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message || String(e), true);
  }
}

function setConn(kind, text) {
  $('conn-status').innerHTML = `<span class="dot ${kind}"></span><span>${esc(text)}</span>`;
}

function listenEvents() {
  const es = new EventSource(`http://127.0.0.1:${conn.port}/api/events?token=${encodeURIComponent(conn.token)}`);
  let pending;
  es.addEventListener('state', () => { clearTimeout(pending); pending = setTimeout(refresh, 150); });
  es.addEventListener('notify', (e) => {
    const { title, body } = JSON.parse(e.data);
    if (TAURI && document.hidden) invoke('notify', { title, body }).catch(() => {});
    else toast(`${title}: ${body}`);
  });
  es.onopen = () => refresh();
  es.onerror = () => setConn('warn', 'reconnecting…');
}

// ---------- rendering ----------
async function refresh() {
  try {
    state = await api('GET', '/api/state');
  } catch (e) {
    setConn('warn', 'daemon unreachable');
    return;
  }
  $('fatal').hidden = true;
  const online = state.peers.filter((p) => p.online).length;
  setConn(online ? 'on' : state.peers.length ? 'warn' : 'off',
    state.peers.length ? `${online}/${state.peers.length} device${state.peers.length > 1 ? 's' : ''} online` : 'not paired');
  const d = state.device;
  d.addresses ??= [];
  $('device-line').textContent = `${d.name} · ${d.addresses.join(', ') || d.hostname} · ID ${d.shortFingerprint}`;
  if (document.activeElement !== $('device-name')) $('device-name').value = d.name;
  if (document.activeElement !== $('scan-roots')) $('scan-roots').value = state.settings.scanRoots.join('; ');
  $('chk-ai').checked = state.settings.aiProfile;
  $('daemon-info').textContent = `v${state.version} · engine: ${state.engine} · peer port ${d.hostPort}`;
  renderPairing();
  renderPeers();
  renderProjects();
  renderJobs();
  if (Date.now() - lastRemoteFetch > 8000) refreshRemote();
  else renderRemote();
}

function renderPairing() {
  const panel = $('pairing-panel');
  const p = state.pairing;
  if (!p) { panel.hidden = true; return; }
  const secs = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  const addrs = state.device.addresses.length ? state.device.addresses : [state.device.hostname];
  panel.hidden = false;
  panel.innerHTML = `
    <div class="row wrap" style="justify-content:space-between">
      <div>
        <div class="hint" style="margin:0">Enter this code on the other device (Join a device):</div>
        <div class="big-code">${esc(p.code)}</div>
        <div class="hint">This device's address: ${addrs.map((a) => `<code>${esc(a)}${state.device.hostPort !== 47600 ? `:${state.device.hostPort}` : ''}</code>`).join(' or ')}
          · Device ID <code>${esc(state.device.shortFingerprint)}</code> · expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</div>
        <div class="hint">From the command line: <code>bridge join ${esc(addrs[0])}${state.device.hostPort !== 47600 ? `:${state.device.hostPort}` : ''} ${esc(p.code)}</code></div>
      </div>
      <button id="btn-pair-cancel">Cancel</button>
    </div>`;
  $('btn-pair-cancel').onclick = () => act(() => api('POST', '/api/pair/cancel'));
  clearTimeout(renderPairing.t);
  renderPairing.t = setTimeout(() => state.pairing && renderPairing(), 1000);
}

function renderPeers() {
  const ul = $('peer-list');
  const discovered = state.discovered.filter((x) => !x.paired);
  $('discovered').innerHTML = discovered.length
    ? `<div class="hint">Found on your network:</div><div class="chips" style="margin-bottom:10px">${discovered
        .map((x) => `<button class="small" data-host="${esc(x.addresses[0] || x.host)}${x.port !== 47600 ? `:${x.port}` : ''}">${esc(x.name)}</button>`).join('')}</div>`
    : '';
  $('discovered').querySelectorAll('button[data-host]').forEach((b) => {
    b.onclick = () => { $('join-host').value = b.dataset.host; $('join-code').focus(); };
  });
  if (!state.peers.length) {
    ul.innerHTML = `<li class="empty">No paired devices yet. Install Bridge on your other machine, click <b>Pair a device</b> on one and <b>Join a device</b> on the other.</li>`;
    return;
  }
  ul.innerHTML = state.peers.map((p) => `
    <li>
      <div class="item-head">
        <div class="item-title"><span class="dot ${p.online ? 'on' : 'off'}"></span>${esc(p.name)}</div>
        <div class="actions">
          <button class="small" data-hosts="${esc(p.id)}">Addresses…</button>
          <button class="small danger" data-unpair="${esc(p.id)}">Unpair</button>
        </div>
      </div>
      <div class="meta">${p.online ? `Connected via ${esc(p.address)}` : 'Offline. It reconnects automatically when the device is on and Bridge is running.'}
        · Device ID ${esc(p.shortFingerprint)}${p.hosts.length ? ` · manual: ${p.hosts.map(esc).join(', ')}` : ''}</div>
    </li>`).join('');
  ul.querySelectorAll('[data-unpair]').forEach((b) => {
    b.onclick = () => {
      const p = state.peers.find((x) => x.id === b.dataset.unpair);
      confirmModal(`Unpair ${p.name}?`, 'Both devices will need to pair again to reconnect.', 'Unpair',
        () => act(() => api('DELETE', `/api/peers/${p.id}`), 'Device removed'));
    };
  });
  ul.querySelectorAll('[data-hosts]').forEach((b) => {
    b.onclick = () => {
      const p = state.peers.find((x) => x.id === b.dataset.hosts);
      openModal(`Addresses for ${p.name}`, `
        <p class="hint">Bridge finds devices on your local network automatically. Add addresses that work from anywhere,
          such as a Tailscale name (<code>laptop.tail1234.ts.net</code>), one per line.</p>
        <textarea id="hosts-input" rows="4" style="width:100%;font:inherit;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--text)">${esc(p.hosts.join('\n'))}</textarea>
        <div class="controls"><button class="primary" id="hosts-save">Save</button></div>`);
      $('hosts-save').onclick = async () => {
        await act(() => api('PATCH', `/api/peers/${p.id}`, { hosts: $('hosts-input').value.split(/\n|,/) }), 'Saved');
        $('modal').close();
      };
    };
  });
}

function renderProjects() {
  const ul = $('project-list');
  if (!state.projects.length) {
    ul.innerHTML = `<li class="empty">Nothing shared yet. Click <b>Share a folder…</b> or pick from <b>Suggestions</b>. Bridge detects the stack, test command and dev port automatically.</li>`;
    return;
  }
  ul.innerHTML = state.projects.map((p) => `
    <li>
      <div class="item-head">
        <div class="item-title">${esc(p.name)}</div>
        <div class="actions">
          <button class="small" data-refresh="${p.id}">Re-detect</button>
          <button class="small danger" data-unshare="${p.id}">Stop sharing</button>
        </div>
      </div>
      <div class="meta mono">${esc(p.path)}</div>
      <div class="chips">
        ${[...p.stacks, ...p.frameworks].map((s) => `<span class="chip accent">${esc(s)}</span>`).join('')}
        ${p.profile.git.isRepo ? `<span class="chip">git: ${esc(p.profile.git.branch || '?')}</span>` : '<span class="chip">no git</span>'}
        ${p.apiSpec ? `<span class="chip">spec: ${esc(p.apiSpec)}</span>` : ''}
        ${p.profile.hasClaudeMd ? '<span class="chip">CLAUDE.md</span>' : ''}
      </div>
      ${p.summary ? `<div class="summary">${esc(p.summary)}</div>` : ''}
      <div class="controls">
        <label>Other devices may
          <select data-perm="${p.id}">
            <option value="read" ${p.permission === 'read' ? 'selected' : ''}>only ask questions</option>
            <option value="branch" ${p.permission === 'branch' ? 'selected' : ''} ${p.profile.git.isRepo ? '' : 'disabled'}>propose changes on a branch</option>
            <option value="direct" ${p.permission === 'direct' ? 'selected' : ''}>edit files directly</option>
          </select>
        </label>
        <label ${p.permission === 'branch' ? '' : 'hidden'}>Changes are applied
          <select data-policy="${p.id}">
            <option value="peer" ${p.applyPolicy === 'peer' ? 'selected' : ''}>by the requesting device</option>
            <option value="host" ${p.applyPolicy === 'host' ? 'selected' : ''}>only after I approve here</option>
          </select>
        </label>
        <label>Tests <input data-test="${p.id}" value="${esc(p.testCommand || '')}" placeholder="none" size="16" /></label>
        <label>Dev port <input data-port="${p.id}" value="${esc(p.devPort || '')}" placeholder="-" size="5" /></label>
      </div>
    </li>`).join('');
  ul.querySelectorAll('[data-perm]').forEach((s) => {
    s.onchange = () => act(() => api('PATCH', `/api/projects/${s.dataset.perm}`, { permission: s.value }), 'Saved');
  });
  ul.querySelectorAll('[data-policy]').forEach((s) => {
    s.onchange = () => act(() => api('PATCH', `/api/projects/${s.dataset.policy}`, { applyPolicy: s.value }), 'Saved');
  });
  ul.querySelectorAll('[data-test]').forEach((i) => {
    i.onchange = () => act(() => api('PATCH', `/api/projects/${i.dataset.test}`, { testCommand: i.value }), 'Saved');
  });
  ul.querySelectorAll('[data-port]').forEach((i) => {
    i.onchange = () => act(() => api('PATCH', `/api/projects/${i.dataset.port}`, { devPort: i.value }), 'Saved');
  });
  ul.querySelectorAll('[data-refresh]').forEach((b) => {
    b.onclick = () => act(() => api('POST', `/api/projects/${b.dataset.refresh}/refresh`), 'Profile updated');
  });
  ul.querySelectorAll('[data-unshare]').forEach((b) => {
    const p = state.projects.find((x) => x.id === b.dataset.unshare);
    b.onclick = () => confirmModal(`Stop sharing ${p.name}?`, 'Other devices will no longer see this project. Files are not touched.', 'Stop sharing',
      () => act(() => api('DELETE', `/api/projects/${p.id}`), 'Stopped sharing'));
  });
}

async function refreshRemote() {
  lastRemoteFetch = Date.now();
  try { remote = await api('GET', '/api/remote-projects'); } catch (e) { remote = { projects: [], errors: [e.message] }; }
  renderRemote();
}

function renderRemote() {
  const ul = $('remote-list');
  if (!state.peers.length) { ul.innerHTML = '<li class="empty">Pair a device to see its projects.</li>'; return; }
  if (!remote.projects.length) {
    ul.innerHTML = `<li class="empty">${state.peers.some((p) => p.online) ? 'Paired devices are online but share nothing yet.' : 'Paired devices are offline.'}
      ${remote.errors.length ? `<br>${remote.errors.map(esc).join('<br>')}` : ''}</li>`;
    return;
  }
  ul.innerHTML = remote.projects.map((p) => `
    <li>
      <div class="item-head">
        <div class="item-title">${esc(p.peerName)} / ${esc(p.name)}</div>
        <span class="badge">${p.permission === 'read' ? 'questions only' : p.permission === 'branch' ? `changes on branch · applied by ${p.applyPolicy === 'host' ? 'host approval' : 'you'}` : 'direct edits'}</span>
      </div>
      <div class="chips">
        ${[...p.stacks, ...p.frameworks].map((s) => `<span class="chip accent">${esc(s)}</span>`).join('')}
        ${p.devPort ? `<span class="chip">dev port ${esc(p.devPort)}</span>` : ''}
        ${p.testCommand ? `<span class="chip">tests: ${esc(p.testCommand)}</span>` : ''}
      </div>
      ${p.summary ? `<div class="summary">${esc(p.summary)}</div>` : ''}
    </li>`).join('');
}

function renderJobs() {
  const ul = $('job-list');
  if (!state.jobs.length) {
    ul.innerHTML = '<li class="empty">No requests yet. Questions and change requests from other devices appear here.</li>';
    return;
  }
  ul.innerHTML = state.jobs.slice(0, 25).map((j) => `
    <li>
      <div class="item-head">
        <div class="item-title"><span class="badge ${esc(j.status)}">${esc(j.status.replace('-', ' '))}</span>
          ${j.type === 'ask' ? 'Question' : 'Change'} · ${esc(j.projectName)}</div>
        <div class="actions">
          ${j.type === 'change' && j.diffStat ? `<button class="small" data-diff="${j.id}">View diff</button>` : ''}
          ${j.result || j.error ? `<button class="small" data-result="${j.id}">Details</button>` : ''}
          ${j.status === 'awaiting-approval' ? `<button class="small primary" data-approve="${j.id}">Approve & apply</button><button class="small danger" data-reject="${j.id}">Reject</button>` : ''}
          ${j.status === 'ready' ? `<button class="small" data-approve="${j.id}">Apply</button><button class="small danger" data-discard="${j.id}">Discard</button>` : ''}
        </div>
      </div>
      <div class="meta">From ${esc(j.peerName)} · ${ago(j.createdAt)}${j.tests ? ` · tests ${j.tests.ok ? 'passed' : 'failed'}` : ''}${j.costUsd ? ` · $${j.costUsd.toFixed(3)}` : ''}</div>
      <div class="summary">${esc(j.input.length > 280 ? `${j.input.slice(0, 280)}…` : j.input)}</div>
    </li>`).join('');
  ul.querySelectorAll('[data-approve]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.approve}/approve`), 'Change applied'); });
  ul.querySelectorAll('[data-reject]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.reject}/reject`), 'Change rejected'); });
  ul.querySelectorAll('[data-discard]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.discard}/discard`), 'Change discarded'); });
  ul.querySelectorAll('[data-diff]').forEach((b) => { b.onclick = () => showJob(b.dataset.diff, true); });
  ul.querySelectorAll('[data-result]').forEach((b) => { b.onclick = () => showJob(b.dataset.result, false); });
}

function colorDiff(diff) {
  return diff.split('\n').map((l) => {
    const e = esc(l);
    if (l.startsWith('+') && !l.startsWith('+++')) return `<span class="diff-add">${e}</span>`;
    if (l.startsWith('-') && !l.startsWith('---')) return `<span class="diff-del">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="diff-hunk">${e}</span>`;
    return e;
  }).join('\n');
}

async function showJob(id, withDiff) {
  try {
    const j = await api('GET', `/api/jobs/${id}`);
    openModal(`${j.type === 'ask' ? 'Question' : 'Change'} · ${j.projectName}`, `
      <div class="hint">From ${esc(j.peerName)} · ${esc(j.status)}${j.branch ? ` · branch <code>${esc(j.branch)}</code>` : ''}</div>
      <h3>Request</h3><pre>${esc(j.input)}</pre>
      ${j.error ? `<h3>Error</h3><pre>${esc(j.error)}</pre>` : ''}
      ${j.result ? `<h3>${j.type === 'ask' ? 'Answer' : 'Summary'}</h3><pre style="white-space:pre-wrap">${esc(j.result)}</pre>` : ''}
      ${j.tests ? `<h3>Tests: ${j.tests.ok ? 'passed' : 'failed'} (<code>${esc(j.tests.command)}</code>)</h3>${j.tests.ok ? '' : `<pre>${esc(j.tests.output)}</pre>`}` : ''}
      ${j.diffStat ? `<h3>Files</h3><pre>${esc(j.diffStat)}</pre>` : ''}
      ${withDiff && j.diff ? `<h3>Diff</h3><pre>${colorDiff(j.diff)}</pre>` : ''}`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- modal ----------
function openModal(title, html) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = html;
  $('modal').showModal();
}
function confirmModal(title, text, okLabel, onOk) {
  openModal(title, `<p>${esc(text)}</p><div class="controls"><button class="primary" id="confirm-ok">${esc(okLabel)}</button><button id="confirm-cancel">Cancel</button></div>`);
  $('confirm-ok').onclick = () => { $('modal').close(); onOk(); };
  $('confirm-cancel').onclick = () => $('modal').close();
}
$('modal-close').onclick = () => $('modal').close();

// ---------- actions ----------
$('btn-pair').onclick = () => act(() => api('POST', '/api/pair/start'));
$('btn-join').onclick = () => { $('join-panel').hidden = !$('join-panel').hidden; if (!$('join-panel').hidden) $('join-host').focus(); };
$('join-form').onsubmit = async (e) => {
  e.preventDefault();
  const r = await act(() => api('POST', '/api/pair/join', { host: $('join-host').value, code: $('join-code').value }), (x) => `Paired with ${x.name}`);
  if (r) { $('join-panel').hidden = true; $('join-code').value = ''; lastRemoteFetch = 0; }
};

$('btn-pick').onclick = async () => {
  let path;
  if (TAURI) path = await invoke('pick_folder');
  else path = prompt('Folder to share (absolute path):');
  if (path) act(() => api('POST', '/api/projects', { path }), (p) => `Sharing ${p.name}`);
};

$('btn-suggest').onclick = async () => {
  const panel = $('suggest-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = '<div class="hint">Looking for projects you have used with Claude Code…</div>';
  try {
    const list = await api('GET', '/api/candidates');
    panel.innerHTML = list.length
      ? `<div class="hint">Projects found on this machine:</div><ul class="list">${list.slice(0, 30).map((c) => `
          <li class="item-head"><div><div class="item-title">${esc(c.name)}</div><div class="meta mono">${esc(c.path)}</div></div>
          <button class="small primary" data-share="${esc(c.path)}">Share</button></li>`).join('')}</ul>`
      : '<div class="hint">Nothing found. Add folders to scan in Settings, or use Share a folder….</div>';
    panel.querySelectorAll('[data-share]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        await act(() => api('POST', '/api/projects', { path: b.dataset.share }), (p) => `Sharing ${p.name}`);
        b.closest('li').remove();
      };
    });
  } catch (e) {
    panel.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
  }
};

$('btn-remote-refresh').onclick = () => refreshRemote();

$('btn-mcp').onclick = async () => {
  $('btn-mcp').disabled = true;
  await act(() => api('POST', '/api/mcp/install'), 'Claude Code connected. Restart open Claude sessions to load the Bridge tools.');
  $('btn-mcp').disabled = false;
  checkMcp();
};
async function checkMcp() {
  try {
    const s = await api('GET', '/api/mcp');
    $('mcp-status').textContent = !s.claudeFound
      ? 'Claude Code CLI not found on this machine. Install it to use projects shared by other devices.'
      : s.registered ? 'Connected: Claude Code in every folder on this machine has the Bridge tools.'
      : 'Not connected yet. Click to give Claude Code on this machine access to shared projects.';
    $('btn-mcp').textContent = s.registered ? 'Reconnect' : 'Connect Claude Code';
  } catch (e) {
    $('mcp-status').textContent = e.message;
  }
}

$('chk-autostart').onchange = async (e) => {
  try { e.target.checked = await invoke('autostart_set', { enabled: e.target.checked }); }
  catch (err) { toast(err.message || String(err), true); e.target.checked = !e.target.checked; }
};
$('chk-ai').onchange = (e) => act(() => api('POST', '/api/settings', { aiProfile: e.target.checked }), 'Saved');
$('name-form').onsubmit = (e) => { e.preventDefault(); act(() => api('POST', '/api/settings', { name: $('device-name').value }), 'Saved. Paired devices see the new name after re-pairing.'); };
$('roots-form').onsubmit = (e) => {
  e.preventDefault();
  act(() => api('POST', '/api/settings', { scanRoots: $('scan-roots').value.split(';').map((s) => s.trim()).filter(Boolean) }), 'Saved');
};
$('btn-restart').onclick = async () => {
  try { await invoke('restart_daemon'); conn = await connect(); toast('Daemon restarted'); listenEvents(); }
  catch (e) { toast(e.message || String(e), true); }
};

// ---------- boot ----------
(async function boot() {
  try {
    conn = await connect();
  } catch (e) {
    $('fatal').textContent = e.message || String(e);
    $('fatal').hidden = false;
    setConn('off', 'offline');
    return;
  }
  listenEvents();
  await refresh();
  checkMcp();
  if (TAURI) invoke('autostart_get').then((v) => { $('chk-autostart').checked = v; }).catch(() => {});
  else $('chk-autostart').disabled = true;
  setInterval(() => { if (!document.hidden) refreshRemote(); }, 15000);
})();
