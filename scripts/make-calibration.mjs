// Writes synthetic calibration heatmaps (known truth) to tests/fixtures/calibration/.
// One sequential, one diverging and one rainbow colormap. Each PNG has a 12 x 9 grid,
// a vertical colorbar with three ticks, and a .json file with the true cell values and geometry, plus a .csv with the values in grid form (rows x cols).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../tests/fixtures/calibration/', import.meta.url);
const W = 960, H = 660;
const ROWS = 9, COLS = 12, CELL = 60, GX = 80, GY = 60;
const BAR = { x0: 860, x1: 890, y0: GY, y1: GY + ROWS * CELL };

const lerp = (stops) => (t) => {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
};
const jet = (t) => {
  const f = (c) => Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - c))));
  return [f(3), f(2), f(1)];
};

const MAPS = {
  viridis: { kind: 'sequential', min: 0, max: 100, ticks: [0, 50, 100],
    fn: lerp([[68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37]]) },
  coolwarm: { kind: 'diverging', min: -50, max: 50, ticks: [-50, 0, 50],
    fn: lerp([[59, 76, 192], [141, 176, 254], [221, 221, 221], [244, 154, 123], [180, 4, 38]]) },
  jet: { kind: 'rainbow', min: 0, max: 100, ticks: [0, 50, 100], fn: jet },
};

// Deterministic values: smooth field plus noise, pinned so the extremes hit the colorbar ends.
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
function values(min, max) {
  const v = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const s = 0.5 + 0.35 * Math.sin(c / 2.3) * Math.cos(r / 1.9) + 0.15 * (rand() - 0.5) * 2;
    v.push(Math.round((min + Math.min(1, Math.max(0, s)) * (max - min)) * 10) / 10);
  }
  v[0] = min; v[COLS * ROWS - 1] = max; v[COLS + 3] = (min + max) / 2;
  return v;
}

// 5 x 7 bitmap digits and minus for tick labels.
const FONT = { '0': '01110100011001110101110011000101110', '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111', '5': '11111100001111000001000011000101110',
  '-': '00000000000000011111000000000000000' };
const SC = 3;
function text(px, str, x, y) {
  [...str].forEach((ch, i) => {
    const g = FONT[ch];
    for (let k = 0; k < 35; k++) if (g[k] === '1') {
      const gx = x + (i * 6 + (k % 5)) * SC, gy = y + Math.floor(k / 5) * SC;
      for (let a = 0; a < SC; a++) for (let b = 0; b < SC; b++) set(px, gx + a, gy + b, [0, 0, 0]);
    }
  });
}
const set = (px, x, y, c) => { const o = (y * W + x) * 3; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; };
function rect(px, x0, y0, x1, y1, c) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(px, x, y, c); }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
  len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
}
function png(px) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, m] of Object.entries(MAPS)) {
  const px = Buffer.alloc(W * H * 3, 255);
  const vals = values(m.min, m.max);
  const toT = (v) => (v - m.min) / (m.max - m.min);
  vals.forEach((v, i) => {
    const x = GX + (i % COLS) * CELL, y = GY + Math.floor(i / COLS) * CELL;
    rect(px, x, y, x + CELL, y + CELL, m.fn(toT(v)));
  });
  for (let y = BAR.y0; y < BAR.y1; y++) rect(px, BAR.x0, y, BAR.x1, y + 1, m.fn(1 - (y - BAR.y0 + 0.5) / (BAR.y1 - BAR.y0)));
  const ticks = m.ticks.map((v) => {
    const y = Math.round(BAR.y1 - toT(v) * (BAR.y1 - BAR.y0));
    const yy = Math.min(BAR.y1 - 1, Math.max(BAR.y0, y - (v === m.max ? 0 : 0)));
    rect(px, BAR.x1, yy, BAR.x1 + 6, yy + 1, [0, 0, 0]);
    text(px, String(v), BAR.x1 + 10, yy - 10);
    return { value: v, y: yy };
  });
  writeFileSync(new URL(`${name}.png`, OUT), png(px));
  const csv = Array.from({ length: ROWS }, (_, r) => vals.slice(r * COLS, (r + 1) * COLS).join(',')).join('\n');
  writeFileSync(new URL(`${name}.csv`, OUT), csv + '\n');
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({
    colormap: name, kind: m.kind, size: [W, H], grid: { x0: GX, y0: GY, x1: GX + COLS * CELL, y1: GY + ROWS * CELL, rows: ROWS, cols: COLS },
    colorbar: { x0: BAR.x0, x1: BAR.x1, y0: BAR.y0, y1: BAR.y1, min: m.min, max: m.max }, ticks, values: vals,
  }, null, 1) + '\n');
}
console.log('wrote', Object.keys(MAPS).join(', '));
