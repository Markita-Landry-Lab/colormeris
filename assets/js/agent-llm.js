(function (CM) {
  'use strict';
  const { AGENT_ACTIONS, validate } = CM;

  // Pure parts of the extraction agent (agent-runner.js runs it): the system
  // prompt, the tools the LLM sees, how typed questions become requests to a
  // decision model (Jev) and back, and trimming old images from the
  // conversation. Messages use the OpenRouter SDK's camelCase shapes.

  const DEFAULT_LLM = 'anthropic/claude-sonnet-5.5';
  const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';

  const SYSTEM_PROMPT = `You are the extraction agent of Colormeris, a tool that turns colors in scientific figures back into numbers. Your job: find every gridded heatmap on the pages you are given and calibrate one panel per heatmap so its values can be extracted. You act only through tools.

Coordinates are pixels of the current page image (its width and height are in get_state). Every image you receive has rulers labelled in those pixels. Read positions off the rulers; zoom in (view_page with a region) before placing anything precisely.

For each page:
1. go_to_page, then view_page to see the whole page. A heatmap here is a grid of colored cells with a colorbar. Skip photos, IVIS/luminescence images, contour or scatter plots and tables with colored text; mention them in finish.
2. For each heatmap, use one panel. A new page starts with one empty panel; use add_panel for more. Name it after the figure label (e.g. "Fig 2b") with rename_panel.
3. Grid: zoom on the heatmap's top-left and bottom-right corners. set_grid with the outer corners of the cell area only (not labels, axes, dendrograms or the colorbar), without rows/cols: the size is detected automatically. Read the row labels (top to bottom) and column labels (left to right) and set_labels.
4. Colorbar: zoom on it. set_colorbar with start and end at the two ends of the colored strip, along its centre line. Add at least two ticks with add_tick using "at" on the tick mark and the printed number as value (include any ×10^n multiplier). Prefer the outermost labelled ticks. If the labels grow by constant factors (1, 10, 100) use set_colorbar_scale log10.
5. Check: view_page on the heatmap region with overlay "calibration" (grid lines must sit on cell borders, the colorbar line on the bar), then overlay "reconstruction" (repainted cells must match the figure). Fix and re-check if needed.
6. resolve_questions: a fast decision model answers typed checks (grid size, cells whose color is off the colorbar, tick order, final acceptance) with calibrated confidence. Low-confidence answers are left for a human. If a check is rejected or left for review, look again and fix what you can, then resolve again (at most twice per panel).

Use decide when a judgment is a clean choice you are unsure of (e.g. which of two readings of a label fits the other ticks). Do not guess silently.
When every page is done, call finish with one line per panel and anything a human should check. Keep your messages short.`;

  // Agent actions the LLM may call (see agent-schema.js). File, tool, IVIS
  // and question-answering actions are left to the runner and the user.
  const LLM_ACTIONS = [
    'get_state', 'get_results', 'sample_pixel', 'go_to_page', 'select_panel', 'add_panel', 'rename_panel',
    'set_grid', 'detect_grid_size', 'set_grid_size', 'set_labels', 'remove_grid',
    'set_colorbar', 'add_tick', 'set_tick_value', 'remove_tick', 'set_colorbar_scale', 'set_settings', 'undo', 'redo',
  ];

  const region = {
    type: 'object',
    description: 'Area to show, in page pixels. Omit for the whole page.',
    properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } },
    required: ['x0', 'y0', 'x1', 'y1'],
  };

  const decisionQuestion = {
    type: 'object',
    properties: {
      type: { enum: ['choice', 'noul', 'score'] },
      instructions: { type: 'string' },
      criteria: { description: 'choice: {option: description}; noul: optional {true: ..., false: ...}; score: array of 2–10 level descriptions, lowest first.' },
    },
    required: ['type', 'instructions'],
  };

  // Tools handled by the runner itself.
  const RUNNER_TOOLS = {
    view_page: {
      description: 'Image of the current page (or a region of it) with pixel rulers. overlay "calibration" draws the grids, colorbars and ticks of this page\'s panels; "reconstruction" repaints each cell with the color its extracted value maps to.',
      args: { type: 'object', properties: { region, overlay: { enum: ['none', 'calibration', 'reconstruction'] } } },
    },
    view_pages_overview: {
      description: 'Thumbnails of up to 12 PDF pages in one image, labelled with page numbers, to find the pages with heatmaps.',
      args: { type: 'object', properties: { from: { type: 'integer', minimum: 1 }, to: { type: 'integer', minimum: 1 } }, required: ['from', 'to'] },
    },
    resolve_questions: {
      description: 'Send the open checks of a panel (or of all panels) to the decision model. Returns each decision, its confidence and whether it was applied or left for a human.',
      args: { type: 'object', properties: { panelId: { type: 'string' } } },
    },
    decide: {
      description: 'Ask the decision model your own typed questions about a state (text or JSON). Returns, per question key, the choice and probabilities (choice), the probability of true (noul) or the level (score).',
      args: {
        type: 'object',
        properties: { state: { description: 'What the questions are about: a string or JSON.' }, questions: { type: 'object', description: 'Map of your key → question.' } },
        required: ['state', 'questions'],
      },
    },
    finish: {
      description: 'End the run with a short summary for the user.',
      args: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  };

  function validateDecide(args) {
    const errs = [];
    const qs = args.questions;
    if (!qs || typeof qs !== 'object' || Array.isArray(qs) || !Object.keys(qs).length) return ['args.questions: give at least one question'];
    for (const [k, q] of Object.entries(qs)) {
      errs.push(...validate(decisionQuestion, q, `args.questions.${k}`));
      if (q?.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) errs.push(`args.questions.${k}.criteria: a choice needs at least two options`);
      if (q?.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) errs.push(`args.questions.${k}.criteria: a score needs 2–10 levels`);
    }
    return errs;
  }

  function validateRunnerTool(name, args) {
    const spec = RUNNER_TOOLS[name];
    const errs = validate(spec.args, args);
    if (!errs.length && name === 'decide') errs.push(...validateDecide(args));
    return errs;
  }

  // Tool definitions in the SDK's chat format.
  function llmTools() {
    const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
    return [
      ...LLM_ACTIONS.map((n) => fn(n, AGENT_ACTIONS[n].description, AGENT_ACTIONS[n].args)),
      ...Object.entries(RUNNER_TOOLS).map(([n, t]) => fn(n, t.description, t.args)),
    ];
  }

  // ---------------------------------------------------------------- decisions

  const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const sizeText = (s) => `${s.rows} rows × ${s.cols} columns`;

  // A typed question (agent-schema.js openQuestions) → decision request body
  // {state, questions: {answer: …}}. `context` adds panel-wide facts:
  // {flaggedCount, cellCount, valueRange, tickRange, excludedCount}.
  function toDecisionRequest(q, context = {}) {
    const ev = q.evidence;
    if (q.type === 'confirm_grid_size') {
      const alt = { rows: ev.labelCounts?.rows || ev.detected.rows, cols: ev.labelCounts?.cols || ev.detected.cols };
      const state = {
        task: 'Check the number of rows and columns of cells in a heatmap from a scientific figure.',
        detector: {
          ...ev.detected,
          rowConfidence: ev.rowConfidence,
          colConfidence: ev.colConfidence,
          note: 'Found from where colors change inside the grid. Confidence is the best period score over the runner-up; below 1.3 is uncertain.',
        },
        labels: { ...ev.labelCounts, note: 'Number of row and column labels read off the figure; 0 means none were read.' },
      };
      if (alt.rows === ev.detected.rows && alt.cols === ev.detected.cols) {
        return { state, questions: { answer: { type: 'noul', instructions: `Is the grid ${sizeText(ev.detected)}?` } } };
      }
      return {
        state,
        questions: {
          answer: {
            type: 'choice',
            instructions: 'Which grid size is right?',
            criteria: { detected: `${sizeText(ev.detected)}, as detected from the colors`, labels: `${sizeText(alt)}, matching the labels read from the figure` },
          },
        },
        alt,
      };
    }
    if (q.type === 'classify_flagged') {
      return {
        state: {
          task: 'A heatmap cell\'s color is far from every color of the calibrated colorbar (CIEDE2000 ΔE above the threshold). Decide what to do with it.',
          cell: { row: ev.rowLabel, column: ev.colLabel, color: ev.rgb ? hex(ev.rgb) : null, deltaE: ev.deltaE, threshold: ev.maxDeltaE, matchedValue: ev.value },
          panel: { flaggedCells: context.flaggedCount, totalCells: context.cellCount },
        },
        questions: {
          answer: {
            type: 'choice',
            instructions: 'How should this cell be treated?',
            criteria: {
              keep: 'A colormap color distorted by compression, anti-aliasing or blending; the matched value is usable.',
              exclude: 'Not a data color: text, a marker or significance symbol, a grid line, or a missing-data color (white, gray, black) outside the colormap.',
              recheck_colorbar: 'The colorbar calibration is probably wrong, e.g. many cells are flagged or the bar was sampled off its colors.',
            },
          },
        },
      };
    }
    if (q.type === 'confirm_tick_order') {
      return {
        state: { task: 'Tick values entered for a heatmap colorbar, in order along the bar. Colorbars almost always have monotonic labels.', ticks: ev.ticks.map((k) => ({ position: k.t, value: k.value })) },
        questions: {
          answer: {
            type: 'choice',
            instructions: 'Are these ticks right as entered?',
            criteria: { as_placed: 'The labels really are non-monotonic (rare, e.g. a categorical bar).', fix_needed: 'A tick value or position was entered wrongly.' },
          },
        },
      };
    }
    if (q.type === 'confirm_extraction') {
      return {
        state: {
          task: 'Final check of values extracted from a heatmap by matching cell colors to its colorbar.',
          grid: { rows: ev.rows, cols: ev.cols },
          flaggedCells: ev.flaggedCount,
          excludedCells: context.excludedCount ?? 0,
          valueRange: context.valueRange,
          colorbarTickRange: context.tickRange,
          note: 'Values should lie within (or very near) the tick range. Many flagged cells suggest a bad calibration.',
        },
        questions: { answer: { type: 'noul', instructions: 'Is this extraction complete and plausible?' } },
      };
    }
    throw new Error(`No decision mapping for ${q.type}`);
  }

  // Decision model answer → {answer, confidence} in the question's answerSchema.
  function fromDecisionAnswer(q, req, a) {
    if (!a) throw new Error('The decision model returned no answer.');
    const choiceConf = () => a.confidence ?? a.probabilities?.[a.choice] ?? null;
    if (q.type === 'confirm_grid_size') {
      const d = q.evidence.detected;
      if (a.type === 'noul') return { answer: { rows: d.rows, cols: d.cols }, confidence: a.noul };
      return { answer: a.choice === 'labels' ? { ...req.alt } : { rows: d.rows, cols: d.cols }, confidence: choiceConf() };
    }
    if (q.type === 'confirm_extraction') {
      return a.noul >= 0.5 ? { answer: 'accept', confidence: a.noul } : { answer: 'reject', confidence: 1 - a.noul };
    }
    return { answer: a.choice, confidence: choiceConf() };
  }

  // ---------------------------------------------------------------- messages

  // Replace the images of all but the last `keep` image-bearing messages with
  // a note, so long runs stay within the context window.
  function pruneImages(messages, keep = 3) {
    let seen = 0;
    const out = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url')) {
        seen++;
        if (seen > keep) {
          out.push({ ...m, content: m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[older image removed]' } : c)) });
          continue;
        }
      }
      out.push(m);
    }
    return out.reverse();
  }

  // Tool results are text; very long ones are cut.
  function toolResultText(value, max = 12000) {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.length > max ? `${s.slice(0, max)}… [cut ${s.length - max} characters]` : s;
  }

  // Parse page lists like "1-3, 7" (1-based, clamped to pageCount).
  function parsePages(text, pageCount) {
    const pages = new Set();
    for (const part of String(text).split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!m) throw new Error(`Cannot read page range "${part}".`);
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(pageCount, Math.max(a, b)); p++) pages.add(p);
    }
    if (!pages.size) throw new Error('No pages in range.');
    return [...pages].sort((x, y) => x - y);
  }

  Object.assign(CM, {
    DEFAULT_LLM,
    DEFAULT_DECISION_MODEL,
    AGENT_SYSTEM_PROMPT: SYSTEM_PROMPT,
    LLM_ACTIONS,
    RUNNER_TOOLS,
    validateRunnerTool,
    llmTools,
    toDecisionRequest,
    fromDecisionAnswer,
    pruneImages,
    toolResultText,
    parsePages,
  });
})((globalThis.Colormeris ??= {}));
