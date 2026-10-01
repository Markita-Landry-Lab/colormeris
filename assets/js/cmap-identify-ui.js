(function (CM) {
  'use strict';

  // The Identify tab of the colormap viewer (colormaps.html): load an image of
  // a figure, drag along its colorbar (or use the whole image), and list the
  // closest matplotlib maps. The image never leaves the browser.

  function setupCmapIdentify(ctx) {
    const { el, pct, clamp8, roundRgb, data, state, mapByName, base, stripSvg } = ctx;
    const MAX_CMP = CM.COMPARE_MAX;
    const selected = state.selected;

    const ID_MAX_SIDE = 4000; // larger images are scaled down before sampling
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
      d.append(el('p', { class: 'muted' }, 'Give an image of a figure and find which matplotlib colormap it uses. The image stays in your browser.'));

      const file = el('input', { type: 'file', accept: 'image/*', hidden: '' });
      const choose = el('button', { type: 'button', class: 'btn small' }, 'Choose image…');
      const example = el('button', { type: 'button', class: 'btn small' }, 'Example image (jet)');
      const whole = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Use the whole image');
      const clear = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Clear');
      const bar = el('div', { class: 'cmap-id-bar' });
      bar.append(choose, example, whole, clear);
      const hint = el('p', { class: 'cmap-id-hint' }, 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).');
      const zone = el('div', { class: 'cmap-drop' });
      zone.append(bar, hint);

      const canvas = el('canvas', { class: 'cmap-id-canvas', hidden: '', role: 'img', tabindex: '0', 'aria-label': 'Your figure. Drag along the colorbar from one end to the other.' });
      const sampled = el('div', { class: 'cmap-id-sampled', hidden: '' });
      const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });
      const verdict = el('p', { class: 'cmap-id-verdict', 'aria-live': 'polite' });
      const explain = el('p', { class: 'cmap-fig-cap muted', hidden: '' }, 'The score is the average ΔE2000 between the sampled colors and the map (the worst 10% are ignored). Below 3 is the same map; 3 to 6 is a close relative.');
      const list = el('ol', { class: 'cmap-id-list' });
      d.append(zone, file, canvas, sampled, status, verdict, list, explain);

      let src = null; // offscreen canvas with the full-resolution image
      let img = null; // its ImageData
      let line = null; // { start, end } in image pixels
      let drag = null;

      // Pointer positions are relative to the content box: the border is not part of the image.
      const scale = () => canvas.width / (canvas.clientWidth || canvas.width);

      function redraw() {
        const g = canvas.getContext('2d');
        g.drawImage(src, 0, 0);
        if (!line) return;
        const k = scale();
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--bar-color').trim() || '#f29900';
        g.lineCap = 'round';
        for (const [w, c] of [[4.5 * k, 'rgba(0,0,0,0.75)'], [2 * k, accent]]) {
          g.strokeStyle = c;
          g.lineWidth = w;
          g.beginPath();
          g.moveTo(line.start.x, line.start.y);
          g.lineTo(line.end.x, line.end.y);
          g.stroke();
        }
        // Circle at the start, so the direction is clear.
        g.fillStyle = accent;
        g.strokeStyle = 'rgba(0,0,0,0.75)';
        g.lineWidth = 1.5 * k;
        g.beginPath();
        g.arc(line.start.x, line.start.y, 4.5 * k, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        g.fillRect(line.end.x - 3 * k, line.end.y - 3 * k, 6 * k, 6 * k);
        g.strokeRect(line.end.x - 3 * k, line.end.y - 3 * k, 6 * k, 6 * k);
      }

      function reset(keepImage) {
        line = null;
        drag = null;
        sampled.hidden = true;
        sampled.replaceChildren();
        list.replaceChildren();
        verdict.textContent = '';
        explain.hidden = true;
        status.textContent = '';
        if (!keepImage) {
          src = null;
          img = null;
          canvas.hidden = true;
          whole.disabled = true;
          clear.disabled = true;
          file.value = '';
        } else if (src) redraw();
      }

      function fail(msg) {
        reset(false);
        status.textContent = msg;
      }

      function load(f) {
        if (!f || !/^image\//.test(f.type)) { fail('That file is not an image. Use a PNG, JPEG, WebP or GIF.'); return; }
        const url = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => {
          URL.revokeObjectURL(url);
          try {
            const k = Math.min(1, ID_MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight));
            const w = Math.max(1, Math.round(im.naturalWidth * k));
            const h = Math.max(1, Math.round(im.naturalHeight * k));
            src = document.createElement('canvas');
            src.width = w;
            src.height = h;
            const g = src.getContext('2d', { willReadFrequently: true });
            g.fillStyle = '#fff'; // transparent pixels count as white, as readPixel does
            g.fillRect(0, 0, w, h);
            g.drawImage(im, 0, 0, w, h);
            img = g.getImageData(0, 0, w, h);
            canvas.width = w;
            canvas.height = h;
            reset(true);
            canvas.hidden = false;
            whole.disabled = false;
            clear.disabled = false;
            hint.textContent = 'Drag along the colorbar from one end to the other. Drag from the low end to the high end to read the direction. Or use the whole image if there is no colorbar.';
            redraw();
          } catch (err) {
            console.warn('Could not read the image', err);
            fail('Could not read that image.');
          }
        };
        im.onerror = () => { URL.revokeObjectURL(url); fail('Could not open that image.'); };
        im.src = url;
      }

      function pointAt(e) {
        const r = canvas.getBoundingClientRect();
        const k = scale();
        return {
          x: Math.max(0, Math.min(canvas.width - 1, (e.clientX - r.left - canvas.clientLeft) * k)),
          y: Math.max(0, Math.min(canvas.height - 1, (e.clientY - r.top - canvas.clientTop) * k)),
        };
      }

      const hexOf = (rgb) => CM.rgbToHex(rgb.map(clamp8));

      function showVerdict(best, level, extra) {
        const nm = best.reversed ? `${best.name} (reversed)` : best.name;
        const sc = best.score.toFixed(1);
        verdict.replaceChildren();
        if (level === 'exact') verdict.append('Best match: ', el('strong', {}, nm), ` (ΔE ${sc}).`);
        else if (level === 'close') verdict.append('Closest: ', el('strong', {}, nm), ` (ΔE ${sc}). Not an exact match; it may be a relative or a map from another library.`);
        else verdict.append(`No good match among the matplotlib colormaps (best ΔE ${sc}).`);
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
        const k = CM.refineColorbar(img, a, b);
        let start = a;
        let end = b;
        let half = 2;
        if (k) { ({ start, end } = k); half = k.halfWidth; }
        line = { start, end };
        redraw();
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
      }

      function runWhole() {
        if (!img) return;
        line = null;
        redraw();
        const step = Math.max(1, Math.ceil(Math.sqrt((img.width * img.height) / ID_MAX_PIXELS)));
        const px = [];
        for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) px.push(CM.readPixel(img, x, y));
        sampled.hidden = true;
        status.textContent = 'The direction cannot be known this way. A line along the colorbar is more reliable.';
        renderResults(CM.identifyColors(px, identifyMaps()), { dir: false });
        verdict.append(' Whole image: the score is how close the image’s colors are to the nearest color of each map.');
      }

      canvas.addEventListener('pointerdown', (e) => {
        if (!img || e.button > 0) return;
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drag = { start: pointAt(e), px: e.clientX, py: e.clientY };
        line = null;
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        line = { start: drag.start, end: pointAt(e) };
        redraw();
      });
      const finish = (e) => {
        if (!drag) return;
        const { start, px, py } = drag;
        drag = null;
        if (e.type === 'pointercancel' || Math.hypot(e.clientX - px, e.clientY - py) < 8) { line = null; redraw(); return; }
        runColorbar(start, pointAt(e));
      };
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);

      choose.addEventListener('click', () => file.click());
      file.addEventListener('change', () => { if (file.files[0]) load(file.files[0]); });
      example.addEventListener('click', async () => {
        try {
          const res = await fetch('assets/examples/example-jet.png');
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          load(new File([await res.blob()], 'example-jet.png', { type: 'image/png' }));
        } catch (err) {
          fail(`Could not load the example (${err.message}). Serve the folder with npm run serve.`);
        }
      });
      whole.addEventListener('click', runWhole);
      clear.addEventListener('click', () => { reset(false); hint.textContent = 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).'; });

      const fileOf = (dt) => [...(dt?.files || [])].find((f) => /^image\//.test(f.type)) || [...(dt?.files || [])][0];
      for (const t of [zone, canvas]) {
        t.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
        t.addEventListener('dragleave', () => zone.classList.remove('over'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          zone.classList.remove('over');
          load(fileOf(e.dataTransfer));
        });
      }
      // Paste works anywhere on the page while this tab is shown.
      document.addEventListener('paste', (e) => {
        if (state.tab !== 'identify' || e.target.closest?.('input[type="search"], textarea')) return;
        const f = fileOf(e.clipboardData);
        if (!f) return;
        e.preventDefault();
        load(f);
      });
      return d;
    }

    return { sec: buildIdentify() };
  }

  Object.assign(CM, { setupCmapIdentify });
})((globalThis.Colormeris ??= {}));
