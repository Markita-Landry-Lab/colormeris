(function (CM) {
  'use strict';
  const { bilinear, invertBilinear } = CM;

  // Regions of interest (ROIs) for image quantification.
  //
  // An ROI is {id, name, shape: 'ellipse' | 'rect' | 'polygon', replicate,
  // geom, offsets}. Ellipses and rects use geom {cx, cy, rx, ry} (a rect's rx/ry
  // are half-extents); polygons use geom {points: [{x, y}]}.
  //
  // A replicated ROI is copied into every box of a grid. Its geom is then in
  // box coordinates: a box spans [0, 1]² with x along columns and y along rows,
  // and offsets[`${row},${col}`] = {dx, dy} nudges the copy in one box. A
  // non-replicated ROI's geom is in image pixels.

  const ELLIPSE_POINTS = 72;

  // Polygon outline of the shape in its own coordinates.
  function shapeOutline(roi) {
    const g = roi.geom;
    if (roi.shape === 'polygon') return g.points.map((p) => ({ x: p.x, y: p.y }));
    if (roi.shape === 'rect') {
      return [
        { x: g.cx - g.rx, y: g.cy - g.ry },
        { x: g.cx + g.rx, y: g.cy - g.ry },
        { x: g.cx + g.rx, y: g.cy + g.ry },
        { x: g.cx - g.rx, y: g.cy + g.ry },
      ];
    }
    const out = [];
    for (let i = 0; i < ELLIPSE_POINTS; i++) {
      const a = (2 * Math.PI * i) / ELLIPSE_POINTS;
      out.push({ x: g.cx + g.rx * Math.cos(a), y: g.cy + g.ry * Math.sin(a) });
    }
    return out;
  }

  const offsetKey = (row, col) => `${row},${col}`;

  function boxOffset(roi, row, col) {
    return roi.offsets?.[offsetKey(row, col)] || { dx: 0, dy: 0 };
  }

  // Map a point in box coordinates of box (row, col) to image pixels.
  function fromBox(grid, p, row, col) {
    return bilinear(grid.corners, (p.x + col) / grid.cols, (p.y + row) / grid.rows);
  }

  // Map an image point to box coordinates of box (row, col).
  function toBox(grid, p, row, col) {
    const { u, v } = invertBilinear(grid.corners, p);
    return { x: u * grid.cols - col, y: v * grid.rows - row };
  }

  // Every placed copy of an ROI: [{row, col, outline}] with outlines in image
  // pixels. A replicated ROI without a grid has no copies.
  function roiInstances(roi, grid) {
    const outline = shapeOutline(roi);
    if (!roi.replicate) return [{ row: null, col: null, outline }];
    if (!grid?.corners) return [];
    const out = [];
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const { dx, dy } = boxOffset(roi, row, col);
        out.push({ row, col, outline: outline.map((p) => fromBox(grid, { x: p.x + dx, y: p.y + dy }, row, col)) });
      }
    }
    return out;
  }

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // Calls fn(x, y) for every pixel whose centre lies inside the polygon.
  function forEachPixelInPolygon(poly, width, height, fn) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of poly) {
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    const ys = Math.max(0, Math.floor(y0));
    const ye = Math.min(height - 1, Math.ceil(y1));
    const xs = Math.max(0, Math.floor(x0));
    const xe = Math.min(width - 1, Math.ceil(x1));
    for (let y = ys; y <= ye; y++) {
      // Scanline: collect crossings of the row through pixel centres.
      const cy = y + 0.5;
      const xsCross = [];
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i];
        const b = poly[j];
        if (a.y > cy !== b.y > cy) xsCross.push(((b.x - a.x) * (cy - a.y)) / (b.y - a.y) + a.x);
      }
      xsCross.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xsCross.length; k += 2) {
        const from = Math.max(xs, Math.ceil(xsCross[k] - 0.5));
        const to = Math.min(xe, Math.ceil(xsCross[k + 1] - 0.5) - 1);
        for (let x = from; x <= to; x++) fn(x, y);
      }
    }
  }

  function polygonArea(poly) {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    return Math.abs(a) / 2;
  }

  function centroid(poly) {
    let x = 0;
    let y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    return { x: x / poly.length, y: y / poly.length };
  }

  // Build ROI geometry from a drag between two image points: an ellipse or rect
  // inscribed in the dragged box; `equal` (Shift) makes it a circle/square.
  function boxGeom(a, b, equal) {
    let w = (b.x - a.x) / 2;
    let h = (b.y - a.y) / 2;
    if (equal) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * s;
      h = Math.sign(h || 1) * s;
    }
    return { cx: a.x + w, cy: a.y + h, rx: Math.abs(w), ry: Math.abs(h) };
  }

  // Convert geometry drawn in image pixels to box coordinates of (row, col).
  function geomToBox(shape, geom, grid, row, col) {
    if (shape === 'polygon') return { points: geom.points.map((p) => toBox(grid, p, row, col)) };
    const c = toBox(grid, { x: geom.cx, y: geom.cy }, row, col);
    const ex = toBox(grid, { x: geom.cx + geom.rx, y: geom.cy }, row, col);
    const ey = toBox(grid, { x: geom.cx, y: geom.cy + geom.ry }, row, col);
    return { cx: c.x, cy: c.y, rx: Math.abs(ex.x - c.x), ry: Math.abs(ey.y - c.y) };
  }

  Object.assign(CM, {
    shapeOutline,
    offsetKey,
    boxOffset,
    fromBox,
    toBox,
    roiInstances,
    pointInPolygon,
    forEachPixelInPolygon,
    polygonArea,
    centroid,
    boxGeom,
    geomToBox,
  });
})((globalThis.Colormeris ??= {}));
