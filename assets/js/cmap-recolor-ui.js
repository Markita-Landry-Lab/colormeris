(function (CM) {
  'use strict';

  // The Recolor tab of the colormap viewer (colormaps.html): load a figure,
  // drag along its colorbar, pick another colormap, and the figure is redrawn
  // in it (cmap-recolor.js). Pixels far from the bar's colors (background,
  // text, axes) keep theirs. Hovering a color in the figure or on the strips
  // flashes every pixel with a similar value. The image never leaves the browser.

  const GROUPS = [
    ['sequential', 'Sequential'],
    ['diverging', 'Diverging'],
    ['cyclic', 'Cyclic'],
    ['rainbow', 'Rainbow'],
    ['others', 'Others'],
  ];
  const DEFAULT_MAP = 'viridis';
  const TOLERANCE = 12; // ΔE76: JPEG noise stays inside, white and gray outside
  const BAND = 0.02; // share of the bar that counts as "similar" on hover
  const CHUNK = 300000; // pixels indexed between pauses
  const FLASH = [255, 0, 255]; // magenta; the CSS animation inverts it to green
  const OVERLAY_MAX = 1600; // the highlight is drawn at about screen size, not image size

  function setupCmapRecolor(ctx) {
    const { el, pct, data, state, mapByName, base, stripSvg, roundRgb } = ctx;

    const d = el('section', { class: 'cmap-recolor', 'aria-labelledby': 'cmap-recolor-title', hidden: '' });
    d.append(el('h2', { id: 'cmap-recolor-title' }, 'Recolor a figure into another colormap'));
    d.append(el('p', { class: 'muted' }, 'Give an image of a figure, drag along its colorbar, and pick a new colormap. Each pixel with a color of the bar gets the new map’s color at the same place. The image stays in your browser.'));

    const EMPTY_HINT = 'Drop an image here, paste one (Ctrl/Cmd+V), or choose a file (PNG, JPEG, WebP or GIF).';
    const status = el('p', { class: 'cmap-id-status', 'aria-live': 'polite' });
    const oldNote = el('p', { class: 'cmap-rc-old', hidden: '' });

    // ---- controls ----
    const controls = el('div', { class: 'cmap-rc-controls', hidden: '' });
    const pick = el('select', { 'aria-label': 'New colormap' });
    for (const [group, title] of GROUPS) {
      const og = el('optgroup', { label: title });
      for (const m of data.maps.filter((x) => x.group === group)) og.append(el('option', { value: m.name }, m.name));
      if (og.children.length) pick.append(og);
    }
    pick.value = DEFAULT_MAP;
    const revBox = el('input', { type: 'checkbox' });
    const revLabel = el('label', { class: 'cmap-rc-check' });
    revLabel.append(revBox, ' Reversed');
    const mapField = field('New colormap', 'The colormap the figure is redrawn in', pick, revLabel);

    const tol = el('input', { type: 'range', min: '2', max: '40', step: '1', value: String(TOLERANCE) });
    const tolOut = el('output', {}, String(TOLERANCE));
    const tolField = field('Match within (ΔE)', 'Pixels farther than this from every colorbar color keep their color (background, text, axes). Raise it for noisy or JPEG images; lower it if white or gray parts change.', tol, tolOut);

    const band = el('input', { type: 'range', min: '0.5', max: '10', step: '0.5', value: String(BAND * 100) });
    const bandOut = el('output', {}, pct(BAND));
    const bandField = field('Similar within', 'On hover, pixels whose place on the colorbar is this close to the hovered one flash', band, bandOut);

    const views = el('div', { class: 'cmap-tabs', role: 'group', 'aria-label': 'Image to show' });
    const viewBtns = ['original', 'recolored'].map((v) => {
      const b = el('button', { type: 'button', 'aria-pressed': 'false' }, v === 'original' ? 'Original' : 'Recolored');
      b.dataset.view = v;
      b.addEventListener('click', () => setView(v));
      views.append(b);
      return b;
    });
    const download = el('button', { type: 'button', class: 'btn small primary' }, 'Download PNG');
    const actions = el('div', { class: 'cmap-id-bar cmap-rc-actions' });
    actions.append(views, download);
    const fieldsRow = el('div', { class: 'cmap-rc-fields' });
    fieldsRow.append(mapField, tolField, bandField);
    controls.append(fieldsRow, actions);

    // ---- strips: the sampled bar over the new colors, both hoverable ----
    const strips = el('div', { class: 'cmap-rc-strips', hidden: '' });
    const oldStrip = el('div', { class: 'cmap-id-strip cmap-rc-strip', role: 'slider', tabindex: '0', 'aria-label': 'Colors of the old colorbar. Hover or use the arrow keys to highlight a value.', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    const newStrip = el('div', { class: 'cmap-id-strip cmap-rc-strip', role: 'slider', tabindex: '0', 'aria-label': 'The new colors at the same places. Hover or use the arrow keys to highlight a value.', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    strips.append(el('span', { class: 'muted' }, 'Old colors, as sampled along the line'), oldStrip,
      el('span', { class: 'muted' }, 'New colors'), newStrip);
    const readout = el('p', { class: 'cmap-rc-readout muted', 'aria-live': 'polite' });

    // ---- the figure, with the highlight on top ----
    const stack = el('div', { class: 'cmap-rc-stack' });
    const overlay = el('canvas', { class: 'cmap-rc-overlay', 'aria-hidden': 'true' });

    let samples = null; // the calibrated bar
    let flip = false; // the line was drawn from the old map's high end
    let index = null; // per-pixel t and ΔE
    let out = null; // offscreen canvas with the recolored image
    let view = 'recolored';
    let job = 0; // the indexing run in progress; a new one cancels it
    let hoverT = null;
    let mask = null;
    let overlayData = null;
    let pending = null; // the latest hover, drawn at the next frame
    let frame = 0;

    const fig = CM.createFigureInput({
      el,
      state,
      tab: 'recolor',
      label: 'Your figure. Drag along the colorbar from its low end to its high end, then hover a color to see where it is.',
      hints: {
        empty: EMPTY_HINT,
        loaded: 'Drag along the colorbar from one end to the other. The figure is then redrawn in the new colormap. Hover a color to see where it appears.',
      },
      base: () => (view === 'recolored' && out ? out : null),
      showLine: () => view === 'original' || !out,
      keepLineOnClick: true,
      onReset: (keepImage) => {
        job++;
        samples = null;
        index = null;
        out = null;
        mask = null;
        overlayData = null;
        clearHighlight();
        controls.hidden = true;
        strips.hidden = true;
        oldNote.hidden = true;
        status.textContent = '';
        readout.textContent = '';
        if (!keepImage) overlay.hidden = true;
      },
      onLoad: () => { overlay.hidden = false; },
      onError: (msg) => { status.textContent = msg; },
      onLine: (a, b) => calibrate(a, b),
    });
    stack.append(fig.canvas, overlay);
    d.append(fig.zone, fig.file, oldNote, controls, stack, status, readout, strips);

    function field(label, title, ...inputs) {
      const f = el('div', { class: 'cmap-rc-field', title });
      const row = el('div', { class: 'cmap-rc-input' });
      row.append(...inputs);
      f.append(el('span', { class: 'cmap-rc-label' }, label), row);
      return f;
    }

    const newMap = () => {
      const m = mapByName.get(pick.value) || mapByName.get(DEFAULT_MAP);
      return { name: m.name, kind: m.kind, rgbs: base(m) };
    };
    const tolerance = () => Number(tol.value);
    const bandWidth = () => Number(band.value) / 100;
    const mapLabel = () => `${pick.value}${revBox.checked ? '_r' : ''}`;

    function setView(v) {
      view = v;
      for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.view === v));
      fig.redraw();
    }

    // ---- calibration ----

    function calibrate(a, b) {
      const img = fig.img;
      const k = CM.refineColorbar(img, a, b);
      let start = a;
      let end = b;
      let half = 2;
      if (k) { ({ start, end } = k); half = k.halfWidth; }
      fig.line = { start, end };
      out = null;
      fig.redraw();
      const s = CM.sampleColorbar(img, start, end, half, 256);
      if (s.length < 2) { status.textContent = 'That line is too short.'; return; }
      samples = s;
      describeOld(s.map((x) => x.rgb), Boolean(k));
      buildIndex();
    }

    // Name the old map when it is a known one, and read the bar in its
    // direction, so the low end stays the low end whichever way it was drawn.
    function describeOld(rgbs, snapped) {
      const maps = data.maps.map((m) => ({ name: m.name, kind: m.kind, rgbs: base(m) }));
      const best = CM.identifyColorbar(rgbs, maps)[0];
      const level = best ? CM.matchLevel(best.score) : 'none';
      flip = level !== 'none' && best.reversed;
      oldNote.replaceChildren();
      oldNote.hidden = false;
      if (level === 'none') {
        oldNote.append(`The old colors match no matplotlib colormap (best ΔE ${best ? best.score.toFixed(1) : '–'}), so the end where you started the line is taken as the low end.`);
      } else {
        oldNote.append(level === 'exact' ? 'Old colormap: ' : 'Old colormap looks like ', el('code', {}, best.name), ` (ΔE ${best.score.toFixed(1)}).`);
        if (flip) oldNote.append(' The line runs from its high end, so it is read the other way.');
      }
      if (!snapped) oldNote.append(' The line could not be snapped to a colorbar; drag along the middle of the bar.');
    }

    function buildIndex() {
      const my = ++job;
      const ix = CM.createIndexer(fig.img, samples);
      status.textContent = 'Reading the colors…';
      const tick = () => {
        if (my !== job) return; // a newer calibration or another image
        const done = ix.step(CHUNK);
        if (done < 1) {
          status.textContent = `Reading the colors… ${pct(done)}`;
          setTimeout(tick, 0);
          return;
        }
        index = ix.index;
        mask = null;
        status.textContent = '';
        controls.hidden = false;
        strips.hidden = false;
        render();
        setView('recolored');
      };
      setTimeout(tick, 0);
    }

    // ---- recoloring ----

    function render() {
      if (!index) return;
      const img = fig.img;
      const r = CM.recolorPixels(img, index, newMap(), { tolerance: tolerance(), reversed: revBox.checked, flip });
      out ??= document.createElement('canvas');
      out.width = img.width;
      out.height = img.height;
      out.getContext('2d').putImageData(new ImageData(r.data, img.width, img.height), 0, 0);
      oldStrip.innerHTML = stripSvg(samples.map((s) => roundRgb(s.rgb)), false);
      const m = newMap();
      const opt = { reversed: revBox.checked, flip };
      const colors = Array.from({ length: 128 }, (_, i) => roundRgb(CM.newColorAt(m, i / 127, opt)));
      newStrip.innerHTML = stripSvg(colors, m.kind === 'qualitative');
      for (const s of [oldStrip, newStrip]) s.append(el('span', { class: 'cmap-rc-mark', hidden: '' }));
      readout.textContent = `${pct(r.changed / (img.width * img.height))} of the pixels have a color of the bar and are recolored. Hover a color to see where it is.`;
      fig.redraw();
      if (hoverT != null) highlight(hoverT, true);
    }

    // ---- hover highlight ----

    const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Pointer events can come faster than a big image can be masked, so only
    // the latest one per frame is drawn.
    function hover(t) {
      pending = t;
      if (frame) return;
      const run = () => { frame = 0; if (pending != null) highlight(pending); };
      frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
    }

    function highlight(t, force = false) {
      if (!index) return;
      pending = null;
      t = Math.max(0, Math.min(1, t));
      // Pointer moves of a fraction of the band would give the same picture.
      if (!force && hoverT != null && Math.abs(t - hoverT) < bandWidth() / 8) return;
      hoverT = t;
      const step = Math.ceil(Math.max(index.width, index.height) / OVERLAY_MAX);
      const res = CM.similarMask(index, t, bandWidth(), tolerance(), { step, mask });
      mask = res.mask;
      const n = mask.length;
      if (overlay.width !== res.width || overlay.height !== res.height) {
        overlay.width = res.width;
        overlay.height = res.height;
      }
      if (!overlayData || overlayData.width !== res.width || overlayData.height !== res.height) overlayData = new ImageData(res.width, res.height);
      const px = new Uint32Array(overlayData.data.buffer);
      // Little-endian RGBA as one word.
      const on = (255 << 24) | (FLASH[2] << 16) | (FLASH[1] << 8) | FLASH[0];
      const calm = reduceMotion();
      const dim = (180 << 24) | (255 << 16) | (255 << 8) | 255; // white veil over the rest
      for (let i = 0; i < n; i++) px[i] = mask[i] ? (calm ? 0 : on) : (calm ? dim : 0);
      overlay.getContext('2d').putImageData(overlayData, 0, 0);
      overlay.classList.toggle('flash', !calm);
      overlay.classList.add('on');
      for (const s of [oldStrip, newStrip]) {
        const mk = s.querySelector('.cmap-rc-mark');
        if (mk) { mk.hidden = false; mk.style.left = `${(t * 100).toFixed(2)}%`; }
        s.setAttribute('aria-valuenow', String(Math.round(t * 100)));
      }
      const c = roundRgb(CM.colorAtT(samples, t));
      const sw = el('span', { class: 'cmap-sw', style: `background:${CM.rgbToHex(c)}` });
      readout.replaceChildren(sw, ` At ${pct(t)} of the bar: ${pct(res.count / res.total)} of the pixels (±${pct(bandWidth())}).`);
    }

    function clearHighlight() {
      hoverT = null;
      pending = null;
      overlay.classList.remove('on', 'flash');
      for (const s of [oldStrip, newStrip]) {
        const mk = s.querySelector('.cmap-rc-mark');
        if (mk) mk.hidden = true;
      }
    }

    fig.canvas.addEventListener('pointermove', (e) => {
      if (!index || fig.dragging) return;
      const p = fig.pointAt(e);
      const hit = CM.tAtPixel(index, p.x, p.y, tolerance());
      if (hit) hover(hit.t);
      else if (hoverT != null || pending != null) clearHighlight();
    });
    fig.canvas.addEventListener('pointerdown', () => clearHighlight());
    fig.canvas.addEventListener('pointerleave', () => clearHighlight());

    for (const s of [oldStrip, newStrip]) {
      const tOf = (e) => {
        const r = s.getBoundingClientRect();
        return (e.clientX - r.left) / (r.width || 1);
      };
      s.addEventListener('pointermove', (e) => hover(tOf(e)));
      s.addEventListener('pointerdown', (e) => highlight(tOf(e), true));
      s.addEventListener('pointerleave', () => { if (document.activeElement !== s) clearHighlight(); });
      s.addEventListener('blur', clearHighlight);
      s.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.1 : 0.01;
        const now = hoverT ?? 0.5;
        const next = { ArrowLeft: now - step, ArrowDown: now - step, ArrowRight: now + step, ArrowUp: now + step, Home: 0, End: 1 }[e.key];
        if (next == null) return;
        e.preventDefault();
        highlight(next, true);
      });
    }

    pick.addEventListener('change', render);
    revBox.addEventListener('change', render);
    tol.addEventListener('input', () => { tolOut.textContent = tol.value; render(); });
    band.addEventListener('input', () => {
      bandOut.textContent = pct(bandWidth());
      if (hoverT != null) highlight(hoverT, true);
    });

    download.addEventListener('click', () => {
      if (!out) return;
      out.toBlob((blob) => {
        if (!blob) { status.textContent = 'Could not make the PNG.'; return; }
        const a = el('a', { href: URL.createObjectURL(blob), download: `${fig.name}-${mapLabel()}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, 'image/png');
    });

    // From Identify: the same figure and line, recolored at once.
    async function open(file, line) {
      if (!file) return;
      if (!(await fig.load(file))) return;
      if (line) calibrate(line.start, line.end);
    }

    return { sec: d, open };
  }

  Object.assign(CM, { setupCmapRecolor });
})((globalThis.Colormeris ??= {}));
