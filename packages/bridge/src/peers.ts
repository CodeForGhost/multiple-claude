// Client side: keeps an authenticated, certificate-pinned connection to every paired peer,
// reconnecting automatically across all known addresses (manual, mDNS, last seen).
import https from 'node:https';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RpcClient } from './rpc.js';
import { fingerprintOf, type Identity } from './tls.js';
import { State, Peer, randomToken, now } from './state.js';

export interface PeerStatus { id: string; name: string; online: boolean; address?: string; fingerprint: string; hosts: string[]; lastAddresses: string[]; pairedAt: string }

function urlHost(h: string): string {
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

/** Split "host", "host:port" or "[v6]:port". */
export function parseHostPort(input: string, defPort: number): { host: string; port: number } {
  const s = input.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: Number(v6[2] || defPort) };
  const parts = s.split(':');
  if (parts.length === 2) return { host: parts[0], port: Number(parts[1]) || defPort };
  return { host: s, port: defPort };
}

class PeerConnection {
  ws?: WebSocket;
  rpc?: RpcClient;
  online = false;
  address?: string;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private backoff = 1000;
  private connecting = false;

  constructor(private mgr: PeerManager, public peerId: string) {}

  start() { this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.terminate();
  }

  /** Try again immediately, e.g. when mDNS sees the peer appear. */
  poke() {
    if (this.online || this.connecting || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.backoff = 1000;
    this.connect();
  }

  private candidates(peer: Peer): { host: string; port: number }[] {
    const list = [...peer.hosts, ...this.mgr.mdnsAddresses(peer.id), ...peer.lastAddresses];
    const seen = new Set<string>();
    const out: { host: string; port: number }[] = [];
    for (const h of list) {
      const hp = parseHostPort(h, peer.port);
      const key = `${hp.host}:${hp.port}`;
      if (!seen.has(key)) { seen.add(key); out.push(hp); }
    }
    return out;
  }

  private async connect() {
    if (this.stopped) return;
    const peer = this.mgr.state.peer(this.peerId);
    if (!peer) return;
    this.connecting = true;
    for (const c of this.candidates(peer)) {
      if (this.stopped) break;
      const ws = await this.tryOne(peer, c.host, c.port);
      if (ws) {
        this.connecting = false;
        this.attach(ws, `${c.host}:${c.port}`);
        return;
      }
    }
    this.connecting = false;
    this.schedule();
  }

  private tryOne(peer: Peer, host: string, port: number): Promise<WebSocket | undefined> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`wss://${urlHost(host)}:${port}/rpc`, {
        headers: { authorization: `Bearer ${peer.tokenForThem}` },
        // Trust exactly the certificate pinned at pairing time; hostnames are irrelevant.
        ca: peer.cert,
        // Node's tls treats `undefined` as "identity OK"; ws's typings say boolean.
        checkServerIdentity: (() => undefined) as any,
        handshakeTimeout: 4000,
      });
      const fail = () => { ws.removeAllListeners(); ws.on('error', () => {}); ws.terminate(); resolve(undefined); };
      ws.once('open', () => { ws.removeAllListeners(); resolve(ws); });
      ws.once('error', fail);
      ws.once('unexpected-response', fail);
    });
  }

  private attach(ws: WebSocket, address: string) {
    this.ws = ws;
    this.rpc = new RpcClient(ws, (e) => this.mgr.emit('peer-event', this.peerId, e));
    this.online = true;
    this.address = address;
    this.backoff = 1000;
    const host = parseHostPort(address, 0).host;
    const peer = this.mgr.state.peer(this.peerId);
    if (peer && !peer.hosts.some((h) => parseHostPort(h, 0).host === host) && peer.lastAddresses[0] !== host) {
      peer.lastAddresses = [host, ...peer.lastAddresses.filter((a) => a !== host)].slice(0, 4);
      this.mgr.state.savePeers();
    }
    const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20_000);
    ws.on('error', () => {});
    ws.on('close', () => {
      clearInterval(ping);
      this.online = false;
      this.rpc = undefined;
      this.mgr.emit('peer-status');
      this.schedule();
    });
    this.mgr.emit('peer-status');
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }
}

export class PeerManager extends EventEmitter {
  private conns = new Map<string, PeerConnection>();
  private mdns = new Map<string, string[]>(); // peerId -> addresses seen via mDNS

  constructor(public state: State, private identity: Identity) {
    super();
  }

  start() {
    for (const p of this.state.peers) this.ensure(p.id);
  }

  stop() {
    for (const c of this.conns.values()) c.stop();
    this.conns.clear();
  }

  ensure(peerId: string) {
    if (this.conns.has(peerId)) return;
    const c = new PeerConnection(this, peerId);
    this.conns.set(peerId, c);
    c.start();
  }

  remove(peerId: string) {
    this.conns.get(peerId)?.stop();
    this.conns.delete(peerId);
    this.state.peers = this.state.peers.filter((p) => p.id !== peerId);
    this.state.savePeers();
    this.emit('peer-status');
  }

  mdnsAddresses(peerId: string): string[] {
    return this.mdns.get(peerId) || [];
  }

  /** Called by discovery when a paired device is seen on the network. */
  seen(peerId: string, addresses: string[]) {
    this.mdns.set(peerId, addresses);
    this.conns.get(peerId)?.poke();
  }

  status(): PeerStatus[] {
    return this.state.peers.map((p) => {
      const c = this.conns.get(p.id);
      return { id: p.id, name: p.name, online: !!c?.online, address: c?.address, fingerprint: p.fingerprint, hosts: p.hosts, lastAddresses: p.lastAddresses, pairedAt: p.pairedAt };
    });
  }

  online(): Peer[] {
    return this.state.peers.filter((p) => this.conns.get(p.id)?.online);
  }

  call<T = any>(peerId: string, method: string, params: any = {}, timeoutMs = 60_000): Promise<T> {
    const c = this.conns.get(peerId);
    const peer = this.state.peer(peerId);
    if (!c || !c.rpc || !c.online) {
      return Promise.reject(new Error(`${peer?.name || 'Peer'} is offline. Make sure Bridge is running on it and both devices are on the same network (or Tailscale).`));
    }
    return c.rpc.call<T>(method, params, timeoutMs);
  }

  /** Pair with a device that is showing a pairing code. */
  async pair(hostInput: string, code: string): Promise<Peer> {
    const { host, port } = parseHostPort(hostInput, 47600);
    const tokenForUs = randomToken();
    const body = JSON.stringify({
      code: code.trim(),
      id: this.state.config.id,
      name: this.state.config.name,
      cert: this.identity.cert,
      port: this.state.config.hostPort,
      token: tokenForUs,
    });
    const { status, json, observedFingerprint } = await new Promise<{ status: number; json: any; observedFingerprint?: string }>((resolve, reject) => {
      const req = https.request({
        host, port, path: '/pair', method: 'POST',
        // Not yet trusted: we accept any cert here and pin the one the server proves it holds.
        rejectUnauthorized: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (res) => {
        const sock = res.socket as tls.TLSSocket;
        const observed = sock.getPeerCertificate?.()?.fingerprint256;
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed: any;
          try { parsed = JSON.parse(data); } catch { parsed = { error: data }; }
          resolve({ status: res.statusCode || 0, json: parsed, observedFingerprint: observed });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Timed out connecting to ${host}:${port}.`)));
      req.on('error', (e) => reject(new Error(`Could not reach ${host}:${port}: ${e.message}`)));
      req.end(body);
    });
    if (status !== 200) throw new Error(json?.error || `Pairing failed (HTTP ${status}).`);
    const fingerprint = fingerprintOf(json.cert);
    if (!observedFingerprint || observedFingerprint !== fingerprint) {
      throw new Error('Pairing aborted: the certificate presented on the connection does not match the one in the reply.');
    }
    const existing = this.state.peer(json.id);
    const peer: Peer = {
      id: json.id,
      name: json.name,
      cert: json.cert,
      fingerprint,
      tokenForThem: json.token,
      tokenForUs,
      port: Number(json.port) || port,
      hosts: existing?.hosts || (/^\d+\.\d+\.\d+\.\d+$|:/.test(host) ? [] : [port === 47600 ? host : `${host}:${port}`]),
      lastAddresses: [host],
      pairedAt: now(),
    };
    this.conns.get(peer.id)?.stop();
    this.conns.delete(peer.id);
    this.state.peers = this.state.peers.filter((p) => p.id !== peer.id);
    this.state.peers.push(peer);
    this.state.savePeers();
    this.ensure(peer.id);
    this.emit('peer-status');
    return peer;
  }

  /** Re-read a peer added by the host side of a pairing and connect to it. */
  adopt(peer: Peer) {
    this.conns.get(peer.id)?.stop();
    this.conns.delete(peer.id);
    this.ensure(peer.id);
    this.emit('peer-status');
  }
}
