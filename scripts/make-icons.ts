/**
 * Rasterize the app icon to PNG (no image dependencies): a basketball on a dark
 * rounded tile, supersampled for smooth edges. Run once: `npx tsx scripts/make-icons.ts`.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const BG = [0x12, 0x12, 0x11];
const BALL = [0xeb, 0x68, 0x34];

function crc32(buf: Buffer) {
  let c: number;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Color at unit coordinates (0..1), or null for transparent. */
function shade(x: number, y: number, maskable: boolean): number[] | null {
  const r = maskable ? 0 : 0.22; // tile corner radius
  const inTile = (() => {
    const cx = Math.min(Math.max(x, r), 1 - r);
    const cy = Math.min(Math.max(y, r), 1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  })();
  if (!inTile) return null;
  const R = maskable ? 0.27 : 0.33; // maskable icons keep content in the safe zone
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);
  if (d > R) return BG;
  const w = 0.021;
  const seam =
    Math.abs(d - R) < w * 1.2 ||
    Math.abs(dx) < w ||
    Math.abs(dy) < w ||
    Math.abs(Math.hypot(x - (0.5 - R * 1.55), dy) - R * 1.2) < w ||
    Math.abs(Math.hypot(x - (0.5 + R * 1.55), dy) - R * 1.2) < w;
  return seam ? BG : BALL;
}

function png(size: number, maskable = false) {
  const SS = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
        if (!c) continue;
        rr += c[0]; gg += c[1]; bb += c[2]; aa += 255;
      }
      const n = SS * SS;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const a = aa / n;
      raw[o] = a ? Math.round(rr / (aa / 255)) : 0;
      raw[o + 1] = a ? Math.round(gg / (aa / 255)) : 0;
      raw[o + 2] = a ? Math.round(bb / (aa / 255)) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.writeFileSync('public/icons/icon-180.png', png(180, true));
fs.writeFileSync('public/icons/icon-192.png', png(192));
fs.writeFileSync('public/icons/icon-512.png', png(512));
fs.writeFileSync('public/icons/icon-maskable-512.png', png(512, true));
console.log('icons written');
