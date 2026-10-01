(function (CM) {
  'use strict';

  // The CVD tab of the colormap viewer (colormaps.html): a figure next to how
  // it may look with a color vision deficiency, after the DaltonLens simulator
  // (https://daltonlens.org/colorblindness-simulator). The jet example is shown
  // until the user gives an image. The simulation is in cvd.js; the image
  // input is cmap-figure-input.js, without its colorbar line. The image never
  // leaves the browser.

  const TYPES = [
    // key, button, full name, partial name, what is missing (tooltip)
    ['protanopia', 'Protan', 'Protanopia', 'Protanomaly', 'Missing or shifted L (red) cones'],
    ['deuteranopia', 'Deutan', 'Deuteranopia', 'Deuteranomaly', 'Missing or shifted M (green) cones; the most common kind'],
    ['tritanopia', 'Tritan', 'Tritanopia', 'Tritanomaly', 'Missing or shifted S (blue) cones; rare'],
  ];
  const TYPE = new Map(TYPES.map((t) => [t[0], t]));
  const MODEL_NAMES = { brettel: 'Brettel 1997', vienot: 'Viénot 1999', machado: 'Machado 2009' };
  const DEFAULT_TYPE = 'deuteranopia';
  const CHUNK = 400000; // pixels simulated between pauses
  const KEEP = 6; // simulated images kept, so going back to a setting is instant
  const EXAMPLE_NAME = 'example-jet.png';

  function setupCmapCvd(ctx) {
    const { el, state } = ctx;

    const d = el('section', { class: 'cmap-cvd', 'aria-labelledby': 'cmap-cvd-title', hidden: '' });
    d.append(el('h2', { id: 'cmap-cvd-title' }, 'Simulate color vision deficiency'));
    d.append(el('p', { class: 'muted' }, 'See a figure next to how it may look to someone with a color vision deficiency (CVD), to check that its colors stay apart. The image stays in your browser.'));

    const EMPTY_HINT = 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).';
    const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });

    // ---- controls ----
    let type = DEFAULT_TYPE; // or 'all'
    const kinds = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': 'Deficiency' });
    const kindBtns = [...TYPES.map(([k, label, , , tip]) => [k, label, tip]), ['all', 'All', 'All three side by side']].map(([k, label, tip]) => {
      const b = el('button', { type: 'button', 'aria-pressed': 'false', title: tip }, label);
      b.addEventListener('click', () => { type = k; syncKinds(); render(); });
      kinds.append(b);
      return [k, b];
    });
    const syncKinds = () => { for (const [k, b] of kindBtns) b.setAttribute('aria-pressed', String(k === type)); };
    syncKinds();

    const sev = el('input', { type: 'range', min: '0', max: '1', step: '0.1', value: '1' });
    const sevOut = el('output', {}, '1.0');
    const model = el('select');
    for (const [v, label] of [
      ['recommended', 'Recommended'],
      ['brettel', 'Brettel 1997'],
      ['vienot', 'Viénot 1999 (protan, deutan)'],
      ['machado', 'Machado 2009'],
    ]) model.append(el('option', { value: v }, label));
    const download = el('button', { type: 'button', class: 'btn small primary' }, 'Download PNG');
    const fieldsRow = el('div', { class: 'cmap-rc-fields' });
    fieldsRow.append(
      field('Deficiency', 'Which kind of cone is missing (or shifted, below full severity)', kinds),
      field('Severity', '1 is dichromacy (protanopia, deuteranopia, tritanopia): one kind of cone is missing. Below 1 is anomalous trichromacy (protanomaly etc.): the cone is shifted, a milder and more common form. 0 is normal vision.', sev, sevOut),
      field('Model', 'Recommended follows the DaltonLens review: Brettel 1997 for tritan, Machado 2009 for protan and deutan (it models partial severity best). Viénot 1999 does not model tritan; Brettel 1997 is used instead.', model),
    );
    const actions = el('div', { class: 'cmap-id-bar cmap-rc-actions' });
    actions.append(download);
    const controls = el('div', { class: 'cmap-rc-controls', hidden: '' });
    controls.append(fieldsRow, actions);

    function field(label, title, ...inputs) {
      const f = el('div', { class: 'cmap-rc-field', title });
      const row = el('div', { class: 'cmap-rc-input' });
      row.append(...inputs);
      f.append(el('span', { class: 'cmap-rc-label' }, label), row);
      return f;
    }

    // ---- figure input; its canvas is the Original panel ----
    const fig = CM.createFigureInput({
      el,
      state,
      tab: 'cvd',
      label: 'Your figure, as it is',
      lines: false,
      hints: { empty: EMPTY_HINT, loaded: '' },
      onLoad: (f) => {
        const example = f.name === EXAMPLE_NAME;
        // There is always an image: Clear goes back to the example.
        fig.clear.disabled = example;
        fig.hint.textContent = example
          ? 'Showing the example, a heatmap in jet. Drop, paste or choose your own image to check it.'
          : 'Drop, paste or choose another image, or Clear to go back to the example.';
        cache.clear();
        controls.hidden = false;
        grid.hidden = false;
        note.hidden = false;
        render();
      },
      onReset: (keepImage) => {
        job++;
        clearMarks();
        readout.textContent = '';
        if (!keepImage) { controls.hidden = true; grid.hidden = true; note.hidden = true; }
      },
      onError: (msg) => { status.textContent = msg; },
    });
    fig.clear.addEventListener('click', () => fig.loadExample());
    fig.canvas.classList.add('cmap-cvd-canvas');

    // ---- panels ----
    const grid = el('div', { class: 'cmap-cvd-grid', hidden: '' });
    function panel(canvas, key) {
      const f = el('figure', { class: 'cmap-cvd-panel' });
      const cap = el('figcaption');
      const stack = el('div', { class: 'cmap-cvd-stack' });
      const marks = el('div', { class: 'cmap-cvd-marks', 'aria-hidden': 'true' });
      const mark = el('span', { class: 'cmap-cvd-mark', hidden: '' });
      marks.append(mark);
      stack.append(canvas, marks);
      f.append(cap, stack);
      return { key, f, cap, canvas, mark };
    }
    const orig = panel(fig.canvas, 'original');
    orig.cap.textContent = 'Original';
    const sims = TYPES.map(([k, , name]) => {
      const c = el('canvas', { class: 'cmap-id-canvas cmap-cvd-canvas', role: 'img', 'aria-label': `${name} simulation` });
      return panel(c, k);
    });
    const panels = [orig, ...sims];
    grid.append(...panels.map((p) => p.f));
    const readout = el('p', { class: 'cmap-cvd-readout muted' });
    const note = el('p', { class: 'cmap-fig-cap muted', hidden: '' });
    note.append('Simulated in linear sRGB with ', ref('brettel', 'Brettel et al. 1997'), ', ', ref('vienot', 'Viénot et al. 1999'), ' (both with libDaltonLens’ parameters) or ',
      ref('machado', 'Machado et al. 2009'), '; Recommended follows the ', ref('daltonlens', 'DaltonLens review'),
      '. A simulation shows which colors become hard to tell apart, not exactly what any one person sees. Hover to compare colors; press and hold a simulation to see the original.');
    function ref(key, text) { return el('a', { href: `#ref-${key}` }, text); }

    d.append(fig.zone, fig.file, controls, status, grid, readout, note);

    // ---- simulation ----
    let job = 0; // the run in progress; a new one cancels it
    const cache = new Map(); // `${type}|${model}|${severity}` -> ImageData, oldest first
    const severity = () => Number(sev.value);
    const shownTypes = () => (type === 'all' ? TYPES.map((t) => t[0]) : [type]);

    function caption(k) {
      const [, label, full, partial] = TYPE.get(k);
      const s = severity();
      const used = CM.resolveCvdModel(k, model.value);
      const m = MODEL_NAMES[used] + (model.value === 'vienot' && used !== 'vienot' ? '; Viénot 1999 has no tritan model' : '');
      if (s === 0) return `${label}, severity 0: normal vision`;
      return s >= 1 ? `${full} (${m})` : `${partial}, severity ${s.toFixed(1)} (${m})`;
    }

    const pause = () => new Promise((r) => setTimeout(r, 0));

    async function simulate(k, my) {
      const key = `${k}|${CM.resolveCvdModel(k, model.value)}|${severity()}`;
      const hit = cache.get(key);
      if (hit) { cache.delete(key); cache.set(key, hit); return hit; } // most recent last
      const src = fig.img;
      const out = new ImageData(src.width, src.height);
      const opts = { model: model.value, severity: severity(), out: out.data, cache: new Map() };
      opts.fn = CM.cvdLinearFn(k, opts);
      const n = src.width * src.height;
      for (let from = 0; from < n; from += CHUNK) {
        CM.simulateCvdPixels(src.data, k, { ...opts, from, to: Math.min(n, from + CHUNK) });
        if (n > CHUNK) {
          status.textContent = `Simulating… ${Math.round((100 * Math.min(n, from + CHUNK)) / n)}%`;
          await pause();
          if (my !== job) return null;
        }
      }
      cache.set(key, out);
      while (cache.size > KEEP) cache.delete(cache.keys().next().value);
      return out;
    }

    async function render() {
      if (!fig.img) return;
      const my = ++job;
      sevOut.textContent = severity().toFixed(1);
      const show = shownTypes();
      grid.classList.toggle('all', type === 'all');
      status.textContent = '';
      for (const p of sims) {
        p.f.hidden = !show.includes(p.key);
        if (!p.f.hidden) p.cap.textContent = caption(p.key);
      }
      for (const k of show) {
        const out = await simulate(k, my);
        if (my !== job) return;
        const p = sims.find((s) => s.key === k);
        p.canvas.width = out.width;
        p.canvas.height = out.height;
        p.canvas.getContext('2d').putImageData(out, 0, 0);
        p.data = out;
      }
      status.textContent = '';
      if (last) showAt(last); // keep the readout in step with the new settings
    }

    sev.addEventListener('input', render);
    model.addEventListener('change', render);

    // ---- hover: the same spot on every panel, with its colors ----
    let last = null; // the last hovered image pixel
    const hex = (rgb) => CM.rgbToHex(rgb);
    const pixel = (data, x, y) => { const o = (y * data.width + x) * 4; return [data.data[o], data.data[o + 1], data.data[o + 2]]; };

    function clearMarks() {
      last = null;
      for (const p of panels) p.mark.hidden = true;
    }

    function swatch(rgb) {
      return el('span', { class: 'cmap-sw', style: `background:${hex(rgb)}`, title: hex(rgb) });
    }

    function showAt({ x, y }) {
      const img = fig.img;
      if (!img) return;
      last = { x, y };
      for (const p of panels) {
        if (p.f.hidden) continue;
        p.mark.hidden = false;
        p.mark.style.left = `${(100 * (x + 0.5)) / img.width}%`;
        p.mark.style.top = `${(100 * (y + 0.5)) / img.height}%`;
      }
      const o = pixel(img, x, y);
      const lab = CM.rgbToLab(o);
      readout.replaceChildren('Original ', swatch(o), ` ${hex(o)}`);
      for (const p of sims) {
        if (p.f.hidden || !p.data) continue;
        const s = pixel(p.data, x, y);
        const de = CM.deltaE2000(lab, CM.rgbToLab(s));
        readout.append(` · ${TYPE.get(p.key)[1]} `, swatch(s), ` ${hex(s)} (ΔE ${de.toFixed(1)})`);
      }
    }

    for (const p of panels) {
      p.canvas.addEventListener('pointermove', (e) => {
        if (!fig.img || p.canvas.hidden) return;
        const r = p.canvas.getBoundingClientRect();
        const w = p.canvas.clientWidth || 1;
        const h = p.canvas.clientHeight || 1;
        const x = Math.floor(((e.clientX - r.left - p.canvas.clientLeft) / w) * fig.img.width);
        const y = Math.floor(((e.clientY - r.top - p.canvas.clientTop) / h) * fig.img.height);
        if (x < 0 || y < 0 || x >= fig.img.width || y >= fig.img.height) return;
        showAt({ x, y });
      });
      p.canvas.addEventListener('pointerleave', () => { clearMarks(); readout.textContent = ''; });
    }

    // Press and hold a simulation to see the original in its place.
    for (const p of sims) {
      const back = () => {
        if (!p.peek) return;
        p.peek = false;
        if (p.data) p.canvas.getContext('2d').putImageData(p.data, 0, 0);
        p.cap.textContent = caption(p.key);
      };
      p.canvas.addEventListener('pointerdown', (e) => {
        if (!fig.src || !p.data || e.button > 0) return;
        e.preventDefault();
        p.canvas.setPointerCapture(e.pointerId);
        p.peek = true;
        p.canvas.getContext('2d').drawImage(fig.src, 0, 0);
        p.cap.textContent = 'Original (release to go back)';
      });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) p.canvas.addEventListener(t, back);
    }

    // ---- download: the simulation, or all four panels in a 2 × 2 grid ----
    download.addEventListener('click', () => {
      if (!fig.src) return;
      const shown = sims.filter((p) => !p.f.hidden && p.data);
      if (!shown.length) return;
      let c = shown[0].canvas;
      let what = `${shown[0].key}-${CM.resolveCvdModel(shown[0].key, model.value)}-s${severity().toFixed(1)}`;
      if (type === 'all') {
        const { width: w, height: h } = fig.src;
        const gap = Math.max(4, Math.round(Math.max(w, h) / 100));
        c = document.createElement('canvas');
        c.width = 2 * w + gap;
        c.height = 2 * h + gap;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        [fig.src, ...shown.map((p) => p.canvas)].forEach((src, i) => g.drawImage(src, (i % 2) * (w + gap), Math.floor(i / 2) * (h + gap)));
        what = `cvd-${model.value}-s${severity().toFixed(1)}`;
      }
      c.toBlob((blob) => {
        if (!blob) { status.textContent = 'Could not make the PNG.'; return; }
        const a = el('a', { href: URL.createObjectURL(blob), download: `${fig.name}-${what}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    });

    // The example loads the first time the tab is shown.
    let started = false;
    function show() {
      if (started || fig.img) return;
      started = true;
      fig.loadExample();
    }

    return { sec: d, show };
  }

  Object.assign(CM, { setupCmapCvd });
})((globalThis.Colormeris ??= {}));
