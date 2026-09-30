(function (CM) {
  'use strict';
  const {
    AGENT_ACTIONS, AGENT_SCHEMA, AGENT_VERSION, validate, validateAction, toolDefinitions, stateSnapshot, heatmapResultJson, ivisResultJson, openQuestions,
    createPanel, createRoi, rectCorners, detectGridSize, projectT, pointAtT, readPixel, rgbToLab, sampleColorbar, labToT, makeValueFn, ticksWithT, tickProblem,
    cellAt, centroid, geomToBox, boxLabel, fileKind,
  } = CM;

  // Agent API: binds the typed actions of agent-schema.js to a live workspace
  // and exposes them as window.colormeris, so an LLM or decision model can
  // drive the page without clicking pixels:
  //
  //   await colormeris.run('set_grid', {topLeft: {x: 40, y: 60}, bottomRight: {x: 520, y: 400}})
  //   → {ok: true, result, state}   or   {ok: false, error}
  //
  // Answers to typed questions carry a confidence. Below `policy.minConfidence`
  // an answer is logged but not applied, and the question stays open for a
  // human. Every mutating call and every decision is logged; both logs go into
  // the project zip (agent/actions.json, agent/decisions.json).

  function createAgentApi(ws) {
    const { app } = ws;
    const policy = { minConfidence: 0.9, humanSources: ['human'] };
    const actionLog = [];
    const decisions = [];

    const findPanel = (id) => app.project.panels.find((p) => p.id === id);
    const imageOf = (panel) => app.pages.get(panel.page)?.imageData;
    const needSource = () => {
      if (!app.sourceCanvas) throw new Error('No file is loaded. Use open_url first.');
    };

    // Make the panel active (switching tool and page as needed) and return it.
    async function usePanel(id) {
      needSource();
      if (!id) return ws.activePanel();
      const panel = findPanel(id);
      if (!panel) throw new Error(`No panel "${id}".`);
      if (panel.tool !== ws.tool().kind) ws.setTool(panel.tool, { quiet: true });
      if (panel.page !== ws.currentPage()) await ws.goToPage(panel.page, { keepActive: true });
      app.project.activePanelId = panel.id;
      ws.changed();
      return panel;
    }

    const problems = () => Object.fromEntries(app.project.panels.map((p) => [p.id, ws.resultFor(p).error || null]));

    function resultsJson(panel) {
      const res = ws.resultFor(panel);
      if (panel.tool === 'heatmap') {
        const out = heatmapResultJson(panel, res);
        const excluded = decisions.filter((d) => d.applied && d.type === 'classify_flagged' && d.panelId === panel.id && d.answer === 'exclude');
        if (!out.error) out.excluded = excluded.map((d) => ({ row: d.evidence.row, col: d.evidence.col }));
        return out;
      }
      return ivisResultJson(panel, res, (r, c) => boxLabel(panel.grid, r, c));
    }

    function questions(panelId) {
      const panels = app.project.panels.filter((p) => !panelId || p.id === panelId);
      const results = {};
      const detections = {};
      for (const p of panels) {
        const img = imageOf(p);
        if (p.grid.corners && p.grid.autoSize && img) detections[p.id] = detectGridSize(img, p.grid.corners);
        if (!ws.resultFor(p).error) results[p.id] = resultsJson(p);
      }
      return openQuestions({ panels, results, detections, decisions }).map((q) => {
        const last = [...decisions].reverse().find((d) => d.questionId === q.id);
        return last ? { ...q, escalated: { answer: last.answer, confidence: last.confidence, source: last.source } } : q;
      });
    }

    function state() {
      return stateSnapshot({
        project: app.project,
        tool: ws.tool().kind,
        mode: app.mode,
        activePanelId: app.sourceCanvas ? ws.activePanel().id : null,
        problems: problems(),
        canUndo: ws.canUndo(),
        canRedo: ws.canRedo(),
        openQuestions: app.sourceCanvas ? questions().length : 0,
      });
    }

    // Size from detection (autoSize) or as given.
    function applyGridSize(panel, rows, cols) {
      if (rows && cols) {
        panel.grid.rows = rows;
        panel.grid.cols = cols;
        panel.grid.autoSize = false;
        return null;
      }
      const d = detectGridSize(imageOf(panel), panel.grid.corners);
      panel.grid.rows = rows || d.rows;
      panel.grid.cols = cols || d.cols;
      panel.grid.autoSize = !rows && !cols;
      return d;
    }

    function applyAnswer(q, answer) {
      if (q.type === 'confirm_grid_size') {
        ws.commit((p) => applyGridSize(p, answer.rows, answer.cols));
      }
      // classify_flagged, confirm_tick_order and confirm_extraction are
      // recorded decisions; results report excluded cells from the log.
    }

    const handlers = {
      get_state: () => state(),
      get_results: async ({ panelId }) => resultsJson(await usePanel(panelId)),
      get_questions: ({ panelId }) => (needSource(), questions(panelId)),

      answer_question: async ({ questionId, answer, confidence = null, source = 'agent', model = null }) => {
        needSource();
        const q = questions().find((x) => x.id === questionId);
        if (!q) throw new Error(`No open question "${questionId}". Call get_questions again; questions change with the calibration.`);
        const errs = validate(q.answerSchema, answer, 'answer');
        if (errs.length) throw new Error(errs.join('; '));
        const human = policy.humanSources.includes(source);
        const applied = human || (confidence !== null && confidence >= policy.minConfidence);
        const d = { questionId, type: q.type, panelId: q.panelId, evidence: q.evidence, answer, confidence, source, model, applied, time: new Date().toISOString() };
        decisions.push(d);
        if (applied) {
          await usePanel(q.panelId);
          applyAnswer(q, answer);
        } else ws.toast(`Needs review: ${q.prompt} (${source} ${confidence === null ? 'gave no confidence' : `was ${Math.round(confidence * 100)}% sure`})`);
        return { applied, escalated: !applied };
      },

      sample_pixel: async ({ panelId, x, y, radius = 0 }) => {
        const panel = await usePanel(panelId);
        const img = imageOf(panel);
        const acc = [0, 0, 0];
        let n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const px = readPixel(img, x + dx, y + dy);
            for (let i = 0; i < 3; i++) acc[i] += px[i];
            n++;
          }
        }
        const rgb = acc.map((v) => Math.round(v / n));
        const lab = rgbToLab(rgb);
        const out = { rgb, lab: lab.map((v) => Math.round(v * 100) / 100) };
        const cb = panel.colorbar;
        if (cb.start && cb.end) {
          const samples = sampleColorbar(img, cb.start, cb.end, cb.halfWidth, cb.nSamples);
          const { t, deltaE } = labToT(lab, samples, panel.settings.distance);
          Object.assign(out, { t, deltaE });
          const ticks = ticksWithT(cb);
          if (!tickProblem(ticks, cb.scale)) out.value = makeValueFn(ticks, cb.scale)(t);
        }
        return out;
      },

      focus: ({ points }) => {
        needSource();
        ws.zoomToPoints(points);
        return null;
      },

      open_url: async ({ url }) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);
        const blob = await res.blob();
        const u = new URL(url, location.href);
        let name = u.protocol === 'data:' ? 'download' : decodeURIComponent(u.pathname.split('/').pop() || 'download');
        // Blob and data URLs have no extension; take it from the MIME type.
        const ext = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'application/zip': 'zip' }[blob.type];
        if (!/\.[a-z0-9]+$/i.test(name) && ext) name += `.${ext}`;
        const file = new File([blob], name, { type: blob.type });
        if (fileKind(file) === 'unknown') throw new Error(`Unsupported file type: ${name}`);
        await ws.openFile(file);
        if (!app.sourceCanvas) throw new Error(`Could not open ${name}.`);
        return null;
      },

      set_tool: ({ tool }) => {
        ws.setTool(tool);
        return null;
      },

      go_to_page: async ({ page }) => {
        needSource();
        if (page > app.project.source.pageCount) throw new Error(`The file has ${app.project.source.pageCount} page(s).`);
        await ws.goToPage(page);
        return null;
      },

      select_panel: async ({ panelId }) => (await usePanel(panelId), null),

      add_panel: ({ name }) => {
        needSource();
        const active = ws.activePanel();
        const panel = createPanel(name || `Panel ${app.project.panels.length + 1}`, ws.currentPage(), ws.tool().kind);
        panel.settings = { ...active.settings };
        ws.pushHistory();
        app.project.panels.push(panel);
        app.project.activePanelId = panel.id;
        ws.changed();
        return { panelId: panel.id };
      },

      rename_panel: async ({ panelId, name }) => {
        await usePanel(panelId);
        ws.commit((p) => (p.name = name));
        return null;
      },

      set_grid: async ({ panelId, topLeft, bottomRight, corners, rows, cols }) => {
        await usePanel(panelId);
        const cs = corners || rectCorners(topLeft, bottomRight);
        const w = Math.hypot(cs[1].x - cs[0].x, cs[1].y - cs[0].y);
        const h = Math.hypot(cs[3].x - cs[0].x, cs[3].y - cs[0].y);
        if (w < 2 || h < 2) throw new Error('Grid is too small.');
        let detected = null;
        ws.commit((p) => {
          p.grid.corners = cs;
          detected = applyGridSize(p, rows, cols);
        });
        return detected && { detected: { rows: detected.rows, cols: detected.cols, rowConfidence: detected.rowConfidence, colConfidence: detected.colConfidence } };
      },

      detect_grid_size: async ({ panelId }) => {
        const panel = await usePanel(panelId);
        if (!panel.grid.corners) throw new Error('Place the grid first (set_grid).');
        return detectGridSize(imageOf(panel), panel.grid.corners);
      },

      set_grid_size: async ({ panelId, rows, cols }) => {
        await usePanel(panelId);
        ws.commit((p) => applyGridSize(p, rows, cols));
        return null;
      },

      set_labels: async ({ panelId, rows, cols, boxes }) => {
        await usePanel(panelId);
        ws.commit((p) => {
          if (rows) p.grid.rowLabels = [...rows];
          if (cols) p.grid.colLabels = [...cols];
          if (boxes) p.grid.boxLabels = [...boxes];
        });
        return null;
      },

      remove_grid: async ({ panelId }) => {
        await usePanel(panelId);
        ws.commit((p) => (p.grid.corners = null));
        return null;
      },

      set_colorbar: async ({ panelId, start, end, halfWidth }) => {
        await usePanel(panelId);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 3) throw new Error('Colorbar is too short.');
        ws.commit((p) => {
          const cb = p.colorbar;
          const ts = cb.start && cb.end ? cb.ticks.map((k) => projectT(cb.start, cb.end, k)) : null;
          cb.start = { ...start };
          cb.end = { ...end };
          if (halfWidth !== undefined) cb.halfWidth = halfWidth;
          if (ts) cb.ticks.forEach((k, i) => Object.assign(k, pointAtT(cb.start, cb.end, ts[i])));
        });
        return null;
      },

      add_tick: async ({ panelId, t, at, value }) => {
        const panel = await usePanel(panelId);
        const { start, end } = panel.colorbar;
        if (!start || !end) throw new Error('Place the colorbar first (set_colorbar).');
        const tt = at ? projectT(start, end, at) : t;
        if (tt < -0.1 || tt > 1.1) throw new Error(`That point is off the colorbar (t = ${tt.toFixed(2)}).`);
        const id = ws.newTickId();
        ws.commit((p) => p.colorbar.ticks.push({ id, ...pointAtT(start, end, tt), value }));
        return { tickId: id, t: tt };
      },

      set_tick_value: async ({ panelId, tickId, value }) => {
        const panel = await usePanel(panelId);
        if (!panel.colorbar.ticks.some((k) => k.id === tickId)) throw new Error(`No tick "${tickId}".`);
        ws.commit((p) => (p.colorbar.ticks.find((k) => k.id === tickId).value = value));
        return null;
      },

      remove_tick: async ({ panelId, tickId }) => {
        const panel = await usePanel(panelId);
        if (!panel.colorbar.ticks.some((k) => k.id === tickId)) throw new Error(`No tick "${tickId}".`);
        ws.commit((p) => (p.colorbar.ticks = p.colorbar.ticks.filter((k) => k.id !== tickId)));
        return null;
      },

      set_colorbar_scale: async ({ panelId, scale }) => {
        await usePanel(panelId);
        ws.commit((p) => (p.colorbar.scale = scale));
        return null;
      },

      set_settings: async ({ panelId, sampleFraction, ...settings }) => {
        await usePanel(panelId);
        ws.commit((p) => {
          Object.assign(p.settings, settings);
          if (sampleFraction !== undefined) p.grid.sampleFraction = sampleFraction;
        });
        return null;
      },

      add_region: async ({ panelId, shape, geom, name, replicate = true }) => {
        const panel = await usePanel(panelId);
        if (panel.tool !== 'ivis') throw new Error('Regions belong to IVIS panels; use set_tool first.');
        const px = shape === 'polygon' ? { points: geom.points.map((q) => ({ x: q.x, y: q.y })) } : { cx: geom.cx, cy: geom.cy, rx: geom.rx, ry: geom.ry };
        const grid = panel.grid;
        const cell = replicate && grid.corners ? cellAt(grid, shape === 'polygon' ? centroid(px.points) : { x: px.cx, y: px.cy }) : null;
        const label = name || `ROI ${panel.rois.length + 1}`;
        const roi = cell ? createRoi(shape, geomToBox(shape, px, grid, cell.row, cell.col), { name: label }) : createRoi(shape, px, { name: label, replicate: false });
        ws.commit((p) => p.rois.push(roi));
        return { regionId: roi.id, replicated: !!cell };
      },

      remove_region: async ({ panelId, regionId }) => {
        const panel = await usePanel(panelId);
        if (!panel.rois.some((r) => r.id === regionId)) throw new Error(`No region "${regionId}".`);
        ws.commit((p) => (p.rois = p.rois.filter((r) => r.id !== regionId)));
        return null;
      },

      set_scale_bar: async ({ panelId, p1, p2, length, unit = 'cm' }) => {
        const panel = await usePanel(panelId);
        if (panel.tool !== 'ivis') throw new Error('The scale bar belongs to IVIS panels.');
        if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 3) throw new Error('Scale bar is too short.');
        ws.commit((p) => (p.scale = { p1: { ...p1 }, p2: { ...p2 }, length, unit }));
        return null;
      },

      undo: () => (ws.undo(), null),
      redo: () => (ws.redo(), null),
      export_project: async () => (needSource(), await ws.exportZip(), null),
    };

    // Run one action. Never throws; mutating actions also return the new state.
    async function run(name, args = {}) {
      const errs = validateAction(name, args);
      if (errs.length) return { ok: false, error: errs.join('; ') };
      const spec = AGENT_ACTIONS[name];
      try {
        if (spec.mutates && app.mode) ws.setMode(null);
        const result = await handlers[name](args);
        if (spec.mutates) actionLog.push({ action: name, args, ok: true, time: new Date().toISOString() });
        return spec.mutates ? { ok: true, result: result ?? null, state: state() } : { ok: true, result: result ?? null };
      } catch (err) {
        if (spec.mutates) actionLog.push({ action: name, args, ok: false, error: err.message, time: new Date().toISOString() });
        return { ok: false, error: err.message };
      }
    }

    // Run actions in order, stopping at the first failure.
    async function batch(actions) {
      const out = [];
      for (const { name, args } of actions) {
        const r = await run(name, args);
        out.push({ name, ...r });
        if (!r.ok) break;
      }
      return out;
    }

    ws.zipExtras.push(() => [
      { path: 'agent/actions.json', content: JSON.stringify({ schema: AGENT_SCHEMA, version: AGENT_VERSION, actions: actionLog }, null, 2) },
      { path: 'agent/decisions.json', content: JSON.stringify({ schema: AGENT_SCHEMA, version: AGENT_VERSION, policy, decisions }, null, 2) },
    ]);

    return {
      version: AGENT_VERSION,
      run,
      batch,
      tools: toolDefinitions,
      policy,
      log: () => ({ actions: [...actionLog], decisions: [...decisions] }),
    };
  }

  Object.assign(CM, { createAgentApi });
})((globalThis.Colormeris ??= {}));
