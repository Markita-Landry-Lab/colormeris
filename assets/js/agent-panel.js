(function (CM) {
  'use strict';
  const { createAgentRunner, parsePages, cellSamplePolygon, DEFAULT_LLM, DEFAULT_DECISION_MODEL } = CM;

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
    $('agent-jev').value = saved.jev || DEFAULT_DECISION_MODEL;
    $('agent-minconf').value = saved.minConfidence ?? 0.9;
    $('agent-steps').value = saved.maxSteps ?? 80;
    $('agent-base').value = saved.base || '';
    $('agent-key').value = saved.key || '';
    $('agent-remember').checked = !!saved.key;
    if (saved.key) $('agent-settings').open = false;

    function save() {
      const s = {
        llm: $('agent-llm').value.trim(),
        jev: $('agent-jev').value.trim(),
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
    for (const id of ['agent-llm', 'agent-jev', 'agent-minconf', 'agent-steps', 'agent-base', 'agent-key', 'agent-remember']) {
      $(id).addEventListener('change', () => {
        save();
        updateButtons();
      });
    }
    $('agent-key').addEventListener('input', updateButtons);
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
        apiKey: key,
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
        const [llms, deciders] = await Promise.all([
          collect({ inputModalities: 'image', supportedParameters: 'tools' }),
          collect({ outputModalities: 'decisions' }),
        ]);
        fill('agent-llm-list', llms.filter((m) => !m.id.endsWith(':batch')));
        fill('agent-jev-list', deciders);
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
    $('agent-jev').addEventListener('focus', loadModels);

    // ------------------------------------------------------------ run

    function updateButtons() {
      const running = !!abort;
      $('agent-run').disabled = running || !app.sourceCanvas || !$('agent-key').value.trim();
      $('agent-run').hidden = running;
      $('agent-stop').hidden = !running;
      $('agent-badge').textContent = running ? 'running' : 'off';
      $('agent-badge').className = `badge${running ? ' todo' : ''}`;
      if (!running) {
        const why = !app.sourceCanvas ? 'Open a file first.' : !$('agent-key').value.trim() ? 'Enter your OpenRouter key.' : '';
        if (why || $('agent-status').dataset.idle !== 'done') {
          $('agent-status').textContent = why;
          $('agent-status').dataset.idle = '';
        }
      }
    }

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
      $('agent-status').textContent = `Step ${u.steps} · ${u.decisions} decisions · ${money(u.llmCost + u.decisionCost)}`;
      if (type === 'assistant') log('assistant', data.text);
      else if (type === 'tool') log('tool', `${data.name}(${data.args && Object.keys(data.args).length ? JSON.stringify(data.args) : ''})`);
      else if (type === 'tool-error') log('error', `${data.name}: ${data.error}`);
      else if (type === 'decision') {
        const name = panelName(data.panelId);
        log(data.applied ? 'decision' : 'escalated', `${name} · ${data.type.replaceAll('_', ' ')}: ${answerText(data.answer)} (${pct(data.confidence)})${data.applied ? '' : ' → needs review'}${data.error ? ` · ${data.error}` : ''}`);
        renderReview();
      } else if (type === 'decide') {
        log('decision', `decide: ${Object.entries(data.answers || {}).map(([k, a]) => `${k} = ${a.type === 'noul' ? pct(a.noul) : `${a.choice ?? a.score} (${pct(a.confidence)})`}`).join('; ')}`);
      } else if (type === 'done') log('done', data.summary);
    }

    const panelName = (id) => app.project.panels.find((p) => p.id === id)?.name || id;

    async function start() {
      const key = $('agent-key').value.trim();
      let pages;
      try {
        pages = selectedPages();
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
      log('tool', `Running ${$('agent-llm').value.trim()} with ${$('agent-jev').value.trim()} on page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}.`);
      try {
        const sdk = await loadSdk();
        const base = $('agent-base').value.trim();
        const out = await runner.run({
          client: makeClient(sdk, key),
          llmModel: $('agent-llm').value.trim() || DEFAULT_LLM,
          decisionModel: $('agent-jev').value.trim() || DEFAULT_DECISION_MODEL,
          decisionServerURL: base ? new URL(base).origin : undefined,
          pages,
          maxSteps: Number($('agent-steps').value) || 80,
          signal: abort.signal,
          onEvent,
        });
        $('agent-status').textContent = `Done: ${out.usage.steps} steps, ${out.usage.decisions} decisions, ${money(out.usage.llmCost + out.usage.decisionCost)}.`;
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

    $('agent-run').addEventListener('click', start);
    $('agent-stop').addEventListener('click', () => abort?.abort());

    // ------------------------------------------------------------ review

    // Checks the decision model was not sure enough about. A human answer
    // is applied and logged with source "human".
    async function renderReview() {
      if (!app.sourceCanvas) return;
      const r = await api.run('get_questions');
      const items = (r.ok ? r.result : []).filter((q) => q.escalated);
      $('agent-review').hidden = !items.length;
      $('agent-review-list').replaceChildren(...items.map(reviewItem));
    }

    function reviewItem(q) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      head.textContent = `${panelName(q.panelId)}: ${q.prompt}`;
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.textContent = `${q.escalated.source}${q.escalated.source ? ' suggested' : ''} ${answerText(q.escalated.answer)} (${pct(q.escalated.confidence)})`;
      const row = document.createElement('div');
      row.className = 'row tight';
      const show = button('Show', 'ghost', () => showQuestion(q));
      row.append(show);
      if (q.type === 'confirm_grid_size') {
        const init = q.escalated.answer || q.suggested;
        const rows = Object.assign(document.createElement('input'), { type: 'number', min: 1, value: init.rows, className: 'num', title: 'Rows' });
        const cols = Object.assign(document.createElement('input'), { type: 'number', min: 1, value: init.cols, className: 'num', title: 'Columns' });
        row.append(rows, '×', cols, button('Apply', '', () => answer(q, { rows: Number(rows.value), cols: Number(cols.value) })));
      } else {
        for (const opt of q.answerSchema.enum) row.append(button(opt.replaceAll('_', ' '), opt === q.escalated.answer ? 'active' : '', () => answer(q, opt)));
      }
      li.append(head, hint, row);
      return li;
    }

    function button(text, cls, onClick) {
      const b = Object.assign(document.createElement('button'), { textContent: text, className: `btn small ${cls}`.trim() });
      b.addEventListener('click', onClick);
      return b;
    }

    async function showQuestion(q) {
      await api.run('select_panel', { panelId: q.panelId });
      const panel = app.project.panels.find((p) => p.id === q.panelId);
      if (q.type === 'classify_flagged' && panel?.grid.corners) ws.zoomToPoints(cellSamplePolygon(panel.grid, q.evidence.row, q.evidence.col));
      else if (panel?.grid.corners) ws.zoomToPoints(panel.grid.corners);
    }

    async function answer(q, value) {
      const r = await api.run('answer_question', { questionId: q.id, answer: value, confidence: 1, source: 'human' });
      if (!r.ok) ws.toast(r.error, true);
      renderReview();
    }

    ws.onChange(updateButtons);
    updateButtons();
    return { runner };
  }

  Object.assign(CM, { setupAgentPanel });
})((globalThis.Colormeris ??= {}));
