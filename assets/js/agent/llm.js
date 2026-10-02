(function (CM) {
  'use strict';
  const { AGENT_ACTIONS, validate } = CM;

  // Pure parts of the extraction agent (agent/runner.js runs it): the system
  // prompt, the tools the LLM sees, how typed questions become requests to a
  // reviewer (a smaller vision LLM) and back, and trimming old images from
  // the conversation. Messages use the OpenRouter SDK's camelCase shapes.

  const DEFAULT_LLM = 'anthropic/claude-sonnet-5.5';
  const DEFAULT_REVIEWER = 'anthropic/claude-haiku-4.5';

  const SYSTEM_PROMPT = `You are the extraction agent of Colormeris, a tool that turns colors in scientific figures back into numbers. Your job: find every gridded heatmap on the pages you are given and calibrate one panel per heatmap so its values can be extracted. You act only through tools.

Coordinates are pixels of the current page image (its width and height are in get_state). Each image you receive shows a region of the page: image pixel (0, 0) is the region's top-left corner, and its note gives the conversion page x = x0 + image x / scale (same for y). Rulers on the bottom and right edges are labelled in page pixels; use them to check your conversion. Precision matters: a few pixels of error shift every cell or every tick value. Always zoom in (view_page with a small region, so the scale is high) before placing anything, read the coordinates off the rulers, and check the conversion twice. After placing, look again at a zoomed view and correct any offset of more than 1–2 pixels.

For each page:
1. go_to_page, then view_page to see the whole page. A heatmap here is a grid of colored cells with a colorbar. Skip photos, IVIS/luminescence images, contour or scatter plots and tables with colored text; mention them in finish. Before calibrating anything, list in your message EVERY heatmap on the page (figure label and rough region). Pages often hold several (e.g. panels b, c and d); each one needs its own panel.
2. Work through that list one heatmap at a time, each in its own panel. A new page starts with one empty panel; use add_panel for each further heatmap. Name each panel after its figure label (e.g. "Fig 2b") with rename_panel. Finishing one heatmap is not the end: go on with the next one on the list, then the next page.
3. Grid: zoom on the heatmap's top-left and bottom-right corners. set_grid with the outer corners of the cell area only (not labels, axes, dendrograms or the colorbar). Put each corner exactly on the outer edge of the first/last cell, not on a border line, axis or tick outside it. Rows and columns are counted and filled in automatically; do not give them. Read the row labels (top to bottom) and column labels (left to right) and set_labels. Axis labels do not always match the cell count: one label can cover several replicate rows or columns (or only some cells are labelled). Never resize the grid to match the label count; trust the cell structure you see and the detected size.
4. Colorbar: zoom on it. set_colorbar with start and end at the two ends of the colored strip, along its middle. It snaps the line to the strip's centre line and each end to the first and last colored pixel (off the outline), and sets halfWidth from the strip width; read the note it returns. If it says no strip or no edge was found, place those points yourself on a zoomed view: on the centre line, just inside the colored strip, never on the black or grey outline and never short of the last color.
   Ticks: add at least two with add_tick, "at" on the tick mark and the printed number as value (include any ×10^n multiplier). Use the outermost labelled ticks, and a middle one when there is one. add_tick snaps to the nearest tick mark; if its note says no mark was found (bars without marks), put "at" level with the middle of the label text. Read each label carefully (signs, decimals, exponents). If the labels grow by constant factors (1, 10, 100) use set_colorbar_scale log10.
5. Check: view_page on the heatmap region with overlay "calibration" (grid lines must sit on cell borders, the colorbar line on the middle of the bar from end to end), then zoom on the colorbar alone with overlay "calibration": each orange tick dot must be level with its printed label and show the same number. Then overlay "reconstruction" (repainted cells must match the figure). Fix and re-check if needed.
6. resolve_questions: a reviewer model looks at each panel with its overlays and answers typed checks (grid size, cells whose color is off the colorbar, tick order, final acceptance) with a confidence and a reason. Low-confidence answers are left for a human. Follow the advice it returns: if a panel is rejected or left for review, look again and fix what you can, then resolve again. Call resolve_questions at most 3 times per panel.

Errors and retries:
- When a tool returns ok: false, read the error and change the arguments before calling again. Never repeat an identical call.
- Each tool gets at most 3 attempts per panel. After the third failure the tool is blocked for that panel: skip the step and move on.
- If a panel still fails its checks after two rounds of fixes, stop working on it. Leave it for the human and say so in finish.
- Give each argument once, in the form its description asks for (e.g. add_tick takes either "at" or "t", never both).

When every heatmap on every page is done, call finish with one line per panel and anything a human should check. The first finish is answered with a checklist: look at each page once more, calibrate any heatmap still missing, then call finish again. Keep your messages short.`;

  // Agent actions the LLM may call (see agent/schema.js). File, tool, ROI
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
      description: 'Send the open checks of a panel (or of all panels) to the reviewer, a vision model that looks at the panel with overlays. Returns each answer, its confidence, the reviewer\'s reason and whether it was applied or left for a human.',
      args: { type: 'object', properties: { panelId: { type: 'string' } } },
    },
    finish: {
      description: 'End the run with a short summary for the user.',
      args: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  };

  function validateRunnerTool(name, args) {
    const spec = RUNNER_TOOLS[name];
    return validate(spec.args, args);
  }

  // Tool definitions in the SDK's chat format.
  function llmTools() {
    const fn = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
    return [
      ...LLM_ACTIONS.map((n) => fn(n, AGENT_ACTIONS[n].description, AGENT_ACTIONS[n].args)),
      ...Object.entries(RUNNER_TOOLS).map(([n, t]) => fn(n, t.description, t.args)),
    ];
  }

  // ---------------------------------------------------------------- review

  const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const sizeText = (s) => `${s.rows} rows × ${s.cols} columns`;

  const REVIEWER_PROMPT = `You are the reviewer of Colormeris, a tool that turns colors in heatmaps from scientific figures back into numbers. Another model calibrated a heatmap panel; you check its work. You get images of the panel region: the figure as it is, the calibration overlay (magenta grid lines must sit on the cell borders; the orange colorbar line must run along the middle of the colored strip from end to end; each orange tick dot must be level with its printed label and show the same number), the reconstruction (each cell repainted with the color its extracted value maps to; cells outlined in red are flagged as far from every colorbar color) and, when there is a colorbar, a zoom on it with the calibration overlay. You also get numeric evidence for each check.

Answer every check with the answer tool: pick one option, give your confidence (the probability that your option is right; 0.9 or more only when the images and numbers clearly show it) and one short reason naming what you saw (e.g. "grid lines are one column short on the right"). Judge each check on its own. Do not guess: when the images do not show it clearly, say so with a low confidence.`;

  // A typed question (agent/schema.js openQuestions) → a review item
  // {instructions, options: {name: description}, evidence} that the reviewer
  // answers with one option. `context` adds panel-wide facts:
  // {flaggedCount, cellCount, valueRange, tickRange, excludedCount, fit}.
  function toReviewItem(q, context = {}) {
    const ev = q.evidence;
    if (q.type === 'confirm_grid_size') {
      const alt = { rows: ev.labelCounts?.rows || ev.detected.rows, cols: ev.labelCounts?.cols || ev.detected.cols };
      const same = alt.rows === ev.detected.rows && alt.cols === ev.detected.cols;
      return {
        instructions: 'How many rows and columns of cells does the heatmap have? Count them on the figure image and check that the magenta grid lines of the calibration overlay fall on the cell borders.',
        options: {
          detected: `${sizeText(ev.detected)}, as detected from the colors`,
          ...(same ? {} : { labels: `${sizeText(alt)}, same as the number of labels read (labels can cover several replicate rows or columns)` }),
          neither: 'Neither: the grid lines do not match the cells.',
        },
        evidence: {
          detector: { ...ev.detected, rowConfidence: ev.rowConfidence, colConfidence: ev.colConfidence, note: 'Confidence is the best period score over the runner-up; below 1.3 is uncertain.' },
          labelsRead: ev.labelCounts,
        },
        ...(same ? {} : { alt }),
      };
    }
    if (q.type === 'classify_flagged') {
      return {
        instructions: `The cell in row ${ev.row + 1}, column ${ev.col + 1} (${ev.rowLabel || '?'} / ${ev.colLabel || '?'}; outlined in red on the reconstruction) has a color far from every colorbar color. How should it be treated?`,
        options: {
          keep: 'A colormap color distorted by compression, anti-aliasing or blending; the matched value is usable.',
          exclude: 'Not a data color: text, a marker or significance symbol, a grid line, or a missing-data color (white, gray, black) outside the colormap.',
          recheck_colorbar: 'The colorbar calibration is probably wrong, e.g. many cells are flagged or the bar was sampled off its colors.',
        },
        evidence: { color: ev.rgb ? hex(ev.rgb) : null, deltaE: ev.deltaE, threshold: ev.maxDeltaE, matchedValue: ev.value, flaggedCells: context.flaggedCount, totalCells: context.cellCount },
      };
    }
    if (q.type === 'classify_flagged_cells') {
      return {
        instructions: `${ev.count} of ${ev.total} cells (outlined in red on the reconstruction) have colors far from every colorbar color. How should they be treated?`,
        options: {
          keep_all: 'They are colormap colors distorted by compression, anti-aliasing or blending; the matched values are usable.',
          exclude_all: 'They are not data colors: text, markers, grid lines, or missing-data colors (white, gray, black) outside the colormap.',
          recheck_colorbar: 'The colorbar calibration is probably wrong (the bar was sampled off its colors, or the ends or ticks are misplaced).',
        },
        evidence: { medianDeltaE: ev.medianDeltaE, maxDeltaE: ev.maxDeltaE, threshold: ev.threshold, sampleColors: ev.sampleColors.map(hex), note: 'When most cells are flagged, the colorbar was usually sampled off the bar rather than the cells being non-data colors.' },
      };
    }
    if (q.type === 'confirm_tick_order') {
      return {
        instructions: 'The tick values entered for the colorbar do not change monotonically along the bar. Compare the orange tick dots and their numbers with the printed labels on the colorbar zoom.',
        options: { as_placed: 'The printed labels really are non-monotonic (rare, e.g. a categorical bar).', fix_needed: 'A tick value or position was entered wrongly.' },
        evidence: { ticks: ev.ticks.map((k) => ({ position: k.t, value: k.value })), note: 'position is 0 at the start of the colorbar line and 1 at its end.' },
      };
    }
    if (q.type === 'confirm_extraction') {
      return {
        instructions: 'Final check: is this extraction complete and right? The reconstruction must look like the figure cell by cell, the grid must cover exactly the cells, and the colorbar line and ticks must match the printed bar.',
        options: { accept: 'The calibration and the extracted values look right.', reject: 'Something is off (grid, colorbar, ticks or scale); say what.' },
        evidence: {
          grid: { rows: ev.rows, cols: ev.cols },
          flaggedCells: ev.flaggedCount,
          excludedCells: context.excludedCount ?? 0,
          valueRange: context.valueRange,
          colorbarTickRange: context.tickRange,
          fit: context.fit ?? null,
          note: 'Values should lie within (or very near) the tick range. fit: medianDeltaE/p95DeltaE are color distances between each cell and its matched colorbar color (small is good; threshold is the flag limit); rangeOverTicks is the value range divided by the tick range; distinctValues is how many different values were found.',
        },
      };
    }
    throw new Error(`No review mapping for ${q.type}`);
  }

  // The reviewer's user message for one panel: the checks as text, then the
  // images. items: [{q, item}] from toReviewItem; images: [{label, note,
  // dataUrl}]. Returns {content, keys} where keys[i] is the key of items[i].
  function reviewContent({ panelName, items, images }) {
    const keys = items.map((_, i) => `q${i}`);
    const checks = Object.fromEntries(items.map(({ item }, i) => [keys[i], { instructions: item.instructions, options: item.options, evidence: item.evidence }]));
    const text = `Panel "${panelName}". Answer these checks (key → check):\n${JSON.stringify(checks, null, 1)}\n\nThe images follow: ${images.map((im) => im.label).join('; ')}.`;
    const content = [{ type: 'text', text }, ...images.flatMap((im) => [{ type: 'text', text: `${im.label}. ${im.note}` }, { type: 'image_url', imageUrl: { url: im.dataUrl } }])];
    return { content, keys };
  }

  // The one tool the reviewer must call, with each check's options as an enum.
  function reviewTool(items, keys) {
    const answer = (item) => ({
      type: 'object',
      properties: {
        answer: { enum: Object.keys(item.options) },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
      required: ['answer', 'confidence', 'reason'],
    });
    const properties = Object.fromEntries(items.map(({ item }, i) => [keys[i], answer(item)]));
    return {
      type: 'function',
      function: {
        name: 'answer',
        description: 'Give your answer to every check.',
        parameters: { type: 'object', properties: { answers: { type: 'object', properties, required: keys } }, required: ['answers'] },
      },
    };
  }

  // Reviewer message → {key: {answer, confidence, reason}}. Takes the forced
  // tool call, or JSON in the text for models that answer in prose.
  function parseReviewAnswers(msg) {
    const call = msg?.toolCalls?.find((c) => c.function?.name === 'answer') ?? msg?.toolCalls?.[0];
    let raw = call?.function?.arguments;
    if (!raw && typeof msg?.content === 'string') raw = /\{[\s\S]*\}/.exec(msg.content)?.[0];
    if (!raw) throw new Error('The reviewer gave no answers.');
    let parsed;
    try {
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new Error('The reviewer\'s answers are not valid JSON.');
    }
    return parsed.answers ?? parsed;
  }

  // Reviewer answer → {answer, confidence, reason} in the question's
  // answerSchema.
  function fromReviewAnswer(q, item, a) {
    if (!a || !(a.answer in item.options)) throw new Error(`The reviewer gave no valid answer${a?.answer ? ` ("${a.answer}")` : ''}.`);
    const confidence = Number.isFinite(a.confidence) ? Math.min(1, Math.max(0, a.confidence)) : null;
    const reason = typeof a.reason === 'string' ? a.reason : '';
    if (q.type === 'confirm_grid_size') {
      const d = q.evidence.detected;
      if (a.answer === 'labels') return { answer: { ...item.alt }, confidence, reason };
      // "neither": the detected size, with the confidence that it is right,
      // so it goes to a human.
      return { answer: { rows: d.rows, cols: d.cols }, confidence: a.answer === 'neither' && confidence !== null ? 1 - confidence : confidence, reason };
    }
    return { answer: a.answer, confidence, reason };
  }

  // Page region around a panel's grid and colorbar (with room for labels),
  // clamped to the page. Null when the panel has neither.
  function panelRegion(panel, size, pad = 60) {
    const pts = [...(panel.grid.corners || []), ...(panel.colorbar.start && panel.colorbar.end ? [panel.colorbar.start, panel.colorbar.end] : [])];
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      x0: Math.max(0, Math.min(...xs) - pad),
      y0: Math.max(0, Math.min(...ys) - pad),
      x1: Math.min(size.width, Math.max(...xs) + pad),
      y1: Math.min(size.height, Math.max(...ys) + pad),
    };
  }

  // Region around the colorbar alone, wide enough for its tick labels.
  function colorbarRegion(panel, size) {
    const { start, end, halfWidth = 5 } = panel.colorbar;
    if (!start || !end) return null;
    const pad = Math.max(70, halfWidth * 8);
    return {
      x0: Math.max(0, Math.min(start.x, end.x) - pad),
      y0: Math.max(0, Math.min(start.y, end.y) - pad),
      x1: Math.min(size.width, Math.max(start.x, end.x) + pad),
      y1: Math.min(size.height, Math.max(start.y, end.y) + pad),
    };
  }

  // What the LLM should do after reviews ({type, panelId, answer, applied,
  // reason}). The reviewer's reason is passed on: it says what looks wrong.
  function reviewAdvice(reviews, panelName = (id) => id) {
    const out = [];
    const why = (d) => (d.reason ? ` The reviewer said: "${d.reason}"` : '');
    for (const d of reviews) {
      const name = panelName(d.panelId);
      if (d.type === 'confirm_extraction' && d.answer === 'reject') {
        out.push(`${name}: the extraction was ${d.applied ? 'rejected' : 'probably wrong (left for a human)'}.${why(d)} Look again at the grid corners, the colorbar line and the ticks with overlays, fix what is off, then resolve_questions again.`);
      } else if ((d.type === 'classify_flagged' || d.type === 'classify_flagged_cells') && d.answer === 'recheck_colorbar') {
        out.push(`${name}: recheck the colorbar.${why(d)} Zoom on it with overlay "calibration": the line must run along the middle of the colored strip from end to end, and the ticks must sit on their marks.`);
      } else if (d.type === 'confirm_grid_size' && !d.applied) {
        out.push(`${name}: the grid size is uncertain.${why(d)} Count the rows and columns on a zoomed view and set_grid_size.`);
      } else if (d.type === 'confirm_tick_order' && d.answer === 'fix_needed') {
        out.push(`${name}: a tick is wrong.${why(d)} Zoom on the colorbar and fix it with set_tick_value or remove_tick.`);
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
    DEFAULT_REVIEWER,
    AGENT_SYSTEM_PROMPT: SYSTEM_PROMPT,
    REVIEWER_PROMPT,
    LLM_ACTIONS,
    RUNNER_TOOLS,
    validateRunnerTool,
    llmTools,
    toReviewItem,
    reviewContent,
    reviewTool,
    parseReviewAnswers,
    fromReviewAnswer,
    panelRegion,
    colorbarRegion,
    reviewAdvice,
    createRetryGuard,
    progressNote,
    finishCheck,
    AGENT_LIMITS: { MAX_ATTEMPTS, MAX_RESOLVES, MAX_ERRORS_IN_A_ROW, MAX_FINISH_REFUSALS },
    pruneImages,
    toolResultText,
    parsePages,
  });
})((globalThis.Colormeris ??= {}));
