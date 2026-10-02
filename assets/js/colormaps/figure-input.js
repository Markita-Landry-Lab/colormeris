(function (CM) {
  'use strict';

  // The figure input shared by the Identify and Recolor tabs of the colormap
  // viewer: a drop zone with Choose / Example / Clear buttons, paste while the
  // tab is shown, and a canvas with the image on which a line is dragged along
  // the colorbar. The image never leaves the browser.
  //
  // opts: { el, state, tab, label, hints: { empty, loaded }, buttons: [extra
  // buttons for the bar], base(): what to draw under the line (default the
  // image), showLine(): whether to draw it, onLoad(file), onReset(keepImage),
  // onError(msg), onLine(start, end) after a drag, lines: false for no line
  // at all (the CVD tab) }.

  const MAX_SIDE = 4000; // larger images are scaled down before sampling
  const EXAMPLE = 'assets/examples/example-jet.png';

  function createFigureInput(opts) {
    const { el, state, tab, hints } = opts;
    const file = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    const example = el('button', { type: 'button', class: 'btn small' }, 'Example image (jet)');
    const clear = el('button', { type: 'button', class: 'btn small', disabled: '' }, 'Clear');
    const bar = el('div', { class: 'cmap-id-bar' });
    bar.append(example, ...(opts.buttons || []), clear);
    // The box says only how to give an image. How to use the tool goes in `hint`,
    // below the buttons and outside the box.
    const dropText = el('p', { class: 'cmap-id-hint' }, hints.empty);
    const hint = el('p', { class: 'cmap-id-hint' });
    const zone = el('div', { class: 'cmap-drop-wrap' });
    // An arrow into a tray, so the dashed box reads as a place to drop an image.
    const icon = el('span', { class: 'cmap-drop-icon', 'aria-hidden': 'true' });
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    // The whole dashed box is the button that opens the file dialog; Example and
    // Clear sit outside it, since they do not take a file from the box.
    const region = el('div', { class: 'cmap-drop', role: 'button', tabindex: '0', 'aria-label': 'Choose an image file' });
    region.append(icon, dropText);
    zone.append(region, bar, hint);
    const canvas = el('canvas', { class: 'cmap-id-canvas', hidden: '', role: 'img', tabindex: '0', 'aria-label': opts.label });

    const fig = {
      zone, file, canvas, hint,
      src: null, // offscreen canvas with the full-resolution image
      img: null, // its ImageData
      name: '', // file name without extension
      lastFile: null,
      line: null, // { start, end } in image pixels
      dragging: false,
    };
    let drag = null;

    // Pointer positions are relative to the content box: the border is not part of the image.
    const scale = () => canvas.width / (canvas.clientWidth || canvas.width);

    function redraw() {
      if (!fig.src) return;
      const g = canvas.getContext('2d');
      g.drawImage(opts.base?.() || fig.src, 0, 0);
      const line = fig.line;
      if (!line || (opts.showLine && !opts.showLine() && !drag)) return;
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
      fig.line = null;
      drag = null;
      fig.dragging = false;
      if (!keepImage) {
        fig.src = null;
        fig.img = null;
        fig.lastFile = null;
        canvas.hidden = true;
        clear.disabled = true;
        file.value = '';
      }
      opts.onReset?.(keepImage);
      if (keepImage && fig.src) redraw();
    }

    function fail(msg) {
      reset(false);
      opts.onError?.(msg);
    }

    // Resolves true once the image is shown, false when it could not be read.
    function load(f) {
      return new Promise((resolve) => {
        if (!f || !/^image\//.test(f.type)) { fail('That file is not an image. Use a PNG, JPEG, WebP or GIF.'); resolve(false); return; }
        const url = URL.createObjectURL(f);
        const im = new Image();
        im.onload = () => {
          URL.revokeObjectURL(url);
          try {
            const k = Math.min(1, MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight));
            const w = Math.max(1, Math.round(im.naturalWidth * k));
            const h = Math.max(1, Math.round(im.naturalHeight * k));
            const src = document.createElement('canvas');
            src.width = w;
            src.height = h;
            const g = src.getContext('2d', { willReadFrequently: true });
            g.fillStyle = '#fff'; // transparent pixels count as white, as readPixel does
            g.fillRect(0, 0, w, h);
            g.drawImage(im, 0, 0, w, h);
            fig.src = src;
            fig.img = g.getImageData(0, 0, w, h);
            fig.lastFile = f;
            fig.name = String(f.name || 'figure').replace(/\.[^.]*$/, '') || 'figure';
            canvas.width = w;
            canvas.height = h;
            reset(true);
            canvas.hidden = false;
            clear.disabled = false;
            hint.textContent = hints.loaded;
            opts.onLoad?.(f);
            redraw();
            resolve(true);
          } catch (err) {
            console.warn('Could not read the image', err);
            fail('Could not read that image.');
            resolve(false);
          }
        };
        im.onerror = () => { URL.revokeObjectURL(url); fail('Could not open that image.'); resolve(false); };
        im.src = url;
      });
    }

    function pointAt(e) {
      const r = canvas.getBoundingClientRect();
      const k = scale();
      return {
        x: Math.max(0, Math.min(canvas.width - 1, (e.clientX - r.left - canvas.clientLeft) * k)),
        y: Math.max(0, Math.min(canvas.height - 1, (e.clientY - r.top - canvas.clientTop) * k)),
      };
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!fig.img || e.button > 0 || opts.lines === false) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      drag = { start: pointAt(e), px: e.clientX, py: e.clientY, before: fig.line };
      fig.dragging = true;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      fig.line = { start: drag.start, end: pointAt(e) };
      redraw();
    });
    const finish = (e) => {
      if (!drag) return;
      const { start, px, py, before } = drag;
      drag = null;
      fig.dragging = false;
      // A click or a cancelled drag keeps the line there was.
      if (e.type === 'pointercancel' || Math.hypot(e.clientX - px, e.clientY - py) < 8) { fig.line = opts.keepLineOnClick ? before : null; redraw(); return; }
      opts.onLine?.(start, pointAt(e));
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);

    region.addEventListener('click', () => file.click());
    region.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      file.click();
    });
    file.addEventListener('change', () => { if (file.files[0]) load(file.files[0]); });
    async function loadExample() {
      try {
        const res = await fetch(EXAMPLE);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await load(new File([await res.blob()], 'example-jet.png', { type: 'image/png' }));
      } catch (err) {
        fail(`Could not load the example (${err.message}). Serve the folder with npm run serve.`);
        return false;
      }
    }
    example.addEventListener('click', loadExample);
    clear.addEventListener('click', () => { reset(false); hint.textContent = ''; });

    const fileOf = (dt) => [...(dt?.files || [])].find((f) => /^image\//.test(f.type)) || [...(dt?.files || [])][0];
    for (const t of [zone, canvas]) {
      t.addEventListener('dragover', (e) => { e.preventDefault(); region.classList.add('over'); });
      t.addEventListener('dragleave', () => region.classList.remove('over'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        region.classList.remove('over');
        load(fileOf(e.dataTransfer));
      });
    }
    // Paste works anywhere on the page while this tab is shown.
    document.addEventListener('paste', (e) => {
      if (state.tab !== tab || e.target.closest?.('input[type="search"], textarea')) return;
      const f = fileOf(e.clipboardData);
      if (!f) return;
      e.preventDefault();
      load(f);
    });

    return Object.assign(fig, { redraw, reset, fail, load, loadExample, pointAt, scale, clear });
  }

  Object.assign(CM, { createFigureInput });
})((globalThis.Colormeris ??= {}));
