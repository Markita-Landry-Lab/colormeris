(function (CM) {
  'use strict';
  const { ticksWithT, pointAtT, colorAtT, readPixel, rgbToHex, makeValueFn, sampleColorbar } = CM;

  // The Colorbar card: ends, the tick table, the sampled strip and the
  // suggested reference colormap. The colors come from the bar in the figure
  // or from a known colormap (colorbar.colormap, picked with the colormap
  // viewer's picker, colormaps/map-picker.js); with a known colormap the bar
  // line is optional and ticks can be typed as a position along the map.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (commit, changed, resultFor, ...).
  function setupWorkspaceColorbarCard(w) {
    const { $, app } = w;

    function renderColorbarCard(panel) {
      const cb = panel.colorbar;
      w.setValue($('bar-scale'), cb.scale);
      w.setValue($('bar-halfwidth'), Math.round(cb.halfWidth * 10) / 10);
      const validTicks = ticksWithT(cb).filter((k) => Number.isFinite(k.value) && Number.isFinite(k.t)).length;
      const known = !!cb.colormap;
      const ready = !!cb.start || known;
      const ticksText = `${validTicks} tick${validTicks === 1 ? '' : 's'}`;
      w.setBadge($('bar-state'), !ready ? 'not placed' : known ? `${cb.colormap.name}${cb.colormap.reversed ? '_r' : ''} · ${ticksText}` : ticksText, ready && validTicks >= 2);
      $('tick-add').disabled = !cb.start;
      $('tick-type').disabled = !ready;
      // With a known colormap the bar in the figure is optional, so typing the
      // ticks is the next step rather than placing the bar.
      w.setNextStep($('bar-place'), !ready);
      w.setNextStep($('tick-add'), !!cb.start && !known && validTicks < 2);
      w.setNextStep($('tick-type'), known && validTicks < 2);
      $('bar-zoom').disabled = !cb.start;
      renderSource(cb);
      $('tick-empty').innerHTML = known
        ? 'No ticks yet. Use <b>Type a tick</b> and enter a value and its position in % along the colormap, or place the colorbar ends and click its ticks.'
        : 'No ticks yet. Use <b>Add ticks</b>, click a labelled tick on the bar, type its value, repeat. <b>Type a tick</b> enters a position in % instead.';
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
            at.title = 'Position along the colorbar or colormap: 0% at the start, 100% at the end';
            at.addEventListener('focus', () => w.pushHistory());
            at.addEventListener('change', () => {
              const cb = w.activePanel().colorbar;
              const tick = cb.ticks.find((x) => x.id === k.id);
              const v = Number(at.value);
              if (!tick || at.value === '' || !Number.isFinite(v)) return w.changed();
              const t = Math.min(110, Math.max(-10, v)) / 100;
              // A tick on the page moves along the bar; a typed one keeps just t.
              if (Number.isFinite(tick.x)) {
                if (!cb.start || !cb.end) return w.changed();
                Object.assign(tick, pointAtT(cb.start, cb.end, t));
              } else tick.t = t;
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
      const cb = panel.colorbar;
      // Before the panel has results, a known colormap still shows its colors.
      const samples = res.samples || (cb.colormap ? CM.colormapSamples(cb.colormap, 128) : null);
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
      if (!out || !CM.suggestColormap || !cb.start || !cb.end || !image || cb.colormap) {
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
      if (m.level !== 'none') {
        // Use the matched map's own colors instead of the sampled bar: same
        // direction as the bar (m.reversed is start → end), ticks unchanged.
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'link';
        use.textContent = 'Use its colors';
        use.title = `Read the colors from ${m.name} itself instead of the colorbar in the figure`;
        use.addEventListener('click', () => w.commit((p) => (p.colorbar.colormap = { name: m.name, reversed: m.reversed })));
        out.append(' · ', use);
      }
    }

    $('bar-place').addEventListener('click', () => {
      if (app.mode?.type === 'colorbar') return w.setMode(null);
      const cb = w.activePanel().colorbar;
      // Ticks typed along a known colormap do not depend on the bar and stay.
      const onPage = cb.ticks.filter((k) => Number.isFinite(k.x)).length;
      if (onPage && !confirm('Placing the colorbar again removes its ticks on the page. Continue?')) return;
      if (onPage) w.commit((p) => (p.colorbar.ticks = p.colorbar.ticks.filter((k) => !Number.isFinite(k.x))));
      w.setMode('colorbar');
    });
    $('tick-add').addEventListener('click', () => w.setMode(app.mode?.type === 'tick' ? null : 'tick'));
    $('bar-zoom').addEventListener('click', () => {
      const cb = w.activePanel().colorbar;
      if (cb.start) w.zoomToPoints([cb.start, cb.end]);
    });
    // ---------------------------------------------------------------- known colormap

    // The colormap viewer's picker (colormaps/map-picker.js) needs a few of the
    // viewer's helpers; these are the small versions for this page.
    const pickerCtx = {
      el(tag, attrs, text) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
          if (k === 'class') e.className = v;
          else e.setAttribute(k, v);
        }
        if (text != null) e.textContent = text;
        return e;
      },
      data: CM.cmapData,
      mapByName: new Map((CM.cmapData?.maps || []).map((m) => [m.name, m])),
      base: (m) => CM.cmapRgbs(m.name) || [],
      stripCanvas(colors, qualitative) {
        const n = Math.max(1, colors.length);
        const canvas = Object.assign(document.createElement('canvas'), { className: qualitative ? 'cmap-paint qual' : 'cmap-paint', width: n, height: 1 });
        const img = new ImageData(n, 1);
        colors.forEach((c, i) => img.data.set([c[0], c[1], c[2], 255], i * 4));
        canvas.getContext('2d').putImageData(img, 0, 0);
        return canvas;
      },
    };
    const picker = CM.cmapData && CM.createMapPicker
      ? CM.createMapPicker(pickerCtx, {
        id: 'bar-cmap-picker',
        label: 'Colormap',
        placeholder: 'Type to search',
        // Called while the picker is built too, before any tool is set.
        current: () => (w.tool() ? w.activePanel()?.colorbar.colormap?.name || null : null),
        onChoose: (name, typedReversed) => chooseColormap(name, typedReversed || $('bar-cmap-rev').checked),
      })
      : null;
    if (picker) $('bar-cmap-pick').append(picker.box);
    else $('bar-source').disabled = true;

    function renderSource(cb) {
      w.setValue($('bar-source'), cb.colormap ? 'colormap' : 'figure');
      $('bar-cmap').hidden = !cb.colormap;
      if (!cb.colormap) return;
      $('bar-cmap-rev').checked = !!cb.colormap.reversed;
      if (picker && document.activeElement !== picker.input) picker.input.value = cb.colormap.name;
    }

    // Pick a known colormap. A panel without ticks gets one at each end, valued
    // 0 and 1 (1 and 10 on a log scale, which has no 0), so the panel reads
    // values at once; typing the figure's range replaces them.
    function chooseColormap(name, reversed) {
      const cb = w.activePanel().colorbar;
      const addEnds = !cb.ticks.length;
      const ids = addEnds ? [w.newTickId(), w.newTickId()] : [];
      const [lo, hi] = cb.scale === 'log10' ? [1, 10] : [0, 1];
      w.commit((p) => {
        p.colorbar.colormap = { name, reversed: !!reversed };
        if (addEnds) p.colorbar.ticks = [{ id: ids[0], t: 0, value: lo }, { id: ids[1], t: 1, value: hi }];
      });
      if (addEnds) focusTick(ids[0]);
    }

    $('bar-source').addEventListener('change', (e) => {
      if (e.target.value === 'figure') return w.commit((p) => (p.colorbar.colormap = null));
      // Start from the map the bar was matched to, if any, else viridis.
      const m = barMatch.result && barMatch.result.level !== 'none' && barMatch.key ? barMatch.result : null;
      // The first end's value gets the focus (chooseColormap), not the picker:
      // focused, the picker opens its list over the tick table.
      chooseColormap(m ? m.name : 'viridis', m ? m.reversed : false);
    });
    $('bar-cmap-rev').addEventListener('change', (e) => {
      if (w.activePanel().colorbar.colormap) w.commit((p) => (p.colorbar.colormap = { ...p.colorbar.colormap, reversed: e.target.checked }));
    });

    // A tick entered by value and position: the first free end, else the middle.
    // On a known colormap it is just a position; otherwise it goes on the bar.
    $('tick-type').addEventListener('click', () => {
      const cb = w.activePanel().colorbar;
      if (!cb.colormap && !(cb.start && cb.end)) return;
      const used = ticksWithT(cb).map((k) => k.t);
      const t = [0, 1, 0.5].find((x) => !used.some((u) => Math.abs(u - x) < 1e-6)) ?? 0.5;
      const id = w.newTickId();
      const tick = cb.colormap ? { id, t, value: NaN } : { id, ...pointAtT(cb.start, cb.end, t), value: NaN };
      w.commit((p) => p.colorbar.ticks.push(tick));
      focusTick(id);
    });

    $('bar-scale').addEventListener('change', (e) => w.commit((p) => (p.colorbar.scale = e.target.value)));
    w.bindNumber('bar-halfwidth', (p, v) => (p.colorbar.halfWidth = Math.min(50, Math.max(0, v))));

    return { renderColorbarCard, focusTick };
  }

  Object.assign(CM, { setupWorkspaceColorbarCard });
})((globalThis.Colormeris ??= {}));
