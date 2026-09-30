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

Coordinates are pixels of the current page image (its width and height are in get_state). Each image you receive shows a region of the page: image pixel (0, 0) is the region's top-left corner, and its note gives the conversion page x = x0 + image x / scale (same for y). Rulers on the bottom and right edges are labelled in page pixels; use them to check your conversion. Precision matters: a few pixels of error shift every cell or every tick value. Always zoom in (view_page with a small region, so the scale is high) before placing anything, read the coordinates off the rulers, and check the conversion twice. After placing, look again at a zoomed view and correct any offset of more than 1–2 pixels.

For each page:
1. go_to_page, then view_page to see the whole page. A heatmap here is a grid of colored cells with a colorbar. Skip photos, IVIS/luminescence images, contour or scatter plots and tables with colored text; mention them in finish. Before calibrating anything, list in your message EVERY heatmap on the page (figure label and rough region). Pages often hold several (e.g. panels b, c and d); each one needs its own panel.
2. Work through that list one heatmap at a time, each in its own panel. A new page starts with one empty panel; use add_panel for each further heatmap. Name each panel after its figure label (e.g. "Fig 2b") with rename_panel. Finishing one heatmap is not the end: go on with the next one on the list, then the next page.
3. Grid: zoom on the heatmap's top-left and bottom-right corners. set_grid with the outer corners of the cell area only (not labels, axes, dendrograms or the colorbar). Put each corner exactly on the outer edge of the first/last cell, not on a border line, axis or tick outside it. Rows and columns are counted and filled in automatically; do not give them. Read the row labels (top to bottom) and column labels (left to right) and set_labels. Axis labels do not always match the cell count: one label can cover several replicate rows or columns (or only some cells are labelled). Never resize the grid to match the label count; trust the cell structure you see and the detected size.
4. Colorbar: zoom on it. set_colorbar with start and end at the two ends of the colored strip, along its middle. It snaps the line to the strip's centre line and each end to the first and last colored pixel (off the outline), and sets halfWidth from the strip width; read the note it returns. If it says no strip or no edge was found, place those points yourself on a zoomed view: on the centre line, just inside the colored strip, never on the black or grey outline and never short of the last color.
   Ticks: add at least two with add_tick, "at" on the tick mark and the printed number as value (include any ×10^n multiplier). Use the outermost labelled ticks, and a middle one when there is one. add_tick snaps to the nearest tick mark; if its note says no mark was found (bars without marks), put "at" level with the middle of the label text. Read each label carefully (signs, decimals, exponents). If the labels grow by constant factors (1, 10, 100) use set_colorbar_scale log10.
5. Check: view_page on the heatmap region with overlay "calibration" (grid lines must sit on cell borders, the colorbar line on the middle of the bar from end to end), then zoom on the colorbar alone with overlay "calibration": each orange tick dot must be level with its printed label and show the same number. Then overlay "reconstruction" (repainted cells must match the figure). Fix and re-check if needed.
6. resolve_questions: a fast decision model answers typed checks (grid size, cells whose color is off the colorbar, tick order, final acceptance) with calibrated confidence. Low-confidence answers are left for a human. Follow the advice it returns: if a panel is rejected or left for review, look again and fix what you can, then resolve again. Call resolve_questions at most 3 times per panel.

Errors and retries:
- When a tool returns ok: false, read the error and change the arguments before calling again. Never repeat an identical call.
- Each tool gets at most 3 attempts per panel. After the third failure the tool is blocked for that panel: skip the step and move on.
- If a panel still fails its checks after two rounds of fixes, stop working on it. Leave it for the human and say so in finish.
- Give each argument once, in the form its description asks for (e.g. add_tick takes either "at" or "t", never both).

Use decide when a judgment is a clean choice you are unsure of (e.g. which of two readings of a label fits the other ticks). Do not guess silently.
When every heatmap on every page is done, call finish with one line per panel and anything a human should check. The first finish is answered with a checklist: look at each page once more, calibrate any heatmap still missing, then call finish again. Keep your messages short.`;

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
        labels: { ...ev.labelCounts, note: 'Number of row and column labels read off the figure; 0 means none were read. A label can span several replicate rows or columns, so a smaller label count does not mean the detector is wrong.' },
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
            criteria: { detected: `${sizeText(ev.detected)}, as detected from the colors`, labels: `${sizeText(alt)}, same as the number of labels read (labels may cover replicates, so this is weaker evidence than the colors)` },
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
    if (q.type === 'classify_flagged_cells') {
      return {
        state: {
          task: 'Many cells of a heatmap have colors far from every color of its calibrated colorbar (CIEDE2000 ΔE above the threshold). Decide what to do with them.',
          flaggedCells: ev.count,
          totalCells: ev.total,
          medianDeltaE: ev.medianDeltaE,
          maxDeltaE: ev.maxDeltaE,
          threshold: ev.threshold,
          sampleColors: ev.sampleColors.map(hex),
          note: 'When most cells are flagged, the colorbar was usually sampled off the bar (wrong position) rather than the cells being non-data colors.',
        },
        questions: {
          answer: {
            type: 'choice',
            instructions: 'How should the flagged cells be treated?',
            criteria: {
              keep_all: 'They are colormap colors distorted by compression, anti-aliasing or blending; the matched values are usable.',
              exclude_all: 'They are not data colors: text, markers, grid lines, or missing-data colors (white, gray, black) outside the colormap.',
              recheck_colorbar: 'The colorbar calibration is probably wrong (the bar was sampled off its colors, or the ends or ticks are misplaced).',
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
          // Numbers a text-only model can judge without seeing the figure.
          fit: context.fit ?? null,
          note: 'Values should lie within (or very near) the tick range. Many flagged cells suggest a bad calibration. fit: medianDeltaE/p95DeltaE are color distances between each cell and its matched colorbar color (small is good, threshold is the flag limit); rangeOverTicks is the value range divided by the tick range (about 1 when the figure uses the whole bar, far above 1 means values outside the ticks); distinctValues is how many different values were found.',
        },
        questions: { answer: { type: 'noul', instructions: 'Is this extraction complete and plausible?' } },
      };
    }
    throw new Error(`No decision mapping for ${q.type}`);
  }

  // Several questions in ONE decisions request (one network round trip per
  // resolve cycle instead of one per question; the model still answers each
  // key on its own). items: [{q, req}] from toDecisionRequest. Returns
  // {state, questions, keys} where keys[i] is the answer key of items[i].
  function batchDecisionRequests(items) {
    const keys = items.map((_, i) => `q${i}`);
    const state = { task: 'Independent checks of extractions from scientific figures. Answer each question from its own case only.', cases: {} };
    const questions = {};
    items.forEach(({ req }, i) => {
      state.cases[keys[i]] = req.state;
      questions[keys[i]] = req.questions.answer;
    });
    return { state, questions, keys };
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

  // What the LLM should do after decisions ({type, panelId, answer, applied}).
  function decisionAdvice(decisions, panelName = (id) => id) {
    const out = [];
    for (const d of decisions) {
      const name = panelName(d.panelId);
      if (d.type === 'confirm_extraction' && d.answer === 'reject') {
        out.push(`${name}: the extraction was ${d.applied ? 'rejected' : 'probably wrong (left for a human)'}. Look again at the grid corners, the colorbar line and the ticks with overlays, fix what is off, then resolve_questions again.`);
      } else if ((d.type === 'classify_flagged' || d.type === 'classify_flagged_cells') && d.answer === 'recheck_colorbar') {
        out.push(`${name}: recheck the colorbar. Zoom on it with overlay "calibration": the line must run along the middle of the colored strip from end to end, and the ticks must sit on their marks.`);
      } else if (d.type === 'confirm_grid_size' && !d.applied) {
        out.push(`${name}: the grid size is uncertain. Count the rows and columns on a zoomed view and set_grid_size.`);
      }
    }
    return [...new Set(out)];
  }

  // ---------------------------------------------------------------- progress

  // Models tend to call finish (or stop talking) after the first heatmap.
  // `panels` are the run's heatmap panels [{id, name, page, ready, started}]
  // (started: has a grid, colorbar or labels).

  // Where the run stands, for tool results and nudges.
  function progressNote({ pages, viewedPages, panels, currentPage }) {
    const left = pages.filter((p) => !viewedPages.has(p));
    const here = panels.filter((p) => p.page === currentPage && p.started);
    const parts = [];
    if (here.length) parts.push(`Page ${currentPage} panels: ${here.map((p) => `${p.name}${p.ready ? '' : ' (incomplete)'}`).join(', ')}. Is every heatmap on this page in the list? If not, add_panel for the next one.`);
    parts.push(left.length ? `Pages not looked at yet: ${left.join(', ')}.` : 'Every page of the run has been looked at.');
    return parts.join(' ');
  }

  // Why `finish` is refused, as {message, checklist}, or null to let the run
  // end. The final checklist is given once (`checked` after that); other
  // refusals stop after MAX_FINISH_REFUSALS so a stuck model can still end.
  function finishCheck({ pages, viewedPages, panels, checked, refusals = 0 }) {
    if (refusals >= MAX_FINISH_REFUSALS) return null;
    const left = pages.filter((p) => !viewedPages.has(p));
    const many = left.length > 1;
    if (left.length) return { message: `Not finished: page${many ? 's' : ''} ${left.join(', ')} ${many ? 'were' : 'was'} not looked at. go_to_page and view_page ${many ? 'each' : 'it'}, calibrate every heatmap on ${many ? 'them' : 'it'}, then call finish again.`, checklist: false };
    const incomplete = panels.filter((p) => p.started && !p.ready);
    if (incomplete.length && refusals < 1) return { message: `Not finished: ${incomplete.map((p) => `${p.name} (page ${p.page})`).join(', ')} ${incomplete.length > 1 ? 'are' : 'is'} only partly calibrated. Complete ${incomplete.length > 1 ? 'them' : 'it'}, or say in finish why not, then call finish again.`, checklist: false };
    if (checked) return null;
    const byPage = pages.map((pg) => `page ${pg}: ${panels.filter((p) => p.page === pg && p.started).map((p) => p.name).join(', ') || 'no panels'}`).join('; ');
    return { message: `Final check before finishing. Calibrated so far: ${byPage}. view_page each page once more (whole page) and compare: does every heatmap have its own panel? If one is missing, add_panel and calibrate it. When all are done, call finish again.`, checklist: true };
  }

  // ---------------------------------------------------------------- retries

  const MAX_ATTEMPTS = 3; // tries of one tool on one panel before it is blocked
  const MAX_RESOLVES = 3; // resolve_questions calls per panel
  const MAX_ERRORS_IN_A_ROW = 8; // failed calls in a row before the run stops
  const MAX_FINISH_REFUSALS = 3; // refused finish calls before any finish is accepted

  // Tracks failures so a model that keeps repeating a bad call is told
  // clearly, then blocked, instead of looping until it runs out of steps.
  //   guard.before(name, panelId) → a result to return instead of running the
  //     call (blocked), or null
  //   guard.after(name, panelId, result) → the result, with the attempt count
  //     and instructions added to errors
  //   guard.stop → a reason to end the run, or null
  function createRetryGuard({ maxAttempts = MAX_ATTEMPTS, maxResolves = MAX_RESOLVES, maxErrorsInARow = MAX_ERRORS_IN_A_ROW } = {}) {
    const failures = new Map();
    const resolves = new Map();
    let inARow = 0;
    const guard = {
      stop: null,
      before(name, panelId) {
        const key = `${name}|${panelId}`;
        if ((failures.get(key) || 0) >= maxAttempts) {
          return { ok: false, error: `${name} is blocked for this panel after ${maxAttempts} failed attempts. Do not call it again for this panel. Skip this step, continue with the next step or panel, and list what is missing in finish.` };
        }
        if (name === 'resolve_questions') {
          const n = (resolves.get(panelId) || 0) + 1;
          resolves.set(panelId, n);
          if (n > maxResolves) {
            return { ok: true, result: `Checks were already resolved ${maxResolves} times for this panel. Stop fixing it: leave the open checks for the human and continue with the next panel, or finish.` };
          }
        }
        return null;
      },
      after(name, panelId, result) {
        const key = `${name}|${panelId}`;
        if (result.ok) {
          failures.delete(key);
          inARow = 0;
          return result;
        }
        const n = (failures.get(key) || 0) + 1;
        failures.set(key, n);
        inARow++;
        if (inARow >= maxErrorsInARow) guard.stop = `${inARow} tool calls in a row failed; the last was ${name}: ${result.error}`;
        const next =
          n >= maxAttempts
            ? `This was attempt ${n} of ${maxAttempts}: ${name} is now blocked for this panel. Skip this step and move on; list it in finish.`
            : `Attempt ${n} of ${maxAttempts}. Read the error and change the arguments; do not repeat the same call.`;
        return { ...result, error: `${result.error} ${next}` };
      },
    };
    return guard;
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
    batchDecisionRequests,
    fromDecisionAnswer,
    decisionAdvice,
    createRetryGuard,
    progressNote,
    finishCheck,
    AGENT_LIMITS: { MAX_ATTEMPTS, MAX_RESOLVES, MAX_ERRORS_IN_A_ROW, MAX_FINISH_REFUSALS },
    pruneImages,
    toolResultText,
    parsePages,
  });
})((globalThis.Colormeris ??= {}));
