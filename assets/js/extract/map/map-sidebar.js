(function (CM) {
  'use strict';
  const { mapSize, axisFn, axisT, axisEdgePoint, mapMatrixCsv, mapLongCsv, profileCsv, formatNumber, safeFileName } = CM;

  // Map tool, DOM: the sidebar cards (Axes, Profiles, Results), the profile
  // plot and the CSV downloads. Set up by map-tool.js.
  //
  // mctx: { ws, state, selectedProfile, toggleMode, deleteSelected, AXIS_COLORS,
  // PROFILE_COLOR } (see map-tool.js; toggleMode and deleteSelected are added
  // after this setup and looked up at call time).

  function setupMapSidebar(mctx) {
    const { ws, state } = mctx;
    const { $, app, viewer } = ws;

    function renderSidebar(panel) {
      renderAxes(panel);
      renderProfiles(panel);
      renderResults(panel);
    }

    // ---------------------------------------------------------------- axes

    const tickKeys = { x: '', y: '' };
    function renderAxes(panel) {
      const states = [];
      for (const key of ['x', 'y']) {
        const axis = panel.map[key];
        ws.setValue($(`axis-${key}-scale`), axis.scale);
        $(`axis-${key}-add`).disabled = !panel.grid.corners;
        renderAxisTicks(panel, key);
        const { fn, problem } = axisFn(panel, key);
        $(`axis-${key}-problem`).textContent = problem || '';
        if (fn) states.push(key);
      }
      ws.setBadge($('axes-state'), states.length ? `${states.join(', ')} calibrated` : 'pixels', states.length === 2);
    }

    function renderAxisTicks(panel, key) {
      const ticks = panel.map[key].ticks;
      const tbody = $(`axis-${key}-ticks`);
      tbody.closest('table').hidden = ticks.length === 0;
      const ids = `${panel.id}|${ticks.map((k) => k.id).join(',')}`;
      if (ids !== tickKeys[key]) {
        tickKeys[key] = ids;
        tbody.replaceChildren(...ticks.map((k) => tickRow(key, k)));
      }
      for (const k of ticks) {
        const tr = tbody.querySelector(`tr[data-id="${k.id}"]`);
        if (!tr) continue;
        ws.setValue(tr.querySelector('input'), Number.isFinite(k.value) ? k.value : '');
        tr.classList.toggle('invalid', !Number.isFinite(k.value));
        const t = panel.grid.corners ? axisT(panel, key, k) : NaN;
        ws.setValue(tr.querySelector('.pos input'), Number.isFinite(t) ? Math.round(t * 1000) / 10 : '');
      }
    }

    function tickRow(key, k) {
      const tr = document.createElement('tr');
      tr.dataset.id = k.id;
      const input = Object.assign(document.createElement('input'), { type: 'number', step: 'any', placeholder: 'value' });
      input.setAttribute('aria-label', `${key.toUpperCase()} axis tick value`);
      input.addEventListener('focus', () => ws.pushHistory());
      input.addEventListener('input', () => {
        const tick = ws.activePanel().map[key].ticks.find((x) => x.id === k.id);
        if (tick) tick.value = input.value === '' ? NaN : Number(input.value);
        ws.changed({ light: true });
      });
      input.addEventListener('change', () => ws.changed());
      // Escape after typing a value ends tick mode too; otherwise the next
      // click on the image (meant to leave the mode) adds another tick.
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          input.blur();
          ws.setMode(null);
        }
      });
      // Position as % across the plot area, editable as on the colorbar, for
      // ticks whose mark is hard to click (e.g. on the plot's own edge).
      const pos = Object.assign(document.createElement('td'), { className: 'pos' });
      const at = Object.assign(document.createElement('input'), {
        type: 'number',
        step: 'any',
        min: -50,
        max: 150,
        className: 'num',
        title: `Position across the plot area: 0% at the ${key === 'x' ? 'left' : 'top'}, 100% at the ${key === 'x' ? 'right' : 'bottom'}`,
      });
      at.setAttribute('aria-label', `Position in % across the plot area (${key} axis)`);
      at.addEventListener('focus', () => ws.pushHistory());
      at.addEventListener('change', () => {
        const panel = ws.activePanel();
        const tick = panel.map[key].ticks.find((x) => x.id === k.id);
        const v = Number(at.value);
        if (!tick || !panel.grid.corners || at.value === '' || !Number.isFinite(v)) return ws.changed();
        Object.assign(tick, axisEdgePoint(panel, key, v / 100));
        ws.changed();
      });
      at.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') at.blur();
      });
      pos.append(at, '%');
      const del = Object.assign(document.createElement('button'), { className: 'btn subtle icon', textContent: '×', title: 'Remove tick' });
      del.setAttribute('aria-label', 'Remove tick');
      del.addEventListener('click', () => ws.commit((p) => (p.map[key].ticks = p.map[key].ticks.filter((x) => x.id !== k.id))));
      const tdIn = document.createElement('td');
      tdIn.append(input);
      const tdDel = document.createElement('td');
      tdDel.append(del);
      tr.append(tdIn, pos, tdDel);
      return tr;
    }

    function focusAxisTick(key, id) {
      requestAnimationFrame(() => $(`axis-${key}-ticks`).querySelector(`tr[data-id="${id}"] input`)?.focus());
    }

    // ---------------------------------------------------------------- profiles

    let profileListKey = '';
    function renderProfiles(panel) {
      const profiles = panel.map.profiles;
      if (state.selectedId && !profiles.some((l) => l.id === state.selectedId)) state.selectedId = null;
      // A single profile is the one shown, without clicking it first.
      if (!state.selectedId && profiles.length === 1) state.selectedId = profiles[0].id;
      const key = JSON.stringify([panel.id, state.selectedId, profiles.map((l) => [l.id, l.name])]);
      if (key !== profileListKey) {
        profileListKey = key;
        $('profile-list').replaceChildren(
          ...profiles.map((l) => {
            const li = document.createElement('li');
            const btn = document.createElement('button');
            btn.className = 'chip';
            btn.setAttribute('aria-pressed', String(l.id === state.selectedId));
            btn.append(Object.assign(document.createElement('span'), { className: 'chip-label', textContent: l.name }));
            btn.addEventListener('click', () => {
              state.selectedId = l.id;
              ws.changed();
            });
            li.append(btn);
            return li;
          }),
        );
      }
      const n = profiles.length;
      ws.setBadge($('profile-state'), n ? `${n} profile${n === 1 ? '' : 's'}` : 'none', n > 0);
      $('profile-empty').hidden = n > 0;
      const sel = mctx.selectedProfile();
      $('profile-edit').hidden = !sel;
      $('profile-view').hidden = !sel;
      if (!sel) return;
      ws.setValue($('profile-name'), sel.name);
      ws.setValue($('profile-width'), sel.halfWidth);
      const samples = ws.resultFor(panel).profiles?.[sel.id];
      const error = samples?.error || (!samples ? 'Calibrate the colorbar to read the profile.' : '');
      $('profile-problem').textContent = error;
      $('profile-csv').disabled = !!error;
      drawProfile(error ? null : samples, sel);
    }

    // ---------------------------------------------------------------- tracing
    // state.trace = {id, i}: sample i of profile id, under the pointer on the
    // image (map-tool.js) or on the plot. Both draw it, so the two stay in step.

    let plot = null; // what the plot shows, for mapping the pointer to a sample

    function setTrace(trace) {
      const same = trace && state.trace && trace.id === state.trace.id && trace.i === state.trace.i;
      if (same || (!trace && !state.trace)) return;
      state.trace = trace;
      redrawProfile();
      viewer.requestDraw();
    }

    function redrawProfile() {
      if (plot) drawProfile(plot.samples, plot.profile);
    }

    // Plot against the calibrated axis the line mostly runs along, else
    // against the distance along the line in pixels.
    function profileAxis(samples, profile) {
      const horizontal = Math.abs(profile.b.x - profile.a.x) >= Math.abs(profile.b.y - profile.a.y);
      if (horizontal && samples[0].x !== null) return { get: (s) => s.x, name: 'x' };
      if (!horizontal && samples[0].y !== null) return { get: (s) => s.y, name: 'y' };
      return { get: (s) => s.d, name: 'distance (px)' };
    }

    function drawProfile(samples, profile) {
      const canvas = $('profile-plot');
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || 300;
      const cssH = canvas.clientHeight || 140;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      plot = null;
      if (!samples?.length) return;
      const css = getComputedStyle(canvas);
      const text = css.getPropertyValue('--text').trim() || '#222';
      const muted = css.getPropertyValue('--muted').trim() || '#777';
      const border = css.getPropertyValue('--border').trim() || '#ddd';
      const accent = css.getPropertyValue('--accent').trim() || '#3b47e0';
      const danger = css.getPropertyValue('--danger').trim() || '#c62a2a';
      const axis = profileAxis(samples, profile);
      const xs = samples.map(axis.get);
      const ys = samples.map((s) => s.value);
      const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
      let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
      if (y1 - y0 < 1e-12) [y0, y1] = [y0 - 0.5, y1 + 0.5];
      const pad = { l: 44, r: 8, t: 8, b: 30 };
      const W = cssW - pad.l - pad.r;
      const H = cssH - pad.t - pad.b;
      const sx = (x) => pad.l + ((x - x0) / (x1 - x0 || 1)) * W;
      const sy = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * H;
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.strokeRect(pad.l + 0.5, pad.t + 0.5, W, H);
      ctx.beginPath();
      samples.forEach((s, i) => (i ? ctx.lineTo(sx(xs[i]), sy(s.value)) : ctx.moveTo(sx(xs[i]), sy(s.value))));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Flagged or possibly clipped samples as red dots on the line.
      ctx.fillStyle = danger;
      samples.forEach((s, i) => {
        if (s.flagged || s.clipped) ctx.fillRect(sx(xs[i]) - 1.5, sy(s.value) - 1.5, 3, 3);
      });
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = muted;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      ctx.fillText(shortLabel(y1), pad.l - 4, pad.t + 4);
      ctx.fillText(shortLabel(y0), pad.l - 4, pad.t + H - 4);
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(shortLabel(axis.get(samples[0])), pad.l, pad.t + H + 4);
      ctx.textAlign = 'right';
      ctx.fillText(shortLabel(axis.get(samples.at(-1))), pad.l + W, pad.t + H + 4);
      ctx.textAlign = 'center';
      ctx.fillStyle = text;
      ctx.fillText(axis.name, pad.l + W / 2, pad.t + H + 4);
      plot = { samples, profile, xs, sx, pad, W };
      if (state.trace?.id === profile.id && samples[state.trace.i]) {
        drawTraceMark(ctx, { i: state.trace.i, samples, xs, sx, sy, pad, W, H, axis, text, accent, css });
      }
    }

    // Guide line, dot and readout for the traced sample.
    function drawTraceMark(ctx, { i, samples, xs, sx, sy, pad, W, H, axis, text, accent, css }) {
      const s = samples[i];
      const x = sx(xs[i]);
      const y = sy(s.value);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = text;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, pad.t);
      ctx.lineTo(Math.round(x) + 0.5, pad.t + H);
      ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = css.getPropertyValue('--surface').trim() || '#fff';
      ctx.stroke();
      const label = `${axis.name === 'distance (px)' ? 'd' : axis.name} ${shortLabel(xs[i])}: ${shortLabel(s.value)}`;
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'top';
      // Readout on the side of the guide with more room.
      const right = x < pad.l + W / 2;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.fillStyle = text;
      ctx.fillText(label, x + (right ? 6 : -6), pad.t + 3);
    }

    // Pointer on the plot → nearest sample along the horizontal axis.
    $('profile-plot').addEventListener('pointermove', (e) => {
      if (!plot) return;
      const mx = e.clientX - $('profile-plot').getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < plot.xs.length; i++) if (Math.abs(plot.sx(plot.xs[i]) - mx) < Math.abs(plot.sx(plot.xs[best]) - mx)) best = i;
      setTrace({ id: plot.profile.id, i: best });
    });
    $('profile-plot').addEventListener('pointerleave', () => setTrace(null));

    const shortLabel = (v) => {
      if (!Number.isFinite(v)) return '';
      const a = Math.abs(v);
      return a !== 0 && (a >= 1e5 || a < 1e-2) ? v.toExponential(2) : String(Number(v.toPrecision(4)));
    };

    // ---------------------------------------------------------------- results

    function renderResults(panel) {
      ws.setValue($('map-bin'), panel.map.bin);
      const res = ws.resultFor(panel);
      $('map-dl-csv').disabled = $('map-dl-long').disabled = !!res.error;
      $('map-axis-hint').textContent = res.axisProblems?.join(' ') || '';
      if (res.error) {
        $('map-problem').textContent = res.error;
        $('map-summary').textContent = panel.grid.corners ? sizeText(panel) : '';
        return;
      }
      $('map-problem').textContent = '';
      const s = res.stats;
      const clipped = s.clippedLow + s.clippedHigh;
      const total = res.values.length;
      const pct = (n) => (n / total < 0.001 && n ? '<0.1' : ((100 * n) / total).toFixed(1));
      $('map-summary').textContent = [
        `${res.cols} × ${res.rows} values${res.bin > 1 ? ` (bins of ${res.bin} px)` : ' (native pixels)'}`,
        `range ${formatNumber(s.min)} – ${formatNumber(s.max)}`,
        `colorbar resolves about ${s.levels} levels`,
        s.flagged ? `${s.flagged} flagged (${pct(s.flagged)}%, ΔE > ${panel.settings.maxDeltaE})` : 'no flagged values',
        clipped ? `${clipped} at a colorbar end (${pct(clipped)}%, may be clipped)` : 'none at a colorbar end',
      ].join(' · ');
    }

    function sizeText(panel) {
      const { rows, cols } = mapSize(panel);
      return `${cols} × ${rows} values at this bin size.`;
    }

    // ---------------------------------------------------------------- bindings

    for (const key of ['x', 'y']) {
      $(`axis-${key}-add`).addEventListener('click', () => mctx.toggleMode(`${key}tick`));
      $(`axis-${key}-scale`).addEventListener('change', (e) => ws.commit((p) => (p.map[key].scale = e.target.value)));
    }
    $('profile-add').addEventListener('click', () => mctx.toggleMode('profile'));
    ws.bindText('profile-name', (p, v) => {
      const l = p.map.profiles.find((x) => x.id === state.selectedId);
      if (l) l.name = v;
    });
    ws.bindNumber('profile-width', (p, v) => {
      const l = p.map.profiles.find((x) => x.id === state.selectedId);
      if (l) l.halfWidth = Math.min(50, Math.max(0, Math.round(v)));
    });
    $('profile-delete').addEventListener('click', () => mctx.deleteSelected());
    $('profile-zoom').addEventListener('click', () => {
      const l = mctx.selectedProfile();
      if (l) ws.zoomToPoints([l.a, l.b]);
    });
    $('profile-csv').addEventListener('click', () => {
      const panel = ws.activePanel();
      const l = mctx.selectedProfile();
      const samples = l && ws.resultFor(panel).profiles?.[l.id];
      if (Array.isArray(samples)) ws.download(new Blob([profileCsv(samples)], { type: 'text/csv' }), ws.csvName(panel, `_profile_${safeFileName(l.name)}`));
    });
    ws.bindNumber('map-bin', (p, v) => (p.map.bin = Math.min(256, Math.max(1, Math.round(v)))));
    $('map-recon').addEventListener('change', (e) => {
      state.showRecon = e.target.checked;
      viewer.requestDraw();
    });
    $('map-flags').addEventListener('change', (e) => {
      state.showFlags = e.target.checked;
      viewer.requestDraw();
    });
    $('map-dl-csv').addEventListener('click', () => {
      const p = ws.activePanel();
      const r = ws.resultFor(p);
      if (!r.error) ws.download(new Blob([mapMatrixCsv(p, r)], { type: 'text/csv' }), ws.csvName(p, '_map'));
    });
    $('map-dl-long').addEventListener('click', () => {
      const p = ws.activePanel();
      const r = ws.resultFor(p);
      if (!r.error) ws.download(new Blob([mapLongCsv([{ panel: p, result: r }])], { type: 'text/csv' }), ws.csvName(p, '_map_long'));
    });
    // The plot follows the card's width.
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => app.sourceCanvas && ws.tool().kind === 'map' && renderProfiles(ws.activePanel())).observe($('profile-plot'));
    }

    return { renderSidebar, focusAxisTick, setTrace };
  }

  Object.assign(CM, { setupMapSidebar });
})((globalThis.Colormeris ??= {}));
