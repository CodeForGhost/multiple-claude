// Minimal JSON-RPC over WebSocket shared by host and client sides.
import type WebSocket from 'ws';

export interface RpcRequest { id: number; method: string; params?: any }
export interface RpcResponse { id: number; result?: any; error?: string }
export interface RpcEvent { event: string; data: any }

export type Handler = (params: any) => Promise<any> | any;

export function serveRpc(ws: WebSocket, handlers: Record<string, Handler>) {
  ws.on('message', async (raw) => {
    let msg: RpcRequest;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const h = handlers[msg.method];
    let resp: RpcResponse;
    if (!h) resp = { id: msg.id, error: `Unknown method ${msg.method}` };
    else {
      try { resp = { id: msg.id, result: await h(msg.params ?? {}) }; }
      catch (e: any) { resp = { id: msg.id, error: String(e?.message || e) }; }
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(resp));
  });
}

export class RpcClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private ws: WebSocket, private onEvent: (e: RpcEvent) => void) {
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (typeof msg.event === 'string') { this.onEvent(msg); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    });
    ws.on('close', () => this.failAll(new Error('Connection to peer closed.')));
  }

  call<T = any>(method: string, params: any = {}, timeoutMs = 60_000): Promise<T> {
    if (this.ws.readyState !== this.ws.OPEN) return Promise.reject(new Error('Peer is not connected.'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Peer did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  failAll(err: Error) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
