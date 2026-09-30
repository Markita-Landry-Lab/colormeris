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

  // `page` is the 1-based PDF page the panel's coordinates refer to (always 1
  // for images).
  function createPanel(name = 'Panel 1', page = 1) {
    return {
      id: newId(),
      name,
      page,
      grid: { corners: null, rows: 4, cols: 4, sampleFraction: 0.5, rowLabels: [], colLabels: [] },
      colorbar: { start: null, end: null, halfWidth: 2, nSamples: 256, ticks: [], scale: 'linear' },
      settings: { distance: 'de2000', maxDeltaE: 10 },
    };
  }

  function createProject() {
    const panel = createPanel();
    return { name: 'untitled', source: null, panels: [panel], activePanelId: panel.id };
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

  const round = (v) => Math.round(v * 1000) / 1000;
  const pt = (p) => (p ? { x: round(p.x), y: round(p.y) } : null);

  function serializeProject(project) {
    return {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
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
        },
        colorbar: {
          start: pt(p.colorbar.start),
          end: pt(p.colorbar.end),
          halfWidth: p.colorbar.halfWidth,
          nSamples: p.colorbar.nSamples,
          scale: p.colorbar.scale,
          ticks: ticksWithT(p.colorbar).map((k) => ({
            x: round(k.x),
            y: round(k.y),
            t: Number.isFinite(k.t) ? Math.round(k.t * 1e6) / 1e6 : null,
            value: k.value,
          })),
        },
        settings: { ...p.settings },
      })),
    };
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
      return p;
    });
    return {
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
  }

  Object.assign(CM, { SCHEMA, SCHEMA_VERSION, APP_VERSION, createPanel, createProject, effectiveLabels, parseLabelText, ticksWithT, serializeProject, parseProject, rescalePanel });
})((globalThis.Colormeris ??= {}));
