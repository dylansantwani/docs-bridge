// Renders extension/icons/icon{16,32,48,128}.png with no dependencies:
// a page with a folded corner, text lines, and a bridge arc underneath.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const PAGE = [37, 99, 235];   // indigo-blue
const FOLD = [147, 197, 253];
const WHITE = [255, 255, 255];
const ARC = [16, 185, 129];   // green bridge

// Shape tests in a 0..1 unit square; later shapes paint over earlier ones.
function sample(x, y) {
  let color = null;
  const inRoundRect = (x0, y0, x1, y1, r) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // page with the top-right corner cut
  if (inRoundRect(0.18, 0.06, 0.82, 0.78, 0.07) && !(x > 0.6 && y < 0.06 + (x - 0.6))) color = PAGE;
  // fold
  if (x > 0.6 && x < 0.82 && y > 0.06 && y < 0.28 && y > 0.06 + (x - 0.6) - 0.001) color = FOLD;
  // text lines
  for (const [ly, lx1] of [[0.34, 0.7], [0.46, 0.7], [0.58, 0.56]]) {
    if (inRoundRect(0.3, ly - 0.035, lx1, ly + 0.035, 0.035)) color = WHITE;
  }
  // bridge arc below the page
  const d = Math.hypot(x - 0.5, (y - 1.02) * 1.15);
  if (d > 0.3 && d < 0.4 && y < 0.97 && y > 0.66) color = ARC;
  return color;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * size + px) * 4;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = Math.round((a / (ss * ss)) * 255); }
  }
  writeFileSync(new URL(`../extension/icons/icon${size}.png`, import.meta.url), png(size, buf));
}
console.log('icons written');
