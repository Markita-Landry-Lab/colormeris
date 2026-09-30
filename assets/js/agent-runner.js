(function (CM) {
  'use strict';
  const {
    AGENT_SYSTEM_PROMPT, LLM_ACTIONS, RUNNER_TOOLS, validateRunnerTool, llmTools, toDecisionRequest, fromDecisionAnswer, pruneImages, toolResultText,
    bilinear, cellSamplePolygon, colorAtT, rgbToHex, ticksWithT, renderPdfPage,
  } = CM;

  // Runs the extraction agent: an LLM (any OpenRouter chat model with vision
  // and tools) drives the page through the typed agent API and looks at it
  // through rendered page images with pixel rulers; a decision model (Jev or
  // another OpenRouter decisions model) answers the typed checks. `client` is
  // an OpenRouter SDK client (or anything with chat.send and
  // alpha.decisions.create).

  const MAX_VIEW = 1024; // longest side of images sent to the LLM
  const RULER = { left: 46, top: 22 };

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
    function renderView({ region, overlay = 'none' } = {}) {
      const page = app.pages.get(ws.currentPage());
      if (!page) throw new Error('No page is shown.');
      const src = page.canvas;
      let { x0, y0, x1, y1 } = region || { x0: 0, y0: 0, x1: src.width, y1: src.height };
      [x0, x1] = [Math.max(0, Math.min(x0, x1)), Math.min(src.width, Math.max(x0, x1))];
      [y0, y1] = [Math.max(0, Math.min(y0, y1)), Math.min(src.height, Math.max(y0, y1))];
      const w = x1 - x0;
      const h = y1 - y0;
      if (w < 4 || h < 4) throw new Error('Region is too small or outside the page.');
      const scale = Math.min(6, MAX_VIEW / Math.max(w, h));
      const out = document.createElement('canvas');
      out.width = Math.round(w * scale) + RULER.left;
      out.height = Math.round(h * scale) + RULER.top;
      const ctx = out.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(src, x0, y0, w, h, RULER.left, RULER.top, w * scale, h * scale);
      const toView = (p) => ({ x: RULER.left + (p.x - x0) * scale, y: RULER.top + (p.y - y0) * scale });

      if (overlay !== 'none') drawPanels(ctx, toView, scale, overlay);

      // Rulers with faint guide lines.
      const step = niceStep(scale);
      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#000';
      ctx.strokeStyle = 'rgba(0, 170, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.textAlign = 'center';
      for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
        const vx = Math.round(toView({ x, y: 0 }).x) + 0.5;
        ctx.beginPath();
        ctx.moveTo(vx, RULER.top - 5);
        ctx.lineTo(vx, out.height);
        ctx.stroke();
        ctx.fillText(String(Math.round(x)), vx, RULER.top - 8);
      }
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
        const vy = Math.round(toView({ x: 0, y }).y) + 0.5;
        ctx.beginPath();
        ctx.moveTo(RULER.left - 5, vy);
        ctx.lineTo(out.width, vy);
        ctx.stroke();
        ctx.fillText(String(Math.round(y)), RULER.left - 7, vy);
      }
      ws.zoomToPoints([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
      return { dataUrl: out.toDataURL('image/jpeg', 0.9), note: `Page ${ws.currentPage()}, x ${Math.round(x0)}–${Math.round(x1)}, y ${Math.round(y0)}–${Math.round(y1)} px, shown at ${scale.toFixed(2)}× with rulers in page pixels.` };
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

    // ------------------------------------------------------------ decisions

    async function decide(client, model, body, signal, serverURL) {
      const res = await client.alpha.decisions.create({ decisionsRequest: { model, ...body } }, { signal, ...(serverURL ? { serverURL } : {}) });
      return res;
    }

    // Context a question needs beyond its own evidence.
    async function panelContext(panelId) {
      const r = await api.run('get_results', { panelId });
      const res = r.result;
      if (!r.ok || !res || res.error) return {};
      const vals = res.values.flat().filter(Number.isFinite);
      const panel = app.project.panels.find((p) => p.id === panelId);
      const tickVals = panel.colorbar.ticks.map((k) => k.value).filter(Number.isFinite);
      return {
        flaggedCount: res.flagged.length,
        cellCount: vals.length,
        excludedCount: res.excluded?.length ?? 0,
        valueRange: vals.length ? [Math.min(...vals), Math.max(...vals)] : null,
        tickRange: tickVals.length ? [Math.min(...tickVals), Math.max(...tickVals)] : null,
      };
    }

    // ------------------------------------------------------------ run

    // settings: {client, llmModel, decisionModel, pages: [n], maxSteps,
    // decisionServerURL, signal, onEvent(type, data)}
    async function run(settings) {
      const { client, llmModel, decisionModel, pages, maxSteps = 60, signal, onEvent = () => {}, decisionServerURL } = settings;
      const usage = { llmCost: 0, decisionCost: 0, promptTokens: 0, completionTokens: 0, steps: 0, decisions: 0 };
      const emit = (type, data) => onEvent(type, { ...data, usage: { ...usage } });

      async function resolveQuestions(panelId) {
        const qr = await api.run('get_questions', panelId ? { panelId } : {});
        if (!qr.ok) return qr;
        // Skip questions already sent to a human in this run.
        const open = qr.result.filter((q) => !q.escalated);
        const contexts = new Map();
        const outcomes = await Promise.all(
          open.map(async (q) => {
            try {
              if (!contexts.has(q.panelId)) contexts.set(q.panelId, panelContext(q.panelId));
              const req = toDecisionRequest(q, await contexts.get(q.panelId));
              const res = await decide(client, decisionModel, { state: req.state, questions: req.questions }, signal, decisionServerURL);
              usage.decisionCost += res.usage?.cost || 0;
              usage.decisions++;
              const { answer, confidence } = fromDecisionAnswer(q, req, res.answers?.answer);
              return { q, answer, confidence };
            } catch (err) {
              if (signal?.aborted) throw err;
              return { q, error: err.message };
            }
          }),
        );
        const results = [];
        // Answer one by one: applying one decision can change the others.
        for (const o of outcomes) {
          if (o.error) {
            results.push({ type: o.q.type, panelId: o.q.panelId, error: o.error });
            continue;
          }
          const r = await api.run('answer_question', { questionId: o.q.id, answer: o.answer, confidence: o.confidence ?? 0, source: 'decision-model', model: decisionModel });
          const item = { type: o.q.type, panelId: o.q.panelId, evidence: o.q.evidence, answer: o.answer, confidence: o.confidence, applied: r.ok ? r.result.applied : false, ...(r.ok ? {} : { error: r.error }) };
          results.push(item);
          emit('decision', item);
        }
        return { ok: true, result: { decisions: results, stillOpen: (await api.run('get_questions', panelId ? { panelId } : {})).result?.length ?? 0 } };
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
        if (name === 'view_page') return { ok: true, image: renderView(args) };
        if (name === 'view_pages_overview') return { ok: true, image: await renderOverview(args.from, args.to) };
        if (name === 'resolve_questions') return resolveQuestions(args.panelId);
        if (name === 'decide') {
          const res = await decide(client, decisionModel, { state: args.state, questions: args.questions }, signal, decisionServerURL);
          usage.decisionCost += res.usage?.cost || 0;
          usage.decisions++;
          emit('decide', { questions: args.questions, answers: res.answers });
          return { ok: true, result: res.answers };
        }
        return { ok: true, result: null };
      }

      const s = app.project.source;
      const first = await api.run('go_to_page', { page: pages[0] });
      if (!first.ok) throw new Error(first.error);
      const opening = pages.length > 1 && app.pdfDoc ? await renderOverview(pages[0], pages[Math.min(pages.length, 12) - 1]) : renderView();
      const messages = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `File: ${s.fileName} (${s.pageCount} page${s.pageCount === 1 ? '' : 's'}). Process page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}. Page images are ${s.width} × ${s.height} px. Existing panels: ${JSON.stringify((await api.run('get_state')).result.panels.map((p) => ({ id: p.id, name: p.name, page: p.page, ready: p.ready })))}.\n${opening.note}`,
            },
            { type: 'image_url', imageUrl: { url: opening.dataUrl } },
          ],
        },
      ];
      const tools = llmTools();
      let nudges = 0;
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
          messages.push({ role: 'user', content: 'Continue with the tools. Call finish when every page is done.' });
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
          if (!result) {
            emit('tool', { name: call.function.name, args });
            try {
              result = await callTool(call.function.name, args);
            } catch (err) {
              if (signal?.aborted) throw err;
              result = { ok: false, error: err.message };
            }
          }
          if (call.function.name === 'finish' && result.ok) summary = args.summary;
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
