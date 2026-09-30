// Heatmap grid geometry and pixel sampling.
// A grid is defined by four outer corners in image pixel space, ordered
// [topLeft, topRight, bottomRight, bottomLeft]. Points inside the grid are
// addressed with normalized (u, v) in [0, 1]², u along columns, v along rows.

export function rectCorners(p1, p2) {
  const x0 = Math.min(p1.x, p2.x);
  const x1 = Math.max(p1.x, p2.x);
  const y0 = Math.min(p1.y, p2.y);
  const y1 = Math.max(p1.y, p2.y);
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function bilinear(corners, u, v) {
  const [tl, tr, br, bl] = corners;
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = u * v;
  const d = (1 - u) * v;
  return {
    x: a * tl.x + b * tr.x + c * br.x + d * bl.x,
    y: a * tl.y + b * tr.y + c * br.y + d * bl.y,
  };
}

// Inverse bilinear mapping by Newton iteration. Returns {u, v}; values
// outside [0, 1] mean the point lies outside the grid.
export function invertBilinear(corners, p) {
  const [tl, tr, br, bl] = corners;
  let u = 0.5;
  let v = 0.5;
  for (let i = 0; i < 20; i++) {
    const q = bilinear(corners, u, v);
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    if (Math.abs(ex) < 1e-6 && Math.abs(ey) < 1e-6) break;
    const dxdu = (1 - v) * (tr.x - tl.x) + v * (br.x - bl.x);
    const dydu = (1 - v) * (tr.y - tl.y) + v * (br.y - bl.y);
    const dxdv = (1 - u) * (bl.x - tl.x) + u * (br.x - tr.x);
    const dydv = (1 - u) * (bl.y - tl.y) + u * (br.y - tr.y);
    const det = dxdu * dydv - dxdv * dydu;
    if (Math.abs(det) < 1e-12) break;
    u -= (ex * dydv - ey * dxdv) / det;
    v -= (ey * dxdu - ex * dydu) / det;
  }
  return { u, v };
}

export function cellAt(grid, p) {
  const { u, v } = invertBilinear(grid.corners, p);
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  return { row: Math.floor(v * grid.rows), col: Math.floor(u * grid.cols) };
}

// Normalized bounds of the sampled (central) part of a cell.
export function cellSampleBounds(grid, row, col) {
  const f = grid.sampleFraction;
  const u0 = (col + 0.5 - f / 2) / grid.cols;
  const u1 = (col + 0.5 + f / 2) / grid.cols;
  const v0 = (row + 0.5 - f / 2) / grid.rows;
  const v1 = (row + 0.5 + f / 2) / grid.rows;
  return { u0, u1, v0, v1 };
}

export function cellSamplePolygon(grid, row, col) {
  const { u0, u1, v0, v1 } = cellSampleBounds(grid, row, col);
  return [
    bilinear(grid.corners, u0, v0),
    bilinear(grid.corners, u1, v0),
    bilinear(grid.corners, u1, v1),
    bilinear(grid.corners, u0, v1),
  ];
}

// Read one pixel as [r, g, b], compositing transparency onto white.
export function readPixel(img, x, y) {
  const xi = Math.min(img.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(img.height - 1, Math.max(0, Math.round(y)));
  const i = (yi * img.width + xi) * 4;
  const d = img.data;
  const a = d[i + 3] / 255;
  if (a >= 1) return [d[i], d[i + 1], d[i + 2]];
  return [d[i] * a + 255 * (1 - a), d[i + 1] * a + 255 * (1 - a), d[i + 2] * a + 255 * (1 - a)];
}

function median(values) {
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
}

// Per-channel median color over the central part of a cell. Sampling density
// is roughly one sample per image pixel.
export function sampleCell(img, grid, row, col) {
  const { u0, u1, v0, v1 } = cellSampleBounds(grid, row, col);
  const c = grid.corners;
  const width = Math.max(
    Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y),
    Math.hypot(c[2].x - c[3].x, c[2].y - c[3].y),
  );
  const height = Math.max(
    Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y),
    Math.hypot(c[2].x - c[1].x, c[2].y - c[1].y),
  );
  const nu = Math.max(1, Math.ceil(width * (u1 - u0)));
  const nv = Math.max(1, Math.ceil(height * (v1 - v0)));
  const rs = [];
  const gs = [];
  const bs = [];
  for (let j = 0; j < nv; j++) {
    const v = v0 + ((j + 0.5) / nv) * (v1 - v0);
    for (let i = 0; i < nu; i++) {
      const u = u0 + ((i + 0.5) / nu) * (u1 - u0);
      const p = bilinear(c, u, v);
      const [r, g, b] = readPixel(img, p.x, p.y);
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }
  return [median(rs), median(gs), median(bs)];
}
