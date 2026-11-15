// Generates icon-source.png (1024x1024) without image tooling: two nodes joined by an arc
// on a rounded indigo square. `npm run icons` turns it into every platform icon via `tauri icon`.
import fs from 'node:fs';
import zlib from 'node:zlib';

const S = 1024;
const px = new Uint8Array(S * S * 4);
const SS = 3; // supersampling for anti-aliasing

const inRoundRect = (x, y, r = 220, m = 40) => {
  const lo = m, hi = S - m;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + r), hi - r);
  const cy = Math.min(Math.max(y, lo + r), hi - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

function shade(x, y) {
  if (!inRoundRect(x, y)) return null;
  // background gradient
  const t = y / S;
  let c = [Math.round(79 - 30 * t), Math.round(70 - 30 * t), Math.round(229 - 60 * t)];
  // arc: circle centred below, drawn as a thick ring segment between the nodes
  const acx = 512, acy = 760, ar = 330;
  const d = Math.abs(dist(x, y, acx, acy) - ar);
  if (d < 34 && y < 640) c = [255, 255, 255];
  // nodes
  for (const [nx, ny] of [[230, 640], [794, 640]]) {
    const dn = dist(x, y, nx, ny);
    if (dn < 92) c = dn < 52 ? [79, 70, 229] : [255, 255, 255];
  }
  // deck
  if (y > 700 && y < 740 && x > 200 && x < 824) c = [199, 210, 254];
  return c;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
    }
    const i = (y * S + x) * 4;
    if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (255 * a) / (SS * SS); }
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
fs.writeFileSync('icon-source.png', Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log('wrote icon-source.png');
