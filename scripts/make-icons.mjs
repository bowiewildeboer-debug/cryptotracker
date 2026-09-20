/**
 * Generates the PWA icons.
 *
 *   node scripts/make-icons.mjs
 *
 * Written as a tiny PNG encoder on top of the built-in zlib rather than pulling in an image
 * library: three flat-colour icons do not justify a dependency, and this keeps `npm ci` in CI
 * to four packages.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const BG = [0x0b, 0x0e, 0x14];
const LINE = [0x4a, 0x9e, 0xff];
const KIJUN = [0x8d, 0x97, 0xad];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rising line crossing a flat base line: the Kijun and a price above it. */
function draw(size, inset) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);

  const m = Math.round(size * inset);
  const w = size - 2 * m;
  const thick = Math.max(2, Math.round(size / 28));

  // The flat base line, two thirds down.
  const baseY = m + Math.round(w * 0.62);
  for (let x = m; x < size - m; x++) for (let t = 0; t < thick; t++) set(x, baseY + t, KIJUN);

  // A price line that starts below it and ends well above it.
  const pts = [0, 0.18, 0.34, 0.5, 0.66, 0.82, 1].map((f) => ({
    x: m + Math.round(f * w),
    y: m + Math.round(w * (0.78 - 0.68 * f + 0.1 * Math.sin(f * 7))),
  }));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
      for (let t = -thick; t <= thick; t++) set(x, y + t, LINE);
    }
  }
  return png(size, size, px);
}

mkdirSync('web/icons', { recursive: true });
// Maskable icons get a bigger margin: Android crops them to whatever shape the launcher uses.
for (const [file, size, inset] of [
  ['web/icons/icon-192.png', 192, 0.14],
  ['web/icons/icon-512.png', 512, 0.14],
  ['web/icons/icon-maskable-512.png', 512, 0.25],
]) {
  writeFileSync(file, draw(size, inset));
  console.log(`wrote ${file}`);
}
