(function (CM) {
  'use strict';

  // The Identify tab of the colormap viewer (colormaps.html): load an image of
  // a figure, drag along its colorbar (or use the whole image), and list the
  // closest known maps. The image input is cmap-figure-input.js.

  function setupCmapIdentify(ctx) {
    const { el, pct, clamp8, roundRgb, data, state, mapByName, base, stripSvg } = ctx;
    const MAX_CMP = CM.COMPARE_MAX;
    const selected = state.selected;

    const ID_MAX_PIXELS = 40000; // whole-image mode looks at about this many pixels
    const ID_TIE = 0.01; // maps whose scores differ by less than this have the same colors

    function identifyMaps() {
      return data.maps.map((m) => ({ name: m.name, kind: m.kind, rgbs: base(m) }));
    }

    // Matches within ID_TIE of the best remaining one are the same colors (gray,
    // gist_gray, binary reversed), so they share one entry.
    function groupTies(list, max = 5) {
      const groups = [];
      for (const r of list) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(r.score - g.lead.score) < ID_TIE) g.ties.push(r);
        else if (groups.length < max) groups.push({ lead: r, ties: [] });
        else break;
      }
      return groups;
    }

    function miniOf(map, flip) {
      const d = el('span', { class: 'cmap-mini' });
      const colors = flip ? base(map).slice().reverse() : base(map);
      d.innerHTML = stripSvg(colors, map.kind === 'qualitative');
      return d;
    }

    function buildIdentify() {
      const d = el('section', { class: 'cmap-identify', 'aria-labelledby': 'cmap-identify-title', hidden: '' });
      d.append(el('h2', { id: 'cmap-identify-title' }, 'Identify a colormap from a figure'));
      d.append(el('p', { class: 'muted' }, 'Give an image of a figure and find which Matplotlib, CMasher, Crameri, cmocean or CARTOColors colormap it uses. The image stays in your browser.'));

      const whole = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Use the whole image');
      const EMPTY_HINT = 'Drop an image here, paste one (Ctrl/Cmd+V), or click to choose a file (PNG, JPEG, WebP or GIF).';
      const sampled = el('div', { class: 'cmap-id-sampled', hidden: '' });
      const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });
      const verdict = el('p', { class: 'cmap-id-verdict', 'aria-live': 'polite' });
      const explain = el('p', { class: 'cmap-fig-cap muted', hidden: '' }, 'The score is the average ΔE2000 between the sampled colors and the map (the worst 10% are ignored). Below 3 is the same map; 3 to 6 is a close relative.');
      const list = el('ol', { class: 'cmap-id-list' });

      const fig = CM.createFigureInput({
        el,
        state,
        tab: 'identify',
        label: 'Your figure. Drag along the colorbar from one end to the other.',
        hints: {
          empty: EMPTY_HINT,
          loaded: 'Drag along the colorbar from one end to the other. Drag from the low end to the high end to read the direction. Or use the whole image if there is no colorbar.',
        },
        buttons: [whole],
        onLoad: () => { whole.disabled = false; },
        onReset: (keepImage) => {
          sampled.hidden = true;
          sampled.replaceChildren();
          list.replaceChildren();
          verdict.textContent = '';
          explain.hidden = true;
          status.textContent = '';
          if (!keepImage) whole.disabled = true;
        },
        onError: (msg) => { status.textContent = msg; },
        onLine: (a, b) => runColorbar(a, b),
      });
      const fail = (msg) => fig.fail(msg);
      d.append(fig.zone, fig.file, fig.canvas, sampled, status, verdict, list, explain);

      const hexOf = (rgb) => CM.rgbToHex(rgb.map(clamp8));

      function showVerdict(best, level, extra) {
        const nm = best.reversed ? `${best.name} (reversed)` : best.name;
        const sc = best.score.toFixed(1);
        verdict.replaceChildren();
        if (level === 'exact') verdict.append('Best match: ', el('strong', {}, nm), ` (ΔE ${sc}).`);
        else if (level === 'close') verdict.append('Closest: ', el('strong', {}, nm), ` (ΔE ${sc}). Not an exact match; it may be a relative or a map from another library.`);
        else verdict.append(`No good match among the known colormaps (best ΔE ${sc}).`);
        if (extra) verdict.append(' ', extra);
      }

      function renderResults(results, { dir }) {
        list.replaceChildren();
        explain.hidden = !results.length;
        if (!results.length) { verdict.textContent = 'Could not find any colors to match.'; return; }
        const groups = groupTies(results);
        const best = groups[0].lead;
        showVerdict(best, CM.matchLevel(best.score));
        if (dir && best.reversed) {
          const last = base(mapByName.get(best.name)).slice(-1)[0];
          const sw = el('span', { class: 'cmap-sw', style: `background:${hexOf(last)}`, title: hexOf(last) });
          status.replaceChildren('Reversed means the end where you started is the map’s last color ', sw, '.');
        }
        for (const { lead, ties } of groups) {
          const map = mapByName.get(lead.name);
          const li = el('li', { class: 'cmap-id-item' });
          const name = el('span', { class: 'cmap-id-name' });
          name.append(el('code', {}, lead.name));
          if (lead.reversed) name.append(' (reversed)');
          if (ties.length) {
            name.append(el('span', { class: 'muted' }, ` (same colors: ${ties.map((t) => (t.reversed ? `${t.name} reversed` : t.name)).join(', ')})`));
          }
          const nums = el('span', { class: 'cmap-id-score' }, `ΔE ${lead.score.toFixed(1)}${lead.coverage != null ? `, covers ${pct(lead.coverage)}` : ''}`);
          const act = el('span', { class: 'cmap-id-actions' });
          const show = el('button', { type: 'button', class: 'btn small' }, 'Show');
          show.setAttribute('aria-label', `Show ${lead.name} in Browse`);
          // The list is in its own tab, so say this before leaving.
          if (lead.reversed) show.title = `${lead.name} matches reversed. In Browse, turn on Reversed (under ⋯) to see it that way.`;
          show.addEventListener('click', () => ctx.showRow(lead.name));
          const cmpB = el('button', { type: 'button', class: 'btn small' });
          const syncCmp = () => {
            const on = selected.includes(lead.name);
            cmpB.textContent = on ? 'In comparison' : 'Compare';
            cmpB.disabled = on || selected.length >= MAX_CMP;
            cmpB.setAttribute('aria-label', `Compare ${lead.name}`);
          };
          syncCmp();
          cmpB.addEventListener('click', () => { ctx.setCompared(lead.name, true); syncCmp(); });
          act.append(show, cmpB);
          li.append(miniOf(map, lead.reversed), name, nums, act);
          list.append(li);
        }
      }

      function runColorbar(a, b) {
        const img = fig.img;
        const k = CM.refineColorbar(img, a, b);
        let start = a;
        let end = b;
        let half = 2;
        if (k) { ({ start, end } = k); half = k.halfWidth; }
        fig.line = { start, end };
        fig.redraw();
        const samples = CM.sampleColorbar(img, start, end, half, 256);
        if (samples.length < 2) { fail('That line is too short.'); return; }
        const rgbs = samples.map((s) => s.rgb);
        sampled.hidden = false;
        sampled.replaceChildren(el('span', { class: 'muted' }, k ? 'Colors along the line (snapped to the colorbar)' : 'Colors along the line'));
        const strip = el('div', { class: 'cmap-id-strip', role: 'img', 'aria-label': 'Sampled colors' });
        strip.innerHTML = stripSvg(rgbs.map(roundRgb), false);
        sampled.append(strip);
        status.textContent = '';
        renderResults(CM.identifyColorbar(rgbs, identifyMaps()), { dir: true });
        // Hand the figure and its calibration to the Recolor tab.
        const go = el('button', { type: 'button', class: 'btn small' }, 'Recolor this figure');
        go.title = 'Open this figure in Recolor with the same colorbar, to redraw it in another colormap';
        const { lastFile, line } = fig;
        go.addEventListener('click', () => ctx.recolorFigure(lastFile, line));
        verdict.append(' ', go);
      }

      function runWhole() {
        const img = fig.img;
        if (!img) return;
        fig.line = null;
        fig.redraw();
        const step = Math.max(1, Math.ceil(Math.sqrt((img.width * img.height) / ID_MAX_PIXELS)));
        const px = [];
        for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) px.push(CM.readPixel(img, x, y));
        sampled.hidden = true;
        status.textContent = 'The direction cannot be known this way. A line along the colorbar is more reliable.';
        renderResults(CM.identifyColors(px, identifyMaps()), { dir: false });
        verdict.append(' Whole image: the score is how close the image’s colors are to the nearest color of each map.');
      }


      whole.addEventListener('click', runWhole);
      return d;
    }

    return { sec: buildIdentify() };
  }

  Object.assign(CM, { setupCmapIdentify });
})((globalThis.Colormeris ??= {}));
