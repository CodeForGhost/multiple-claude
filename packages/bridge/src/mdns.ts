// LAN discovery via mDNS/Bonjour (_bridge._tcp). Paired devices reconnect automatically
// when they appear; unpaired devices are listed in the UI as pairing targets.
import { Bonjour, type Service } from 'bonjour-service';
import { EventEmitter } from 'node:events';

export interface Discovered { id: string; name: string; host: string; port: number; addresses: string[]; seenAt: number }

export class Discovery extends EventEmitter {
  private bonjour?: Bonjour;
  found = new Map<string, Discovered>();

  start(self: { id: string; name: string; port: number }) {
    if (process.env.BRIDGE_NO_MDNS === '1') return;
    try {
      this.bonjour = new Bonjour();
      this.bonjour.publish({
        name: `Bridge ${self.name} ${self.id.slice(0, 6)}`,
        type: 'bridge',
        port: self.port,
        txt: { id: self.id, name: self.name, v: '1' },
      });
      const browser = this.bonjour.find({ type: 'bridge' });
      browser.on('up', (s: Service) => this.onUp(s, self.id));
      browser.on('down', (s: Service) => {
        const id = s.txt?.id;
        if (id && this.found.delete(id)) this.emit('change');
      });
      // Re-query periodically so devices that wake up are noticed promptly.
      setInterval(() => browser.update(), 30_000).unref();
    } catch (e) {
      this.emit('error', e);
    }
  }

  private onUp(s: Service, selfId: string) {
    const id = s.txt?.id as string | undefined;
    if (!id || id === selfId) return;
    const addresses = (s.addresses || []).filter((a) => !a.startsWith('fe80')).sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')));
    const d: Discovered = { id, name: String(s.txt?.name || s.name), host: s.host, port: s.port, addresses, seenAt: Date.now() };
    this.found.set(id, d);
    this.emit('up', d);
    this.emit('change');
  }

  list(): Discovered[] {
    return [...this.found.values()];
  }

  stop() {
    try { this.bonjour?.unpublishAll(); this.bonjour?.destroy(); } catch { /* ignore */ }
  }
}
