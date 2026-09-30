(function (CM) {
  'use strict';
  const { projectT } = CM;

  // Project model and its JSON (de)serialization. All coordinates are in the
  // pixel space of the rendered source image (source.width × source.height).


  const SCHEMA = 'colormeris-project';
  const SCHEMA_VERSION = 1;
  const APP_VERSION = '0.1.0';

  let nextId = 1;
  const newId = () => `p${nextId++}`;
  let nextRoiId = 1;
  const newRoiId = () => `r${nextRoiId++}`;
  const KINDS = ['heatmap', 'ivis'];
  const SHAPES = ['ellipse', 'rect', 'polygon'];
  const SCALE_UNITS = ['cm', 'mm'];

  // `page` is the 1-based PDF page the panel's coordinates refer to (always 1
  // for images). `rois` and `scale` are used by the IVIS tool (see roi.js);
  // `settings.grayChroma` is its background threshold (CIELAB chroma).
  function createPanel(name = 'Panel 1', page = 1) {
    return {
      id: newId(),
      name,
      page,
      grid: { corners: null, rows: 4, cols: 4, sampleFraction: 0.5, rowLabels: [], colLabels: [], boxLabels: [] },
      colorbar: { start: null, end: null, halfWidth: 2, nSamples: 256, ticks: [], scale: 'linear' },
      settings: { distance: 'de2000', maxDeltaE: 10, grayChroma: 10 },
      rois: [],
      scale: null,
    };
  }

  // `kind` names the tool that owns the project: 'heatmap' or 'ivis'.
  function createProject(kind = 'heatmap') {
    const panel = createPanel();
    // IVIS photos carry JPEG color noise up to about chroma 20 (measured on
    // Fig. 1k of the example paper), and blended overlay edges sit further from
    // the colorbar colors than heatmap cells do.
    if (kind === 'ivis') Object.assign(panel.settings, { grayChroma: 20, maxDeltaE: 20 });
    return { kind, name: 'untitled', source: null, panels: [panel], activePanelId: panel.id };
  }

  function createRoi(shape, geom, { name = 'ROI', replicate = true } = {}) {
    return { id: newRoiId(), name, shape, replicate, geom, offsets: {} };
  }

  // Labels padded with defaults ("R1", "C1", ...) to the grid size.
  function effectiveLabels(labels, count, prefix) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const l = labels[i];
      out.push(l !== undefined && String(l).trim() !== '' ? String(l).trim() : `${prefix}${i + 1}`);
    }
    return out;
  }

  // Name of box (row, col): its own label in reading order if given, else
  // "<row label> <col label>".
  function boxLabel(grid, row, col) {
    const own = grid.boxLabels?.[row * grid.cols + col];
    if (own !== undefined && String(own).trim() !== '') return String(own).trim();
    return `${effectiveLabels(grid.rowLabels, grid.rows, 'R')[row]} ${effectiveLabels(grid.colLabels, grid.cols, 'C')[col]}`;
  }

  function parseLabelText(text) {
    const trimmed = text.trim();
    if (!trimmed) return [];
    const parts = trimmed.includes('\n') ? trimmed.split(/\r?\n/) : trimmed.split(/[,\t]/);
    return parts.map((s) => s.trim());
  }

  function ticksWithT(colorbar) {
    const { start, end } = colorbar;
    return colorbar.ticks.map((k) => ({ ...k, t: start && end ? projectT(start, end, k) : NaN }));
  }

  // Coordinates are stored at full precision: rounding them would move sample
  // positions and change re-extracted values in the last digits.
  const pt = (p) => (p ? { x: p.x, y: p.y } : null);

  function serializeProject(project) {
    return {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      kind: project.kind || 'heatmap',
      name: project.name,
      source: project.source ? { ...project.source } : null,
      panels: project.panels.map((p) => ({
        name: p.name,
        page: p.page,
        grid: {
          corners: p.grid.corners ? p.grid.corners.map(pt) : null,
          rows: p.grid.rows,
          cols: p.grid.cols,
          sampleFraction: p.grid.sampleFraction,
          rowLabels: effectiveLabels(p.grid.rowLabels, p.grid.rows, 'R'),
          colLabels: effectiveLabels(p.grid.colLabels, p.grid.cols, 'C'),
          ...(p.grid.boxLabels?.length ? { boxLabels: [...p.grid.boxLabels] } : {}),
        },
        colorbar: {
          start: pt(p.colorbar.start),
          end: pt(p.colorbar.end),
          halfWidth: p.colorbar.halfWidth,
          nSamples: p.colorbar.nSamples,
          scale: p.colorbar.scale,
          ticks: ticksWithT(p.colorbar).map((k) => ({
            x: k.x,
            y: k.y,
            t: Number.isFinite(k.t) ? Math.round(k.t * 1e6) / 1e6 : null,
            value: k.value,
          })),
        },
        settings: { ...p.settings },
        ...(project.kind === 'ivis'
          ? {
              rois: p.rois.map((r) => ({
                name: r.name,
                shape: r.shape,
                replicate: r.replicate,
                geom: serializeGeom(r),
                offsets: Object.fromEntries(Object.entries(r.offsets).map(([k, o]) => [k, { dx: o.dx, dy: o.dy }])),
              })),
              scale: p.scale ? { p1: pt(p.scale.p1), p2: pt(p.scale.p2), length: p.scale.length, unit: p.scale.unit } : null,
            }
          : {}),
      })),
    };
  }

  function serializeGeom(r) {
    if (r.shape === 'polygon') return { points: r.geom.points.map(pt) };
    return { cx: r.geom.cx, cy: r.geom.cy, rx: r.geom.rx, ry: r.geom.ry };
  }

  function readRoi(raw, where) {
    if (!raw || typeof raw !== 'object' || !SHAPES.includes(raw.shape)) fail(`bad region in ${where}`);
    const g = raw.geom || {};
    let geom;
    if (raw.shape === 'polygon') {
      if (!Array.isArray(g.points) || g.points.length < 3) fail(`polygon in ${where} needs at least 3 points`);
      geom = { points: g.points.map((q) => readPoint(q, where)) };
    } else {
      if (![g.cx, g.cy, g.rx, g.ry].every(Number.isFinite)) fail(`bad ${raw.shape} in ${where}`);
      geom = { cx: g.cx, cy: g.cy, rx: Math.abs(g.rx), ry: Math.abs(g.ry) };
    }
    const offsets = {};
    for (const [k, o] of Object.entries(raw.offsets || {})) {
      if (/^\d+,\d+$/.test(k) && Number.isFinite(o?.dx) && Number.isFinite(o?.dy)) offsets[k] = { dx: o.dx, dy: o.dy };
    }
    return { ...createRoi(raw.shape, geom, { name: typeof raw.name === 'string' ? raw.name : 'ROI', replicate: raw.replicate !== false }), offsets };
  }

  function fail(msg) {
    throw new Error(`Invalid project file: ${msg}`);
  }

  function readPoint(p, where) {
    if (p === null || p === undefined) return null;
    if (typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) fail(`bad point in ${where}`);
    return { x: p.x, y: p.y };
  }

  function readInt(v, def, min, max) {
    const n = Number.isInteger(v) ? v : def;
    return Math.min(max, Math.max(min, n));
  }

  function parseProject(json) {
    if (!json || typeof json !== 'object') fail('not a JSON object');
    if (json.schema !== SCHEMA) fail(`expected schema "${SCHEMA}"`);
    if (!Number.isInteger(json.version) || json.version > SCHEMA_VERSION) {
      fail(`unsupported version ${json.version}; this app reads up to ${SCHEMA_VERSION}`);
    }
    if (!Array.isArray(json.panels) || json.panels.length === 0) fail('no panels');
    // Files written before there were two tools are heatmap projects.
    const kind = KINDS.includes(json.kind) ? json.kind : 'heatmap';
    const panels = json.panels.map((raw, i) => {
      // Version 1 files written before panels had pages refer to source.page.
      const page = Number.isInteger(raw.page) && raw.page >= 1 ? raw.page : json.source?.page || 1;
      const p = createPanel(typeof raw.name === 'string' ? raw.name : `Panel ${i + 1}`, page);
      const g = raw.grid || {};
      if (g.corners !== null && g.corners !== undefined) {
        if (!Array.isArray(g.corners) || g.corners.length !== 4) fail(`panel ${i + 1} grid needs 4 corners`);
        p.grid.corners = g.corners.map((c) => readPoint(c, `panel ${i + 1} grid`));
      }
      p.grid.rows = readInt(g.rows, 4, 1, 1000);
      p.grid.cols = readInt(g.cols, 4, 1, 1000);
      if (Number.isFinite(g.sampleFraction)) p.grid.sampleFraction = Math.min(1, Math.max(0.05, g.sampleFraction));
      p.grid.rowLabels = Array.isArray(g.rowLabels) ? g.rowLabels.map(String) : [];
      p.grid.colLabels = Array.isArray(g.colLabels) ? g.colLabels.map(String) : [];
      p.grid.boxLabels = Array.isArray(g.boxLabels) ? g.boxLabels.map(String) : [];
      const cb = raw.colorbar || {};
      p.colorbar.start = readPoint(cb.start, `panel ${i + 1} colorbar`);
      p.colorbar.end = readPoint(cb.end, `panel ${i + 1} colorbar`);
      if (Number.isFinite(cb.halfWidth)) p.colorbar.halfWidth = Math.max(0, cb.halfWidth);
      if (Number.isInteger(cb.nSamples)) p.colorbar.nSamples = Math.min(4096, Math.max(2, cb.nSamples));
      p.colorbar.scale = cb.scale === 'log10' ? 'log10' : 'linear';
      p.colorbar.ticks = (Array.isArray(cb.ticks) ? cb.ticks : []).map((k) => {
        const q = readPoint(k, `panel ${i + 1} tick`);
        return { x: q.x, y: q.y, value: Number(k.value) };
      });
      const s = raw.settings || {};
      p.settings.distance = s.distance === 'de76' ? 'de76' : 'de2000';
      if (Number.isFinite(s.maxDeltaE)) p.settings.maxDeltaE = s.maxDeltaE;
      if (Number.isFinite(s.grayChroma)) p.settings.grayChroma = Math.max(0, s.grayChroma);
      if (kind === 'ivis') {
        p.rois = (Array.isArray(raw.rois) ? raw.rois : []).map((r, j) => readRoi(r, `panel ${i + 1} region ${j + 1}`));
        const sc = raw.scale;
        if (sc && typeof sc === 'object') {
          const p1 = readPoint(sc.p1, `panel ${i + 1} scale`);
          const p2 = readPoint(sc.p2, `panel ${i + 1} scale`);
          if (p1 && p2 && sc.length > 0) p.scale = { p1, p2, length: Number(sc.length), unit: SCALE_UNITS.includes(sc.unit) ? sc.unit : 'cm' };
        }
      }
      return p;
    });
    return {
      kind,
      name: typeof json.name === 'string' ? json.name : 'untitled',
      source: json.source && typeof json.source === 'object' ? { ...json.source } : null,
      panels,
      activePanelId: panels[0].id,
    };
  }

  // Scale every coordinate of a panel, e.g. after re-rendering a PDF page at a
  // different resolution.
  function rescalePanel(panel, factor) {
    const s = (p) => (p ? { x: p.x * factor, y: p.y * factor } : null);
    if (panel.grid.corners) panel.grid.corners = panel.grid.corners.map(s);
    panel.colorbar.start = s(panel.colorbar.start);
    panel.colorbar.end = s(panel.colorbar.end);
    panel.colorbar.ticks = panel.colorbar.ticks.map((k) => ({ ...k, ...s(k) }));
    panel.colorbar.halfWidth *= factor;
    if (panel.scale) panel.scale = { ...panel.scale, p1: s(panel.scale.p1), p2: s(panel.scale.p2) };
    // Replicated regions are in box coordinates and follow the grid; the others are in pixels.
    for (const r of panel.rois) {
      if (r.replicate) continue;
      if (r.shape === 'polygon') r.geom = { points: r.geom.points.map(s) };
      else r.geom = { cx: r.geom.cx * factor, cy: r.geom.cy * factor, rx: r.geom.rx * factor, ry: r.geom.ry * factor };
    }
  }

  Object.assign(CM, { SCHEMA, SCHEMA_VERSION, APP_VERSION, KINDS, createPanel, createProject, createRoi, effectiveLabels, boxLabel, parseLabelText, ticksWithT, serializeProject, parseProject, rescalePanel });
})((globalThis.Colormeris ??= {}));
