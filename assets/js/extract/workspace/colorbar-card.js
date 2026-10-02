(function (CM) {
  'use strict';
  const { ticksWithT, pointAtT, colorAtT, readPixel, rgbToHex, makeValueFn, sampleColorbar } = CM;

  // The Colorbar card: ends, the tick table, the sampled strip and the
  // suggested reference colormap.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (commit, changed, resultFor, ...).
  function setupWorkspaceColorbarCard(w) {
    const { $, app } = w;

    function renderColorbarCard(panel) {
      const cb = panel.colorbar;
      w.setValue($('bar-scale'), cb.scale);
      w.setValue($('bar-halfwidth'), Math.round(cb.halfWidth * 10) / 10);
      const validTicks = ticksWithT(cb).filter((k) => Number.isFinite(k.value)).length;
      w.setBadge(
        $('bar-state'),
        !cb.start ? 'not placed' : `${validTicks} tick${validTicks === 1 ? '' : 's'}`,
        !!cb.start && validTicks >= 2,
      );
      $('tick-add').disabled = !cb.start;
      w.setNextStep($('bar-place'), !cb.start);
      w.setNextStep($('tick-add'), !!cb.start && validTicks < 2);
      $('bar-zoom').disabled = !cb.start;
      renderTicks(cb);
      renderBarStrip(panel);
      scheduleBarMatch(panel);
    }

    let tickKey = '';
    function renderTicks(cb) {
      const ticks = ticksWithT(cb);
      const tbody = $('tick-list');
      const key = ticks.map((k) => k.id).join(',');
      $('tick-empty').hidden = ticks.length > 0;
      tbody.closest('table').hidden = ticks.length === 0;
      if (key !== tickKey) {
        tickKey = key;
        tbody.replaceChildren(
          ...ticks.map((k) => {
            const tr = document.createElement('tr');
            tr.dataset.id = k.id;
            const input = document.createElement('input');
            input.type = 'number';
            input.step = 'any';
            input.placeholder = 'value';
            input.addEventListener('focus', () => w.pushHistory());
            input.addEventListener('input', () => {
              const tick = w.activePanel().colorbar.ticks.find((x) => x.id === k.id);
              if (tick) tick.value = input.value === '' ? NaN : Number(input.value);
              w.changed({ light: true });
            });
            input.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') input.blur();
            });
            // Position as % along the bar (0 at start, 100 at end), editable for
            // ticks whose mark is hard to click, e.g. at the very ends.
            const pos = document.createElement('td');
            pos.className = 'pos';
            const at = Object.assign(document.createElement('input'), { type: 'number', step: 'any', min: -10, max: 110, className: 'num', title: 'Position along the colorbar: 0% at the start, 100% at the end' });
            at.setAttribute('aria-label', 'Position in % along the colorbar');
            at.addEventListener('focus', () => w.pushHistory());
            at.addEventListener('change', () => {
              const cb = w.activePanel().colorbar;
              const tick = cb.ticks.find((x) => x.id === k.id);
              const v = Number(at.value);
              if (!tick || !cb.start || !cb.end || at.value === '' || !Number.isFinite(v)) return w.changed();
              Object.assign(tick, pointAtT(cb.start, cb.end, Math.min(110, Math.max(-10, v)) / 100));
              w.changed();
            });
            at.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') at.blur();
            });
            pos.append(at, '%');
            const del = document.createElement('button');
            del.className = 'btn subtle icon';
            del.textContent = '×';
            del.title = 'Remove tick';
            del.setAttribute('aria-label', 'Remove tick');
            del.addEventListener('click', () =>
              w.commit((p) => (p.colorbar.ticks = p.colorbar.ticks.filter((x) => x.id !== k.id))),
            );
            const tdIn = document.createElement('td');
            tdIn.append(input);
            const tdDel = document.createElement('td');
            tdDel.append(del);
            tr.append(tdIn, pos, tdDel);
            return tr;
          }),
        );
      }
      for (const k of ticks) {
        const tr = tbody.querySelector(`tr[data-id="${k.id}"]`);
        if (!tr) continue;
        const input = tr.querySelector('input');
        w.setValue(input, Number.isFinite(k.value) ? k.value : '');
        tr.classList.toggle('invalid', !Number.isFinite(k.value));
        w.setValue(tr.querySelector('.pos input'), Number.isFinite(k.t) ? Math.round(k.t * 1000) / 10 : '');
      }
    }

    function focusTick(id) {
      requestAnimationFrame(() => {
        const input = $('tick-list').querySelector(`tr[data-id="${id}"] input`);
        input?.focus();
      });
    }

    function renderBarStrip(panel) {
      const canvas = $('bar-strip');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const res = w.resultFor(panel);
      const samples = res.samples;
      const cb = panel.colorbar;
      if (!samples && (!cb.start || !cb.end || !app.imageData)) return;
      // Draw the raw sampled colors even when ticks are incomplete.
      const width = canvas.width;
      const h = canvas.height;
      const n = 128;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        let rgb;
        if (samples) rgb = colorAtT(samples, t);
        else rgb = readPixel(app.imageData, ...Object.values(pointAtT(cb.start, cb.end, t)));
        ctx.fillStyle = rgbToHex(rgb);
        ctx.fillRect(Math.floor((i / n) * width), 0, Math.ceil(width / n) + 1, h);
      }
      ctx.fillStyle = '#000';
      for (const k of ticksWithT(cb)) {
        if (!Number.isFinite(k.t)) continue;
        const x = Math.round(Math.min(1, Math.max(0, k.t)) * (width - 1));
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillRect(x - 2, 0, 4, h);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }

    // Which known colormap the calibrated colorbar looks like (core/colormap-match.js).
    // Matching takes ≈ 70 ms, so it waits until the bar stops moving and is
    // cached per bar position; tick values only decide the direction.
    let barMatchTimer = 0;
    let barMatch = { key: null, result: null };

    function scheduleBarMatch(panel) {
      const out = $('bar-match');
      const cb = panel.colorbar;
      const image = app.pages.get(panel.page)?.imageData;
      if (!out || !CM.suggestColormap || !cb.start || !cb.end || !image) {
        if (out) out.hidden = true;
        clearTimeout(barMatchTimer);
        return;
      }
      const key = JSON.stringify([panel.page, cb.start, cb.end, cb.halfWidth]);
      const valueAt = makeValueFn(ticksWithT(cb), cb.scale);
      const lowAtStart = valueAt ? valueAt(0) < valueAt(1) : null;
      clearTimeout(barMatchTimer);
      if (barMatch.key === key) {
        showBarMatch(barMatch.result, lowAtStart);
        return;
      }
      barMatchTimer = setTimeout(() => {
        const rgbs = sampleColorbar(image, cb.start, cb.end, cb.halfWidth, 128).map((s) => s.rgb);
        // Match start → end once; the ticks flip the direction afterwards.
        barMatch = { key, result: CM.suggestColormap(rgbs) };
        if (w.activePanel()?.id === panel.id) showBarMatch(barMatch.result, lowAtStart);
      }, 250);
    }

    function showBarMatch(m, lowAtStart) {
      const out = $('bar-match');
      out.replaceChildren();
      out.hidden = !m;
      if (!m) return;
      const reversed = lowAtStart === false ? !m.reversed : m.reversed;
      const name = `${m.name}${reversed ? '_r' : ''}`;
      const dir = lowAtStart == null ? ' (direction from the first end you placed; add ticks to read it by value)' : '';
      const score = `ΔE ${m.score.toFixed(1)}`;
      const strong = document.createElement('code');
      strong.textContent = name;
      const link = document.createElement('a');
      link.href = `colormaps.html?map=${encodeURIComponent(m.name)}#browse`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'View';
      link.title = 'Open this colormap in the colormap viewer';
      out.className = `bar-match hint ${m.level}`;
      if (m.level === 'exact') {
        const lib = CM.cmapData.sources.find((s) => s.key === m.source)?.label || m.source;
        out.append('Reference colormap: ', strong, ` (${lib}, ${score})${dir}. `);
      } else if (m.level === 'close') {
        out.append('Closest colormap: ', strong, ` (${score}): similar, but not the same map${dir}. `);
      } else {
        out.append('No known colormap matches this colorbar (closest: ', strong, `, ${score}). `);
      }
      if (m.level !== 'none' && m.same.length) {
        const flip = (n) => (lowAtStart === false ? (n.endsWith('_r') ? n.slice(0, -2) : `${n}_r`) : n);
        out.append(`Same colors: ${m.same.map(flip).join(', ')}. `);
      }
      out.append(link);
    }

    $('bar-place').addEventListener('click', () => {
      if (app.mode?.type === 'colorbar') return w.setMode(null);
      const cb = w.activePanel().colorbar;
      if (cb.ticks.length && !confirm('Placing the colorbar again removes its ticks. Continue?')) return;
      if (cb.ticks.length) w.commit((p) => (p.colorbar.ticks = []));
      w.setMode('colorbar');
    });
    $('tick-add').addEventListener('click', () => w.setMode(app.mode?.type === 'tick' ? null : 'tick'));
    $('bar-zoom').addEventListener('click', () => {
      const cb = w.activePanel().colorbar;
      if (cb.start) w.zoomToPoints([cb.start, cb.end]);
    });
    $('bar-scale').addEventListener('change', (e) => w.commit((p) => (p.colorbar.scale = e.target.value)));
    w.bindNumber('bar-halfwidth', (p, v) => (p.colorbar.halfWidth = Math.min(50, Math.max(0, v))));

    return { renderColorbarCard, focusTick };
  }

  Object.assign(CM, { setupWorkspaceColorbarCard });
})((globalThis.Colormeris ??= {}));
