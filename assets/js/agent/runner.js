(function (CM) {
  'use strict';
  const {
    AGENT_SYSTEM_PROMPT, REVIEWER_PROMPT, LLM_ACTIONS, RUNNER_TOOLS, validateRunnerTool, llmTools, toReviewItem, reviewContent, reviewTool, parseReviewAnswers, fromReviewAnswer, panelRegion, colorbarRegion, reviewAdvice,
    createRetryGuard, progressNote, finishCheck, pruneImages, toolResultText,
    bilinear, cellSamplePolygon, colorAtT, rgbToHex, ticksWithT, renderPdfPage,
  } = CM;

  // Runs the extraction agent: an LLM (any OpenRouter chat model with vision
  // and tools) drives the page through the typed agent API and looks at it
  // through rendered page images with pixel rulers; a reviewer (a smaller
  // vision model) looks at each panel with overlays and answers the typed
  // checks. `client` is an OpenRouter SDK client (or anything with chat.send).

  const MAX_VIEW = 1024; // longest side of images sent to the LLM
  const REVIEW_VIEW = 768; // and to the reviewer, which gets several per panel
  // Rulers sit outside the picture on the right and bottom, so image pixel
  // (0, 0) is exactly the top-left corner of the region shown. (With rulers on
  // the left and top, models that measure from the image corner were off by
  // the ruler width divided by the zoom.)
  const RULER = { right: 50, bottom: 24 };

  function createAgentRunner(ws, api) {
    const { app } = ws;

    // ------------------------------------------------------------ images

    // Round step (1, 2 or 5 × 10^k) so ruler labels are ~`px` screen pixels apart.
    function niceStep(scale, px = 70) {
      const raw = px / scale;
      const p = 10 ** Math.floor(Math.log10(raw));
      return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
    }

    // Page (or region) image with rulers in page pixels and optional overlay.
    function renderView({ region, overlay = 'none', maxSide = MAX_VIEW } = {}) {
      const page = app.pages.get(ws.currentPage());
      if (!page) throw new Error('No page is shown.');
      const src = page.canvas;
      let { x0, y0, x1, y1 } = region || { x0: 0, y0: 0, x1: src.width, y1: src.height };
      [x0, x1] = [Math.max(0, Math.min(x0, x1)), Math.min(src.width, Math.max(x0, x1))];
      [y0, y1] = [Math.max(0, Math.min(y0, y1)), Math.min(src.height, Math.max(y0, y1))];
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 4 || h < 4) throw new Error('Region is too small or outside the page.');
      const scale = Math.min(6, maxSide / Math.max(w, h));
      const W = Math.round(w * scale);
      const H = Math.round(h * scale);
      const out = document.createElement('canvas');
      out.width = W + RULER.right;
      out.height = H + RULER.bottom;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(src, x0, y0, w, h, 0, 0, W, H);
      const toView = (p) => ({ x: (p.x - x0) * scale, y: (p.y - y0) * scale });

      if (overlay !== 'none') drawPanels(ctx, toView, scale, overlay);

      // Rulers (bottom and right) with faint guide lines across the picture.
      const step = niceStep(scale);
      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#000';
      ctx.strokeStyle = 'rgba(0, 170, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const vx = Math.round(toView({ x, y: 0 }).x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(vx, 0);
        ctx.lineTo(vx, H + 5);
        ctx.stroke();
        ctx.fillText(String(Math.round(x)), Math.min(Math.max(vx, 12), W - 12), H + 8);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const vy = Math.round(toView({ x: 0, y }).y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, vy);
        ctx.lineTo(W + 5, vy);
        ctx.stroke();
        ctx.fillText(String(Math.round(y)), W + 8, Math.min(Math.max(vy, 7), H - 7));
      }
      ws.zoomToPoints([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
      const r = (v) => Math.round(v * 100) / 100;
      return {
        dataUrl: out.toDataURL('image/jpeg', 0.9),
        note: `Page ${ws.currentPage()}, region x ${r(x0)}–${r(x1)}, y ${r(y0)}–${r(y1)}, drawn at ${r(scale)}× (${W} × ${H} image pixels plus rulers). Image pixel (0, 0) is page point (${r(x0)}, ${r(y0)}): page x = ${r(x0)} + image x / ${r(scale)}, page y = ${r(y0)} + image y / ${r(scale)}. The rulers on the bottom and right edges show the same page pixels.`,
        region: { x0, y0, scale },
      };
    }

    function drawPanels(ctx, toView, scale, overlay) {
      const line = (a, b, color, width = 1.5) => {
        const p = toView(a);
        const q = toView(b);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };
      for (const panel of ws.pagePanels()) {
        const g = panel.grid;
        if (g.corners && overlay === 'reconstruction') {
          const res = ws.resultFor(panel);
          if (res.cells) {
            for (let r = 0; r < g.rows; r++) {
              for (let c = 0; c < g.cols; c++) {
                const poly = cellSamplePolygon(g, r, c).map(toView);
                ctx.beginPath();
                poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
                ctx.closePath();
                ctx.fillStyle = rgbToHex(colorAtT(res.samples, res.cells[r][c].t));
                ctx.fill();
                if (res.cells[r][c].flagged) {
                  ctx.strokeStyle = '#ff3b30';
                  ctx.lineWidth = 2;
                  ctx.stroke();
                }
              }
            }
          }
        }
        if (g.corners && overlay === 'calibration') {
          for (let c = 0; c <= g.cols; c++) line(bilinear(g.corners, c / g.cols, 0), bilinear(g.corners, c / g.cols, 1), '#e22bd0', c % g.cols ? 1 : 2);
          for (let r = 0; r <= g.rows; r++) line(bilinear(g.corners, 0, r / g.rows), bilinear(g.corners, 1, r / g.rows), '#e22bd0', r % g.rows ? 1 : 2);
        }
        const cb = panel.colorbar;
        if (cb.start && cb.end && overlay === 'calibration') {
          line(cb.start, cb.end, '#f29900', 2);
          ctx.font = 'bold 11px sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          for (const k of ticksWithT(cb)) {
            const p = toView(k);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI);
            ctx.fillStyle = '#f29900';
            ctx.fill();
            ctx.fillStyle = '#000';
            ctx.fillText(`${k.value}`, p.x + 7, p.y);
          }
        }
      }
    }

    async function renderOverview(from, to) {
      if (!app.pdfDoc) throw new Error('The file has one page; use view_page.');
      const n = app.pdfDoc.numPages;
      from = Math.max(1, from);
      to = Math.min(n, to, from + 11);
      if (to < from) throw new Error(`Pages run from 1 to ${n}.`);
      const thumbs = [];
      for (let p = from; p <= to; p++) {
        const page = await app.pdfDoc.getPage(p);
        const vw = page.getViewport({ scale: 1 }).width;
        thumbs.push({ p, canvas: (await renderPdfPage(app.pdfDoc, p, 320 / vw)).canvas });
      }
      const cols = Math.min(4, thumbs.length);
      const cw = 330;
      const ch = Math.max(...thumbs.map((t) => t.canvas.height)) + 26;
      const out = document.createElement('canvas');
      out.width = cols * cw;
      out.height = Math.ceil(thumbs.length / cols) * ch;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#ddd';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.font = 'bold 16px sans-serif';
      thumbs.forEach((t, i) => {
        const x = (i % cols) * cw + 5;
        const y = Math.floor(i / cols) * ch;
        ctx.fillStyle = '#000';
        ctx.fillText(`Page ${t.p}`, x, y + 18);
        ctx.drawImage(t.canvas, x, y + 24);
      });
      return { dataUrl: out.toDataURL('image/jpeg', 0.85), note: `Pages ${from}–${to} of ${n}.` };
    }

    // ------------------------------------------------------------ review

    // Images the reviewer judges a panel from: the figure, both overlays, and
    // a zoom on the colorbar. The panel's page must be the current one.
    function reviewImages(panel) {
      const { canvas } = app.pages.get(ws.currentPage());
      const size = { width: canvas.width, height: canvas.height };
      const region = panelRegion(panel, size);
      if (!region) return [];
      const view = (label, args) => ({ label, ...renderView({ ...args, maxSide: REVIEW_VIEW }) });
      const out = [
        view('Figure', { region }),
        view('Calibration overlay', { region, overlay: 'calibration' }),
        view('Reconstruction', { region, overlay: 'reconstruction' }),
      ];
      const bar = colorbarRegion(panel, size);
      if (bar) out.push(view('Colorbar zoom with calibration overlay', { region: bar, overlay: 'calibration' }));
      return out;
    }

    // Context a question needs beyond its own evidence.
    async function panelContext(panelId) {
      const r = await api.run('get_results', { panelId });
      const res = r.result;
      if (!r.ok || !res || res.error) return {};
      const vals = res.values.flat().filter(Number.isFinite);
      const panel = app.project.panels.find((p) => p.id === panelId);
      const tickVals = panel.colorbar.ticks.map((k) => k.value).filter(Number.isFinite);
      const des = res.deltaE.flat().filter(Number.isFinite).sort((a, b) => a - b);
      const at = (f) => (des.length ? Math.round(des[Math.min(des.length - 1, Math.floor(f * des.length))] * 100) / 100 : null);
      const tickSpan = tickVals.length ? Math.max(...tickVals) - Math.min(...tickVals) : 0;
      const valSpan = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
      return {
        fit: { medianDeltaE: at(0.5), p95DeltaE: at(0.95), threshold: res.maxDeltaE, rangeOverTicks: tickSpan ? Math.round((valSpan / tickSpan) * 100) / 100 : null, distinctValues: new Set(vals.map((v) => v.toPrecision(6))).size },
        flaggedCount: res.flagged.length,
        cellCount: vals.length,
        excludedCount: res.excluded?.length ?? 0,
        valueRange: vals.length ? [Math.min(...vals), Math.max(...vals)] : null,
        tickRange: tickVals.length ? [Math.min(...tickVals), Math.max(...tickVals)] : null,
      };
    }

    // ------------------------------------------------------------ run

    // settings: {client, llmModel, reviewModel, pages: [n], maxSteps,
    // signal, onEvent(type, data), focus}. `focus`
    // ({panelId, note}) asks the agent to fix one rejected panel.
    async function run(settings) {
      const { client, llmModel, reviewModel, pages, maxSteps = 60, signal, onEvent = () => {}, focus } = settings;
      // Same evidence, same answer: a question id contains the hash of what
      // it judges, so repeated resolves never pay twice for it.
      const reviewCache = new Map();
      const usage = { llmCost: 0, reviewCost: 0, reviewMs: 0, promptTokens: 0, completionTokens: 0, steps: 0, reviews: 0 };
      const emit = (type, data) => onEvent(type, { ...data, usage: { ...usage } });
      // What the model has looked at and built, so it cannot stop after the
      // first heatmap (see finishCheck).
      const viewedPages = new Set();
      const finishState = { checked: false, refusals: 0 };
      const runPanels = () =>
        app.project.panels
          .filter((p) => p.tool === 'heatmap' && pages.includes(p.page))
          .map((p) => ({ id: p.id, name: p.name, page: p.page, ready: !ws.resultFor(p).error, started: !!(p.grid.corners || p.colorbar.start || p.grid.rowLabels.length || p.grid.colLabels.length) }));
      const progress = () => progressNote({ pages, viewedPages, panels: runPanels(), currentPage: ws.currentPage() });

      // One reviewer call per panel: its images and all its open checks.
      async function reviewPanel(pid, group) {
        await api.run('select_panel', { panelId: pid });
        const panel = app.project.panels.find((p) => p.id === pid);
        const context = await panelContext(pid);
        const items = group.map((q) => ({ q, item: toReviewItem(q, context) }));
        const images = reviewImages(panel);
        const { content, keys } = reviewContent({ panelName: panel.name, items, images });
        const t0 = performance.now();
        const res = await client.chat.send(
          {
            chatRequest: {
              model: reviewModel,
              messages: [{ role: 'system', content: REVIEWER_PROMPT }, { role: 'user', content }],
              tools: [reviewTool(items, keys)],
              toolChoice: { type: 'function', function: { name: 'answer' } },
              maxTokens: 2048,
              temperature: 0,
            },
          },
          { signal },
        );
        usage.reviewCost += res.usage?.cost || 0;
        usage.reviewMs += performance.now() - t0;
        usage.reviews++;
        const answers = parseReviewAnswers(res.choices?.[0]?.message);
        return items.map(({ q, item }, i) => {
          const raw = answers[keys[i]];
          fromReviewAnswer(q, item, raw); // throws on an invalid answer, so it is not cached
          reviewCache.set(q.id, { item, raw });
          return q.id;
        });
      }

      async function resolveQuestions(panelId) {
        const qr = await api.run('get_questions', panelId ? { panelId } : {});
        if (!qr.ok) return qr;
        // Skip questions already sent to a human in this run.
        const open = qr.result.filter((q) => !q.escalated);
        const errors = new Map(); // q.id → message
        const byPanel = new Map();
        for (const q of open.filter((x) => !reviewCache.has(x.id))) byPanel.set(q.panelId, [...(byPanel.get(q.panelId) || []), q]);
        const back = ws.activePanel()?.id;
        for (const [pid, group] of byPanel) {
          try {
            await reviewPanel(pid, group);
          } catch (err) {
            if (signal?.aborted) throw err;
            for (const q of group) errors.set(q.id, err.message);
          }
        }
        if (back && byPanel.size) await api.run('select_panel', { panelId: back });
        const results = [];
        // Answer one by one: applying one answer can change the others.
        for (const q of open) {
          let out;
          try {
            if (errors.has(q.id)) throw new Error(errors.get(q.id));
            const { item, raw } = reviewCache.get(q.id);
            out = fromReviewAnswer(q, item, raw);
          } catch (err) {
            results.push({ type: q.type, panelId: q.panelId, error: err.message });
            continue;
          }
          const r = await api.run('answer_question', { questionId: q.id, answer: out.answer, confidence: out.confidence ?? 0, source: 'reviewer', model: reviewModel });
          const item = { type: q.type, panelId: q.panelId, evidence: q.evidence, answer: out.answer, confidence: out.confidence, reason: out.reason, applied: r.ok ? r.result.applied : false, ...(r.ok ? {} : { error: r.error }) };
          results.push(item);
          emit('review', item);
        }
        const panelName = (id) => app.project.panels.find((p) => p.id === id)?.name || id;
        const advice = reviewAdvice(results, panelName);
        return { ok: true, result: { reviews: results, advice, stillOpen: (await api.run('get_questions', panelId ? { panelId } : {})).result?.length ?? 0, next: progress() } };
      }

      async function callTool(name, args) {
        if (LLM_ACTIONS.includes(name)) {
          if (name === 'go_to_page' && !pages.includes(args.page)) return { ok: false, error: `Page ${args.page} is not part of this run (pages ${pages.join(', ')}).` };
          const r = await api.run(name, args);
          // Keep results small: the active panel instead of the full state.
          if (r.state) {
            const { state, ...rest } = r;
            return { ...rest, activePanel: state.panels.find((p) => p.id === state.activePanelId), page: state.source?.page };
          }
          return r;
        }
        if (!RUNNER_TOOLS[name]) return { ok: false, error: `Unknown tool "${name}".` };
        const errs = validateRunnerTool(name, args);
        if (errs.length) return { ok: false, error: errs.join('; ') };
        if (name === 'view_page') {
          const image = renderView(args);
          viewedPages.add(ws.currentPage());
          return { ok: true, image };
        }
        if (name === 'view_pages_overview') return { ok: true, image: await renderOverview(args.from, args.to) };
        if (name === 'resolve_questions') return resolveQuestions(args.panelId);
        if (name === 'finish' && !focus) {
          const why = finishCheck({ pages, viewedPages, panels: runPanels(), ...finishState });
          if (why) {
            finishState.refusals++;
            if (why.checklist) finishState.checked = true;
            emit('assistant', { text: `(finish refused) ${why.message}` });
            return { ok: true, finished: false, result: why.message };
          }
        }
        return { ok: true, result: null };
      }

      const s = app.project.source;
      const first = await api.run('go_to_page', { page: pages[0] });
      const panelsNow = (await api.run('get_state')).result.panels;
      const target = focus && panelsNow.find((p) => p.id === focus.panelId);
      const focusText = target
        ? `\n\nThis is a redo. A reviewer rejected panel "${target.name}" (id ${target.id})${focus.note ? ` with the note: "${focus.note}"` : ''}. Its current calibration: ${JSON.stringify({ grid: target.grid, colorbar: target.colorbar })}. Do not add panels. select_panel it, find what is wrong (grid corners, grid size, colorbar ends, ticks or scale), fix it, check with overlays, then resolve_questions and finish.`
        : '';
      if (!first.ok) throw new Error(first.error);
      const opening = pages.length > 1 && app.pdfDoc ? await renderOverview(pages[0], pages[Math.min(pages.length, 12) - 1]) : renderView();
      if (!(pages.length > 1 && app.pdfDoc)) viewedPages.add(ws.currentPage());
      const messages = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `File: ${s.fileName} (${s.pageCount} page${s.pageCount === 1 ? '' : 's'}). Process page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}. Page images are ${s.width} × ${s.height} px. Existing panels: ${JSON.stringify(panelsNow.map((p) => ({ id: p.id, name: p.name, page: p.page, ready: p.ready, review: p.review?.status })))}.${focusText}\n${opening.note}`,
            },
            { type: 'image_url', imageUrl: { url: opening.dataUrl } },
          ],
        },
      ];
      const tools = llmTools();
      let nudges = 0;
      const guard = createRetryGuard();
      let summary = null;

      while (usage.steps < maxSteps && summary === null) {
        if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
        usage.steps++;
        emit('thinking', { step: usage.steps });
        const res = await client.chat.send({ chatRequest: { model: llmModel, messages: pruneImages(messages), tools, toolChoice: 'auto', maxTokens: 4096 } }, { signal });
        const msg = res.choices?.[0]?.message;
        if (!msg) throw new Error('The model returned no message.');
        usage.llmCost += res.usage?.cost || 0;
        usage.promptTokens += res.usage?.promptTokens || 0;
        usage.completionTokens += res.usage?.completionTokens || 0;
        messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.toolCalls?.length ? { toolCalls: msg.toolCalls } : {}) });
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text.trim()) emit('assistant', { text });
        if (!msg.toolCalls?.length) {
          if (++nudges > 2) break;
          messages.push({ role: 'user', content: `Continue with the tools. ${progress()} Call finish only when every heatmap on every page has its own calibrated panel.` });
          continue;
        }
        nudges = 0;
        const images = [];
        for (const call of msg.toolCalls) {
          let args;
          let result;
          try {
            args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            result = { ok: false, error: 'Arguments are not valid JSON.' };
          }
          const name = call.function.name;
          // Retries are counted per tool and panel (the one named, else the active one).
          const panelKey = args?.panelId || (name === 'resolve_questions' ? 'all' : ws.activePanel()?.id);
          if (!result) {
            emit('tool', { name, args });
            result = guard.before(name, panelKey);
            if (!result) {
              try {
                result = await callTool(name, args);
              } catch (err) {
                if (signal?.aborted) throw err;
                result = { ok: false, error: err.message };
              }
            }
          }
          result = guard.after(name, panelKey, result);
          if (call.function.name === 'finish' && result.ok && result.finished !== false) summary = args.summary;
          if (result.image) {
            images.push(result.image);
            result = { ok: true, result: `${result.image.note} The image follows.` };
          }
          if (!result.ok) emit('tool-error', { name: call.function.name, error: result.error });
          messages.push({ role: 'tool', toolCallId: call.id, content: toolResultText(result) });
        }
        if (images.length) {
          messages.push({ role: 'user', content: images.flatMap((im) => [{ type: 'text', text: im.note }, { type: 'image_url', imageUrl: { url: im.dataUrl } }]) });
        }
        if (guard.stop) {
          emit('tool-error', { name: 'run', error: `Stopped: ${guard.stop}` });
          summary = `Stopped because ${guard.stop}.`;
        }
      }

      // Every panel gets its checks, even if the model stopped early.
      if (!signal?.aborted) await resolveQuestions();
      const out = { summary: summary ?? (usage.steps >= maxSteps ? `Stopped after ${maxSteps} steps.` : 'The model stopped without a summary.'), usage };
      emit('done', out);
      return out;
    }

    return { run, renderView, renderOverview };
  }

  Object.assign(CM, { createAgentRunner });
})((globalThis.Colormeris ??= {}));
