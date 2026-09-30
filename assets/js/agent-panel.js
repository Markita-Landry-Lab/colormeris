(function (CM) {
  'use strict';
  const { createAgentRunner, parsePages, cellSamplePolygon, DEFAULT_LLM, DEFAULT_REVIEWER } = CM;

  // Agent card of the heatmap tool: OpenRouter key and model choice, running
  // and stopping the agent, its log, and the checks left for a human.
  // The OpenRouter SDK (assets/vendor/openrouter) is loaded on first use.

  const SDK_SRC = 'assets/vendor/openrouter/openrouter.min.js';
  const STORE = 'colormeris.agent';

  function setupAgentPanel(ws, api) {
    const { $, app } = ws;
    const runner = createAgentRunner(ws, api);
    let abort = null;

    // ------------------------------------------------------------ settings

    const load = () => {
      try {
        return JSON.parse(localStorage.getItem(STORE)) || {};
      } catch {
        return {};
      }
    };
    const saved = load();
    $('agent-llm').value = saved.llm || DEFAULT_LLM;
    $('agent-reviewer').value = saved.reviewer || DEFAULT_REVIEWER;
    $('agent-minconf').value = saved.minConfidence ?? 0.9;
    $('agent-steps').value = saved.maxSteps ?? 80;
    $('agent-base').value = saved.base || '';
    $('agent-key').value = saved.key || '';
    $('agent-remember').checked = !!saved.key;
    if (saved.key) $('agent-settings').open = false;

    function save() {
      const s = {
        llm: $('agent-llm').value.trim(),
        reviewer: $('agent-reviewer').value.trim(),
        minConfidence: Number($('agent-minconf').value),
        maxSteps: Number($('agent-steps').value),
        base: $('agent-base').value.trim(),
        ...($('agent-remember').checked ? { key: $('agent-key').value.trim() } : {}),
      };
      try {
        localStorage.setItem(STORE, JSON.stringify(s));
      } catch {
        // Storage can be unavailable (private windows, file://); settings then last for this visit.
      }
    }
    for (const id of ['agent-llm', 'agent-reviewer', 'agent-minconf', 'agent-steps', 'agent-base', 'agent-key', 'agent-remember']) {
      $(id).addEventListener('change', () => {
        save();
        updateButtons();
      });
    }
    $('agent-key').addEventListener('input', updateButtons);
    $('agent-base').addEventListener('input', updateButtons);
    $('agent-pages').addEventListener('change', () => ($('agent-range').hidden = $('agent-pages').value !== 'range'));

    // ------------------------------------------------------------ SDK

    let sdkPromise = null;
    function loadSdk() {
      if (globalThis.OpenRouterSDK) return Promise.resolve(globalThis.OpenRouterSDK);
      sdkPromise ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SDK_SRC;
        s.onload = () => resolve(globalThis.OpenRouterSDK);
        s.onerror = () => {
          sdkPromise = null;
          reject(new Error('Could not load the OpenRouter SDK.'));
        };
        document.head.append(s);
      });
      return sdkPromise;
    }

    function makeClient(sdk, key) {
      const base = $('agent-base').value.trim();
      return new sdk.OpenRouter({
        // Behind a proxy the key can be empty; the proxy replaces this header.
        apiKey: key || 'proxy',
        appTitle: 'Colormeris',
        ...(location.protocol.startsWith('http') ? { httpReferer: location.origin } : {}),
        ...(base ? { serverURL: base } : {}),
      });
    }

    // Model lists for the pickers (public; no key needed).
    let modelsLoaded = false;
    async function loadModels() {
      if (modelsLoaded) return;
      modelsLoaded = true;
      try {
        const client = makeClient(await loadSdk(), $('agent-key').value.trim() || undefined);
        const collect = async (req) => {
          const out = [];
          for await (const page of await client.models.list(req)) out.push(...page.result.data);
          return out;
        };
        // One list serves both pickers: the reviewer also needs images and tools.
        const llms = await collect({ inputModalities: 'image', supportedParameters: 'tools' });
        fill('agent-llm-list', llms.filter((m) => !m.id.endsWith(':batch')));
      } catch (err) {
        modelsLoaded = false;
        console.warn('Could not list OpenRouter models', err);
      }
    }
    function fill(listId, models) {
      $(listId).replaceChildren(
        ...models.map((m) => Object.assign(document.createElement('option'), { value: m.id, label: m.name || m.id })),
      );
    }
    $('agent-llm').addEventListener('focus', loadModels);
    $('agent-reviewer').addEventListener('focus', loadModels);

    // ------------------------------------------------------------ run

    function updateButtons() {
      const running = !!abort;
      $('agent-run').disabled = running || !app.sourceCanvas || !hasKeyOrProxy();
      $('agent-run').hidden = running;
      $('agent-stop').hidden = !running;
      $('agent-badge').textContent = running ? 'running' : 'off';
      $('agent-badge').className = `badge${running ? ' todo' : ''}`;
      if (!running) {
        const why = !app.sourceCanvas ? 'Open a file first.' : !hasKeyOrProxy() ? 'Enter your OpenRouter key.' : '';
        if (why || $('agent-status').dataset.idle !== 'done') {
          $('agent-status').textContent = why;
          $('agent-status').dataset.idle = '';
        }
      }
    }

    // A key, or a base URL (a local proxy such as scripts/openrouter-proxy.mjs adds the key itself).
    const hasKeyOrProxy = () => !!($('agent-key').value.trim() || $('agent-base').value.trim());

    function selectedPages() {
      const n = app.project.source.pageCount;
      const mode = $('agent-pages').value;
      if (mode === 'current') return [ws.currentPage()];
      if (mode === 'all') return Array.from({ length: n }, (_, i) => i + 1);
      return parsePages($('agent-range').value, n);
    }

    const money = (v) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
    const pct = (v) => (v === null || v === undefined ? '?' : `${Math.round(v * 100)}%`);

    function log(cls, text) {
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      $('agent-log').hidden = false;
      $('agent-log').append(li);
      $('agent-log').scrollTop = $('agent-log').scrollHeight;
    }

    function answerText(a) {
      return typeof a === 'string' ? a : a && typeof a === 'object' ? Object.entries(a).map(([k, v]) => `${k} ${v}`).join(', ') : String(a);
    }

    function onEvent(type, data) {
      const u = data.usage;
      $('agent-status').textContent = `Step ${u.steps} · ${u.reviews} reviews · ${money(u.llmCost + u.reviewCost)}`;
      if (type === 'assistant') log('assistant', data.text);
      else if (type === 'tool') log('tool', `${data.name}(${data.args && Object.keys(data.args).length ? JSON.stringify(data.args) : ''})`);
      else if (type === 'tool-error') log('error', `${data.name}: ${data.error}`);
      else if (type === 'review') {
        const name = panelName(data.panelId);
        log(data.applied ? 'review' : 'escalated', `${name} · ${data.type.replaceAll('_', ' ')}: ${answerText(data.answer)} (${pct(data.confidence)})${data.applied ? '' : ' → needs review'}${data.reason ? ` · ${data.reason}` : ''}${data.error ? ` · ${data.error}` : ''}`);
        renderReview();
      } else if (type === 'done') log('done', data.summary);
    }

    const panelName = (id) => app.project.panels.find((p) => p.id === id)?.name || id;

    // focus: {panelId, note} to redo one rejected panel on its own page.
    async function start(focus = null) {
      if (abort) return;
      const key = $('agent-key').value.trim();
      let pages;
      try {
        pages = focus ? [app.project.panels.find((p) => p.id === focus.panelId).page] : selectedPages();
      } catch (err) {
        ws.toast(err.message, true);
        return;
      }
      const minConfidence = Number($('agent-minconf').value);
      if (!(minConfidence >= 0 && minConfidence <= 1)) {
        ws.toast('Min. confidence must be between 0 and 1.', true);
        return;
      }
      api.policy.minConfidence = minConfidence;
      save();
      abort = new AbortController();
      $('agent-log').replaceChildren();
      $('agent-status').dataset.idle = '';
      updateButtons();
      log('tool', `${focus ? `Redoing ${panelName(focus.panelId)}` : 'Running'} with ${$('agent-llm').value.trim()} and ${$('agent-reviewer').value.trim()} on page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}.`);
      try {
        const sdk = await loadSdk();
        const out = await runner.run({
          client: makeClient(sdk, key),
          llmModel: $('agent-llm').value.trim() || DEFAULT_LLM,
          reviewModel: $('agent-reviewer').value.trim() || DEFAULT_REVIEWER,
          pages,
          maxSteps: Number($('agent-steps').value) || 80,
          signal: abort.signal,
          onEvent,
          focus,
        });
        $('agent-status').textContent = `Done: ${out.usage.steps} steps, ${out.usage.reviews} reviews, ${money(out.usage.llmCost + out.usage.reviewCost)}.`;
      } catch (err) {
        if (err.name === 'AbortError' || abort?.signal.aborted) {
          log('error', 'Stopped.');
          $('agent-status').textContent = 'Stopped.';
        } else {
          console.error(err);
          log('error', errorText(err));
          $('agent-status').textContent = `Failed: ${errorText(err)}`;
          ws.toast(`Agent stopped: ${errorText(err)}`, true);
        }
      } finally {
        abort = null;
        $('agent-status').dataset.idle = 'done';
        updateButtons();
        renderReview();
      }
    }

    function errorText(err) {
      const status = err.statusCode || err.status;
      if (status === 401) return 'The API key was rejected (401).';
      if (status === 402) return 'The OpenRouter account has no credit left (402).';
      if (status === 404) return `Model not found (404): ${err.message}`;
      return err.message || String(err);
    }

    $('agent-run').addEventListener('click', () => start());
    $('agent-stop').addEventListener('click', () => abort?.abort());

    // ------------------------------------------------------------ review

    // Needs review: checks the reviewer was not sure enough about, and
    // panels whose extraction was rejected. Human answers apply at once and
    // are logged with source "human".
    let reviewTimer = null;
    const scheduleReview = () => {
      clearTimeout(reviewTimer);
      reviewTimer = setTimeout(renderReview, 300);
    };

    async function renderReview() {
      if (!app.sourceCanvas) return;
      const r = await api.run('get_questions');
      const questions = (r.ok ? r.result : []).filter((q) => q.escalated);
      const rejected = app.project.panels.filter((p) => ws.reviewStatus?.(p) === 'rejected');
      $('agent-review').hidden = !questions.length && !rejected.length;
      $('agent-review-list').replaceChildren(...rejected.map(rejectedItem), ...questions.map(reviewItem));
    }

    function reviewItem(q) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.textContent = `${panelName(q.panelId)}: ${q.prompt}`;
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = `${q.escalated.source || 'The model'} suggested ${answerText(q.escalated.answer)} (${pct(q.escalated.confidence)} sure)`;
      const row = document.createElement('div');
      row.className = 'row tight';
      row.append(button('Show', 'ghost', () => showPanel(q.panelId, q)));
      if (q.type === 'confirm_grid_size') {
        const init = q.escalated.answer || q.suggested;
        const rows = Object.assign(document.createElement('input'), { type: 'number', min: 1, value: init.rows, className: 'num', title: 'Rows' });
        const cols = Object.assign(document.createElement('input'), { type: 'number', min: 1, value: init.cols, className: 'num', title: 'Columns' });
        row.append(rows, '×', cols, button('Apply', '', () => answer(q, { rows: Number(rows.value), cols: Number(cols.value) })));
      } else if (q.type === 'confirm_extraction') {
        // A review of the panel as it is now, so it also works after the
        // values changed since the question was asked.
        // Reject keeps the panel to fix or redo; Delete is the hard no.
        row.append(
          button('Accept', q.escalated.answer === 'accept' ? 'active' : '', () => review(q.panelId, 'accepted')),
          button('Reject', `danger${q.escalated.answer === 'reject' ? ' active' : ''}`, () => review(q.panelId, 'rejected')),
          deleteButton(q.panelId),
        );
      } else {
        for (const opt of q.answerSchema.enum) row.append(button(opt.replaceAll('_', ' '), opt === q.escalated.answer ? 'active' : '', () => answer(q, opt)));
      }
      li.append(head, hint, row);
      return li;
    }

    function rejectedItem(panel) {
      const li = document.createElement('li');
      li.className = 'rejected';
      const head = document.createElement('div');
      const rv = panel.review;
      head.textContent = `${panel.name} was rejected${rv.by ? ` by ${rv.by}` : ''}${rv.by !== 'human' && Number.isFinite(rv.confidence) ? ` (${pct(rv.confidence)} sure)` : ''}. Fix it by hand, or let the agent redo it.`;
      const note = Object.assign(document.createElement('input'), { type: 'text', value: rv.note || '', placeholder: 'What is wrong? (optional, passed to the agent)', spellcheck: false });
      note.addEventListener('change', () => (panel.review.note = note.value.trim()));
      const row = document.createElement('div');
      row.className = 'row tight';
      const redo = button('Redo with agent', 'primary', () => start({ panelId: panel.id, note: note.value.trim() }));
      redo.disabled = !!abort || !hasKeyOrProxy();
      row.append(button('Show', 'ghost', () => showPanel(panel.id)), redo, button('Accept anyway', '', () => review(panel.id, 'accepted')), deleteButton(panel.id));
      li.append(head, note, row);
      return li;
    }

    // Deletes the panel with its calibration (undo restores it); the last
    // panel of a page is cleared instead.
    function deleteButton(panelId) {
      const b = button('Delete panel', 'danger', async () => {
        const name = panelName(panelId);
        const r = await api.run('remove_panel', { panelId });
        if (!r.ok) ws.toast(r.error, true);
        else ws.toast(`${name} ${r.result.cleared ? 'cleared' : 'deleted'}. Undo brings it back.`);
        renderReview();
      });
      b.disabled = !!abort;
      b.title = 'Delete this panel and its extraction (undo restores it)';
      return b;
    }

    function button(text, cls, onClick) {
      const b = Object.assign(document.createElement('button'), { textContent: text, className: `btn small ${cls}`.trim() });
      b.addEventListener('click', onClick);
      return b;
    }

    async function showPanel(panelId, q = null) {
      await api.run('select_panel', { panelId });
      const panel = app.project.panels.find((p) => p.id === panelId);
      if (q?.type === 'classify_flagged' && panel?.grid.corners) ws.zoomToPoints(cellSamplePolygon(panel.grid, q.evidence.row, q.evidence.col));
      else if (panel?.grid.corners) ws.zoomToPoints(panel.grid.corners);
    }

    async function answer(q, value) {
      const r = await api.run('answer_question', { questionId: q.id, answer: value, confidence: 1, source: 'human' });
      if (!r.ok) ws.toast(r.error, true);
      renderReview();
    }

    async function review(panelId, status) {
      const r = await api.run('set_review', { panelId, status, source: 'human' });
      if (!r.ok) ws.toast(r.error, true);
      else ws.toast(status === 'rejected' ? `${panelName(panelId)} rejected. Fix it or use Redo with agent.` : `${panelName(panelId)} accepted.`);
      renderReview();
    }

    ws.onChange(() => {
      updateButtons();
      if (!abort) scheduleReview();
    });
    updateButtons();
    return { runner };
  }

  Object.assign(CM, { setupAgentPanel });
})((globalThis.Colormeris ??= {}));
