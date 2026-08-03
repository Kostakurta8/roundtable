/**
 * Draws `desktop/claude-agents.ico` — the Windows shortcut's icon.
 *
 * Written out rather than checked in as an opaque binary, because an icon nobody can regenerate is
 * an icon nobody can change. No image library: a PNG is a zlib stream with a four-byte CRC per
 * chunk, and a modern .ico is just a directory of PNGs, so both fit in a page of code and add no
 * dependency to a project that has four.
 *
 * The mark is the app's own — the ring and centre dot from the ROUNDTABLE wordmark — with three
 * agents seated around it. Each size is rendered from the geometry rather than scaled down from one
 * big one, because a 16px icon that was a resampled 256px icon is a smudge.
 *
 *   node scripts/desktopIcon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'desktop', 'claude-agents.ico');

/** The app's palette, so the icon and the room cannot drift apart. */
const BG = [0x1d, 0x36, 0x44]; // wa3 — the office wall after hours
const RING = [0x3e, 0x9a, 0xa8]; // accent-2
const CORE = [0x6a, 0xc6, 0xd4]; // accent-2, night
const SEATS = [
  [0xd8, 0x94, 0x40], // amber
  [0xd0, 0x6e, 0x88], // rose
  [0x5e, 0x8c, 0x6a], // moss
];

/** 4x4 supersampling — enough to keep a circle's edge smooth at 16px without a blur pass. */
const SS = 4;

/**
 * One icon, drawn analytically at `n` pixels square.
 *
 * Everything is expressed as a fraction of the size, so the composition is identical at every
 * resolution and only the sampling gets finer.
 */
function draw(n) {
  const px = Buffer.alloc(n * n * 4);
  const c = n / 2;
  const rOuter = n * 0.3;
  const rInner = n * 0.205;
  const rCore = n * 0.09;
  const rSeat = n * 0.078;
  // Far enough out to sit clear of the table, close enough in that the two lower seats are not
  // shaved by the tile's rounded corners.
  const rSeatOrbit = n * 0.335;
  // Corner radius of the tile. Windows draws icons on every kind of background, so the mark needs
  // its own ground to sit on rather than floating on whatever is behind it.
  const rad = n * 0.22;

  const seats = SEATS.map((rgb, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEATS.length;
    return { x: c + Math.cos(a) * rSeatOrbit, y: c + Math.sin(a) * rSeatOrbit, rgb };
  });

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px1 = x + (sx + 0.5) / SS;
          const py1 = y + (sy + 0.5) / SS;
          const hit = sample(px1, py1, { n, c, rad, rOuter, rInner, rCore, rSeat, seats });
          if (!hit) continue;
          r += hit[0];
          g += hit[1];
          b += hit[2];
          a += 255;
        }
      }
      const taken = a / 255;
      const i = (y * n + x) * 4;
      if (taken === 0) continue;
      px[i] = Math.round(r / taken);
      px[i + 1] = Math.round(g / taken);
      px[i + 2] = Math.round(b / taken);
      px[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return px;
}

/** The colour at one sample point, or null where the icon is transparent. */
function sample(x, y, m) {
  // Rounded-square ground.
  const dx = Math.max(Math.abs(x - m.c) - (m.n / 2 - m.rad), 0);
  const dy = Math.max(Math.abs(y - m.c) - (m.n / 2 - m.rad), 0);
  if (Math.hypot(dx, dy) > m.rad) return null;

  for (const s of m.seats) {
    if (Math.hypot(x - s.x, y - s.y) <= m.rSeat) return s.rgb;
  }
  const d = Math.hypot(x - m.c, y - m.c);
  if (d <= m.rCore) return CORE;
  if (d <= m.rOuter && d >= m.rInner) return RING;
  return BG;
}

// ------------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(px, n) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // Each scanline is prefixed with its filter type; 0 is "none", which costs a byte a row and
  // saves having to implement the other four.
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    px.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------- ICO

/** Every size Windows asks for: the tray and the small list, the desktop, and the jumbo view. */
const SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((n) => ({ n, data: png(draw(n), n) }));

const dir = Buffer.alloc(6 + images.length * 16);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // 1 = icon
dir.writeUInt16LE(images.length, 4);

let offset = dir.length;
images.forEach((img, i) => {
  const at = 6 + i * 16;
  dir[at] = img.n >= 256 ? 0 : img.n; // 0 means 256 — the field is one byte
  dir[at + 1] = img.n >= 256 ? 0 : img.n;
  dir[at + 2] = 0; // palette size: none, it is truecolour
  dir[at + 3] = 0; // reserved
  dir.writeUInt16LE(1, at + 4); // colour planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(img.data.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += img.data.length;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([dir, ...images.map((i) => i.data)]));
console.log(`wrote ${OUT} — ${SIZES.join(', ')}px, ${(offset / 1024).toFixed(1)} KB`);
