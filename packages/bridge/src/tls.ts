// Each device has a self-signed TLS identity. Peers pin each other's certificate at pairing time.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-ignore - selfsigned ships no types
import selfsigned from 'selfsigned';
import { files, ensureDir } from './state.js';

export interface Identity { cert: string; key: string; fingerprint: string }

export function fingerprintOf(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256;
}

/** Short human-comparable code derived from a fingerprint, e.g. "4F2A-91C0". */
export function shortFingerprint(fp: string): string {
  const hex = fp.replace(/:/g, '');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`;
}

export function loadIdentity(deviceName: string): Identity {
  if (!fs.existsSync(files.cert) || !fs.existsSync(files.key)) {
    ensureDir(path.dirname(files.cert));
    const pems = selfsigned.generate([{ name: 'commonName', value: `bridge-${deviceName}` }], {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      ],
    });
    fs.writeFileSync(files.cert, pems.cert, { mode: 0o600 });
    fs.writeFileSync(files.key, pems.private, { mode: 0o600 });
  }
  const cert = fs.readFileSync(files.cert, 'utf8');
  const key = fs.readFileSync(files.key, 'utf8');
  return { cert, key, fingerprint: fingerprintOf(cert) };
}
