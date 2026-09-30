(function (CM) {
  'use strict';
  const { effectiveLabels, ticksWithT } = CM;

  // Typed interface for software agents (LLMs, decision models such as Jev,
  // scripts). This file is pure: the action catalogue with JSON Schemas for
  // their arguments, a small validator, the state snapshot and the typed
  // questions an agent answers. agent.js binds it to a live workspace as
  // window.colormeris.
  //
  // Coordinates are image pixels of the panel's page image, as in project.json.
  // `t` is the position along the colorbar: 0 at `start`, 1 at `end`.

  const AGENT_SCHEMA = 'colormeris-agent';
  const AGENT_VERSION = 1;

  const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] };
  const pointOf = (description) => ({ ...point, description });
  const count = (description) => ({ type: 'integer', minimum: 1, maximum: 1000, description });
  const panelId = { type: 'string', description: 'Panel to act on. Defaults to the active panel; another panel is selected first (switching tool and page if needed).' };
  const labels = { type: 'array', items: { type: 'string' } };

  // name → {description, args (JSON Schema of the argument object), mutates}
  const ACTIONS = {
    get_state: { description: 'Snapshot of the source, panels, calibration and readiness. Cheap; call after every mutation.', args: { type: 'object', properties: {} } },
    get_results: { description: 'Extracted values of a panel: heatmap matrix with ΔE and flags, or IVIS region statistics.', args: { type: 'object', properties: { panelId } } },
    get_questions: { description: 'Open typed questions (decisions) about the current project, with evidence and answer schemas.', args: { type: 'object', properties: { panelId } } },
    answer_question: {
      description: 'Answer a question from get_questions. Answers below the policy confidence are logged and left for a human.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          answer: { description: 'Must match the question\'s answerSchema.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          source: { type: 'string', description: 'Who decided, e.g. "jev", "claude", "human".' },
          model: { type: 'string' },
        },
        required: ['questionId', 'answer'],
      },
    },
    sample_pixel: {
      description: 'Color at a point, its CIELAB value and, when the colorbar is calibrated, the matched value and ΔE.',
      args: {
        type: 'object',
        properties: {
          panelId,
          x: { type: 'number', description: 'Page pixel.' },
          y: { type: 'number', description: 'Page pixel.' },
          radius: { type: 'integer', minimum: 0, maximum: 20, description: 'Average a (2r+1)² square. Default 0.' },
        },
        required: ['x', 'y'],
      },
    },
    focus: { description: 'Zoom the viewer to points (for screenshot-based checking).', args: { type: 'object', properties: { points: { type: 'array', items: point, minItems: 1 } }, required: ['points'] } },

    open_url: { description: 'Open a PDF, PNG, JPG or project zip by URL (same origin or CORS-enabled).', mutates: true, args: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    set_tool: { description: 'Switch between the heatmap and IVIS tools.', mutates: true, args: { type: 'object', properties: { tool: { enum: ['heatmap', 'ivis'] } }, required: ['tool'] } },
    go_to_page: { description: 'Show a PDF page (1-based).', mutates: true, args: { type: 'object', properties: { page: { type: 'integer', minimum: 1 } }, required: ['page'] } },
    select_panel: { description: 'Make a panel active.', mutates: true, args: { type: 'object', properties: { panelId }, required: ['panelId'] } },
    add_panel: { description: 'Add a panel on the current page for the active tool and make it active.', mutates: true, args: { type: 'object', properties: { name: { type: 'string' } } } },
    rename_panel: { description: 'Rename a panel.', mutates: true, args: { type: 'object', properties: { panelId, name: { type: 'string', minLength: 1 } }, required: ['name'] } },

    set_grid: {
      description: 'Place the grid by its outer top-left and bottom-right corners, or by 4 corners (TL, TR, BR, BL) for skewed scans. Rows and columns are filled in automatically from the colors inside the grid, and a confirm_grid_size question opens. Precision matters: a few pixels off shifts every cell.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          topLeft: pointOf('Outer top-left corner of the top-left cell. Give with bottomRight.'),
          bottomRight: pointOf('Outer bottom-right corner of the bottom-right cell. Give with topLeft.'),
          corners: { type: 'array', items: point, minItems: 4, maxItems: 4, description: 'Instead of topLeft/bottomRight: all 4 outer corners, in order top-left, top-right, bottom-right, bottom-left.' },
        },
      },
    },
    detect_grid_size: { description: 'Guess rows and columns from the colors inside the placed grid, with confidences (below ~1.3 is uncertain). Does not change the panel.', args: { type: 'object', properties: { panelId } } },
    set_grid_size: { description: 'Set rows and columns.', mutates: true, args: { type: 'object', properties: { panelId, rows: count('Number of cell rows.'), cols: count('Number of cell columns.') }, required: ['rows', 'cols'] } },
    set_labels: {
      description: 'Row, column and (IVIS) box labels. Give at least one list.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          rows: { ...labels, description: 'Row labels, top to bottom.' },
          cols: { ...labels, description: 'Column labels, left to right.' },
          boxes: { ...labels, description: 'IVIS box names in reading order.' },
        },
      },
    },
    remove_grid: { description: 'Remove the grid.', mutates: true, args: { type: 'object', properties: { panelId } } },

    set_colorbar: {
      description: 'Place the colorbar ends along its middle. Existing ticks keep their t. Put both ends inside the colored strip, on the first and last color pixel, not on its black or grey outline.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          start: pointOf('One end of the colored strip, on its centre line. Just inside the border: the first pixel that shows the color, not the outline.'),
          end: pointOf('The other end, on the centre line, just inside the border (not on the outline).'),
          halfWidth: { type: 'number', minimum: 0, maximum: 50, description: 'Pixels averaged on each side of the line. Default 2; keep it inside the strip.' },
        },
        required: ['start', 'end'],
      },
    },
    add_tick: {
      description: 'Add a labelled tick on the placed colorbar. Give its position ONE way: `at` (the page point of the tick mark, projected onto the bar; preferred) or `t` (0 at start, 1 at end). Example: {"at": {"x": 606, "y": 822}, "value": 3}.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          at: pointOf('Page point of the tick mark. Use this or t, not both.'),
          t: { type: 'number', minimum: -0.1, maximum: 1.1, description: 'Position along the bar, 0 at start and 1 at end. Use this or at, not both.' },
          value: { type: 'number', description: 'The printed tick label as a number, with any ×10^n multiplier applied (e.g. 1.4e9).' },
        },
        required: ['value'],
      },
    },
    set_tick_value: { description: 'Change a tick\'s value.', mutates: true, args: { type: 'object', properties: { panelId, tickId: { type: 'string', description: 'From add_tick or get_state.' }, value: { type: 'number' } }, required: ['tickId', 'value'] } },
    remove_tick: { description: 'Remove a tick.', mutates: true, args: { type: 'object', properties: { panelId, tickId: { type: 'string', description: 'From add_tick or get_state.' } }, required: ['tickId'] } },
    set_colorbar_scale: { description: 'linear, or log10 when the tick labels are raw numbers on a logarithmic bar.', mutates: true, args: { type: 'object', properties: { panelId, scale: { enum: ['linear', 'log10'] } }, required: ['scale'] } },
    set_settings: {
      description: 'Matching settings.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          distance: { enum: ['de2000', 'de76'] },
          maxDeltaE: { type: 'number', minimum: 0 },
          grayChroma: { type: 'number', minimum: 0 },
          sampleFraction: { type: 'number', minimum: 0.05, maximum: 1 },
        },
      },
    },

    add_region: {
      description: 'IVIS: add a region in image pixels. ellipse/rect use {cx, cy, rx, ry} (rect rx/ry are half-extents); polygon uses {points}. With replicate (default) and a grid, it is copied into every box.',
      mutates: true,
      args: {
        type: 'object',
        properties: {
          panelId,
          shape: { enum: ['ellipse', 'rect', 'polygon'] },
          geom: {
            type: 'object',
            properties: { cx: { type: 'number' }, cy: { type: 'number' }, rx: { type: 'number', minimum: 0 }, ry: { type: 'number', minimum: 0 }, points: { type: 'array', items: point, minItems: 3 } },
          },
          name: { type: 'string' },
          replicate: { type: 'boolean' },
        },
        required: ['shape', 'geom'],
      },
    },
    remove_region: { description: 'IVIS: remove a region and all its copies.', mutates: true, args: { type: 'object', properties: { panelId, regionId: { type: 'string' } }, required: ['regionId'] } },
    set_scale_bar: {
      description: 'IVIS: a known distance between two points, for areas in real units.',
      mutates: true,
      args: { type: 'object', properties: { panelId, p1: point, p2: point, length: { type: 'number', exclusiveMinimum: 0 }, unit: { enum: ['cm', 'mm'] } }, required: ['p1', 'p2', 'length'] },
    },

    set_review: {
      description: 'Record a review of a panel\'s current extraction: accepted or rejected (with an optional note on what is wrong), or null to clear it. A rejected panel stays marked until it is accepted or its values change.',
      mutates: true,
      args: {
        type: 'object',
        properties: { panelId, status: { enum: ['accepted', 'rejected', null] }, note: { type: 'string' }, source: { type: 'string' } },
        required: ['status'],
      },
    },
    undo: { description: 'Undo the last change.', mutates: true, args: { type: 'object', properties: {} } },
    redo: { description: 'Redo.', mutates: true, args: { type: 'object', properties: {} } },
    export_project: { description: 'Download the project zip (includes agent/decisions.json).', args: { type: 'object', properties: {} } },
  };

  // Checks for what JSON Schema cannot express simply.
  const EXTRA_CHECKS = {
    set_grid: (a) =>
      a.corners ? null : a.topLeft && a.bottomRight ? null : 'give corners, or topLeft and bottomRight',
    add_tick: (a) => (a.at || Number.isFinite(a.t) ? null : 'give the tick position as at (page point of the tick mark), e.g. {"at": {"x": 606, "y": 822}, "value": 3}, or as t (0–1 along the bar)'),
    set_labels: (a) => (a.rows || a.cols || a.boxes ? null : 'give rows, cols or boxes'),
    add_region: (a) =>
      a.shape === 'polygon'
        ? Array.isArray(a.geom.points) && a.geom.points.length >= 3 ? null : 'polygon geom needs points (at least 3)'
        : [a.geom.cx, a.geom.cy, a.geom.rx, a.geom.ry].every(Number.isFinite) ? null : `${a.shape} geom needs cx, cy, rx, ry`,
  };

  // Validate a value against the subset of JSON Schema used here. Returns a
  // list of problems ("path: message"); empty when valid.
  function validate(schema, value, path = 'args') {
    const errs = [];
    if (!schema) return errs;
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join(', ')}`);
    const t = schema.type;
    if (t === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: must be an object`];
      for (const k of schema.required || []) if (value[k] === undefined) errs.push(`${path}.${k}: required`);
      for (const [k, v] of Object.entries(value)) {
        const sub = schema.properties?.[k];
        if (!sub) {
          if (schema.properties) errs.push(`${path}.${k}: unknown property`);
          continue;
        }
        errs.push(...validate(sub, v, `${path}.${k}`));
      }
    } else if (t === 'array') {
      if (!Array.isArray(value)) return [`${path}: must be an array`];
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} items`);
      value.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
    } else if (t === 'number' || t === 'integer') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: must be a finite number`];
      if (t === 'integer' && !Number.isInteger(value)) errs.push(`${path}: must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be ≤ ${schema.maximum}`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errs.push(`${path}: must be > ${schema.exclusiveMinimum}`);
    } else if (t === 'string') {
      if (typeof value !== 'string') return [`${path}: must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: too short`);
    } else if (t === 'boolean') {
      if (typeof value !== 'boolean') errs.push(`${path}: must be true or false`);
    }
    return errs;
  }

  // Forgive common LLM habits before validating: optional arguments sent as
  // null are dropped (unless null is a meaningful value), and add_tick with
  // both at and t uses at. Returns {args, notes}.
  function normalizeArgs(name, args) {
    const spec = ACTIONS[name];
    if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) return { args, notes: [] };
    const notes = [];
    const out = {};
    for (const [k, v] of Object.entries(args)) {
      const sub = spec.args.properties?.[k];
      if (v === null && !(sub?.enum || []).includes(null)) continue;
      out[k] = v;
    }
    if (name === 'add_tick' && out.at && out.t !== undefined) {
      delete out.t;
      notes.push('Both at and t were given; used at and ignored t. Next time give only one.');
    }
    return { args: out, notes };
  }

  function validateAction(name, args = {}) {
    const spec = ACTIONS[name];
    if (!spec) return [`unknown action "${name}"`];
    const errs = validate(spec.args, args);
    if (!errs.length && EXTRA_CHECKS[name]) {
      const e = EXTRA_CHECKS[name](args);
      if (e) errs.push(`args: ${e}`);
    }
    return errs;
  }

  // The catalogue in the tool-definition format LLM APIs take
  // ({name, description, input_schema}).
  function toolDefinitions() {
    return Object.entries(ACTIONS).map(([name, a]) => ({ name, description: a.description, input_schema: a.args }));
  }

  // ---------------------------------------------------------------- state

  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
  const pt = (p) => (p ? { x: r2(p.x), y: r2(p.y) } : null);

  // Plain JSON view of the workspace. `results` maps panel id → result (or
  // {error}); `problems` maps panel id → what is missing, or null.
  // `reviews` maps panel id → 'accepted' | 'rejected' | 'stale' (reviewed,
  // then changed) for panels with a review.
  function stateSnapshot({ project, tool, mode, activePanelId, problems, reviews = {}, canUndo, canRedo, openQuestions }) {
    const s = project.source;
    return {
      schema: AGENT_SCHEMA,
      version: AGENT_VERSION,
      tool,
      mode: mode ? { type: mode.type, points: mode.points.map(pt) } : null,
      source: s ? { fileName: s.fileName, page: s.page, pageCount: s.pageCount, width: s.width, height: s.height, dpi: Math.round(72 * s.renderScale) } : null,
      activePanelId,
      panels: project.panels.map((p) => panelSnapshot(p, problems[p.id], reviews[p.id])),
      history: { canUndo, canRedo },
      openQuestions,
    };
  }

  function panelSnapshot(p, problem, reviewStatus) {
    const g = p.grid;
    const cb = p.colorbar;
    const out = {
      id: p.id,
      name: p.name,
      page: p.page,
      tool: p.tool,
      ready: !problem,
      problem: problem || null,
      grid: g.corners
        ? {
            corners: g.corners.map(pt),
            rows: g.rows,
            cols: g.cols,
            sizeSource: g.autoSize ? 'detected' : 'set',
            sampleFraction: g.sampleFraction,
            rowLabels: effectiveLabels(g.rowLabels, g.rows, 'R'),
            colLabels: effectiveLabels(g.colLabels, g.cols, 'C'),
            ...(g.boxLabels?.length ? { boxLabels: [...g.boxLabels] } : {}),
          }
        : null,
      colorbar: {
        start: pt(cb.start),
        end: pt(cb.end),
        halfWidth: cb.halfWidth,
        scale: cb.scale,
        ticks: ticksWithT(cb).map((k) => ({ id: k.id, t: Number.isFinite(k.t) ? Math.round(k.t * 1e4) / 1e4 : null, value: Number.isFinite(k.value) ? k.value : null })),
      },
      settings: { ...p.settings },
      review: p.review ? { status: reviewStatus || p.review.status, by: p.review.by, confidence: p.review.confidence, note: p.review.note || null } : null,
    };
    if (p.tool === 'ivis') {
      out.regions = p.rois.map((r) => ({ id: r.id, name: r.name, shape: r.shape, replicate: r.replicate, nudged: Object.keys(r.offsets).length }));
      out.scaleBar = p.scale ? { p1: pt(p.scale.p1), p2: pt(p.scale.p2), length: p.scale.length, unit: p.scale.unit } : null;
    }
    return out;
  }

  // Heatmap result → agent JSON. Values stay at full precision.
  function heatmapResultJson(panel, result) {
    if (result.error) return { panelId: panel.id, error: result.error };
    const rowLabels = effectiveLabels(panel.grid.rowLabels, result.rows, 'R');
    const colLabels = effectiveLabels(panel.grid.colLabels, result.cols, 'C');
    const flagged = [];
    result.cells.forEach((row, r) => row.forEach((c, k) => c.flagged && flagged.push({ row: r, col: k, deltaE: r2(c.deltaE), rgb: [...c.rgb] })));
    return {
      panelId: panel.id,
      tool: 'heatmap',
      rowLabels,
      colLabels,
      values: result.cells.map((row) => row.map((c) => c.value)),
      deltaE: result.cells.map((row) => row.map((c) => r2(c.deltaE))),
      maxDeltaE: panel.settings.maxDeltaE,
      flagged,
    };
  }

  function ivisResultJson(panel, result, boxName) {
    if (result.error) return { panelId: panel.id, error: result.error };
    return {
      panelId: panel.id,
      tool: 'ivis',
      unit: result.unit,
      regions: result.rows.map((x) => ({
        regionId: x.roi.id,
        region: x.roi.name,
        box: x.row === null ? null : boxName(x.row, x.col),
        row: x.row,
        col: x.col,
        ...x.stats,
      })),
    };
  }

  // ---------------------------------------------------------------- questions

  // Typed questions: small decisions an agent (or a fast decision model) can
  // answer with a calibrated confidence. Each has an id that is stable while
  // its evidence is unchanged, the evidence, and a JSON Schema for the answer.
  //
  //   confirm_grid_size    after detection: {rows, cols}
  //   classify_flagged     heatmap cell far from every colorbar color:
  //                        'keep' | 'exclude' | 'recheck_colorbar'
  //   classify_flagged_cells  the same for all flagged cells of a panel at
  //                        once, when there are more than MAX_CELL_QUESTIONS:
  //                        'keep_all' | 'exclude_all' | 'recheck_colorbar'
  //   confirm_tick_order   ticks whose values do not increase along the bar:
  //                        'as_placed' | 'fix_needed'
  //   confirm_extraction   ready panel: 'accept' | 'reject'; applied, it sets
  //                        panel.review for the values as they are
  //
  // `detections` maps panel id → detectGridSize output (or undefined).
  function openQuestions({ panels, results, detections, decisions }) {
    const qs = [];
    const answered = new Set(decisions.filter((d) => d.applied).map((d) => d.questionId));
    const push = (q) => !answered.has(q.id) && qs.push(q);
    for (const p of panels) {
      const d = detections[p.id];
      if (p.grid.corners && p.grid.autoSize && d) {
        const conf = Math.min(d.rowConfidence, d.colConfidence);
        push({
          id: `grid:${p.id}:${d.rows}x${d.cols}:${cornerKey(p.grid.corners)}`,
          type: 'confirm_grid_size',
          panelId: p.id,
          prompt: 'How many rows and columns of cells does this heatmap grid have?',
          evidence: {
            detected: { rows: d.rows, cols: d.cols },
            rowConfidence: r2(d.rowConfidence),
            colConfidence: r2(d.colConfidence),
            uncertain: conf < 1.3 || d.rows === 1 || d.cols === 1,
            // Labels typed so far (e.g. read off the figure); 0 when none.
            labelCounts: { rows: nonEmpty(p.grid.rowLabels), cols: nonEmpty(p.grid.colLabels) },
          },
          answerSchema: { type: 'object', properties: { rows: { type: 'integer', minimum: 1, maximum: 1000 }, cols: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['rows', 'cols'] },
          suggested: { rows: d.rows, cols: d.cols },
        });
      }
      const ticks = ticksWithT(p.colorbar).filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value)).sort((a, b) => a.t - b.t);
      const dirs = new Set(ticks.slice(1).map((k, i) => Math.sign(k.value - ticks[i].value)));
      if (ticks.length >= 3 && dirs.size > 1) {
        push({
          id: `ticks:${p.id}:${ticks.map((k) => `${k.t.toFixed(3)}=${k.value}`).join(',')}`,
          type: 'confirm_tick_order',
          panelId: p.id,
          prompt: 'Tick values do not change monotonically along the colorbar. Is that how the figure is labelled?',
          evidence: { ticks: ticks.map((k) => ({ id: k.id, t: r2(k.t), value: k.value })) },
          answerSchema: { enum: ['as_placed', 'fix_needed'] },
        });
      }
      const res = results[p.id];
      if (!res || res.error) continue;
      const hash = resultKeyHash(res);
      if (p.tool === 'heatmap' && res.flagged.length > MAX_CELL_QUESTIONS) {
        // Many flagged cells usually mean one cause (often the colorbar), so
        // they get one question instead of one per cell.
        const des = res.flagged.map((f) => f.deltaE).sort((a, b) => a - b);
        push({
          id: `flags:${p.id}:${hash}`,
          type: 'classify_flagged_cells',
          panelId: p.id,
          prompt: `${res.flagged.length} of ${res.values.length * res.values[0].length} cells have colors far from every colorbar color. Keep them, exclude them, or recheck the colorbar?`,
          evidence: {
            count: res.flagged.length,
            total: res.values.length * res.values[0].length,
            medianDeltaE: des[Math.floor(des.length / 2)],
            maxDeltaE: des[des.length - 1],
            threshold: res.maxDeltaE,
            sampleColors: res.flagged.slice(0, 8).map((f) => f.rgb),
            cells: res.flagged.map((f) => ({ row: f.row, col: f.col })),
          },
          answerSchema: { enum: ['keep_all', 'exclude_all', 'recheck_colorbar'] },
        });
      } else if (p.tool === 'heatmap') {
        for (const f of res.flagged) {
          push({
            id: `flag:${p.id}:${f.row},${f.col}:${f.deltaE}`,
            type: 'classify_flagged',
            panelId: p.id,
            prompt: 'This cell\'s color is far from every colorbar color. Keep its value, exclude it, or recheck the colorbar?',
            evidence: { row: f.row, col: f.col, rowLabel: res.rowLabels[f.row], colLabel: res.colLabels[f.col], value: res.values[f.row][f.col], deltaE: f.deltaE, maxDeltaE: res.maxDeltaE, rgb: f.rgb },
            answerSchema: { enum: ['keep', 'exclude', 'recheck_colorbar'] },
          });
        }
      }
      if (p.review?.resultHash === hash) continue; // already accepted or rejected as it is
      push({
        id: `accept:${p.id}:${hash}`,
        type: 'confirm_extraction',
        panelId: p.id,
        resultHash: hash,
        prompt: 'Does the extraction look right (compare the reconstruction with the figure)?',
        evidence: p.tool === 'heatmap' ? { rows: res.values.length, cols: res.values[0].length, flaggedCount: res.flagged.length } : { regions: res.regions.length, flaggedPx: res.regions.reduce((s, x) => s + x.flaggedPx, 0) },
        answerSchema: { enum: ['accept', 'reject'] },
      });
    }
    return qs;
  }

  const MAX_CELL_QUESTIONS = 3;
  const nonEmpty = (labels) => labels.filter((l) => String(l).trim() !== '').length;
  const cornerKey = (cs) => cs.map((c) => `${Math.round(c.x)},${Math.round(c.y)}`).join(';');

  // Short, stable hash of a result's numbers (FNV-1a over its JSON).
  function resultKeyHash(res) {
    const s = JSON.stringify(res.values ?? res.regions);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16);
  }

  Object.assign(CM, {
    AGENT_SCHEMA,
    AGENT_VERSION,
    AGENT_ACTIONS: ACTIONS,
    validate,
    validateAction,
    normalizeArgs,
    toolDefinitions,
    stateSnapshot,
    heatmapResultJson,
    ivisResultJson,
    openQuestions,
    resultKeyHash,
  });
})((globalThis.Colormeris ??= {}));
