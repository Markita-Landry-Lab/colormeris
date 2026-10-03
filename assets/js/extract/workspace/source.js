(function (CM) {
  'use strict';
  const { fileKind, openPdf, renderPdfPage, imageToCanvas, canvasImageData, sha256Hex, createProject, rescalePanel, readProjectZip } = CM;

  // The source file and its pages: opening PDFs, images and project zips
  // (file dialog, examples, drag and drop, paste), PDF pages, render
  // resolution and the zoom box.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (setMode, changed, ensurePagePanel, ...).
  function setupWorkspaceSource(w) {
    const { $, app } = w;

    async function openFile(file) {
      if (!file) return;
      const kind = fileKind(file);
      if (kind === 'unknown') {
        w.toast(`Unsupported file type: ${file.name}`, true);
        return;
      }
      try {
        if (kind === 'zip') {
          await openProjectZip(file);
          return;
        }
        if (hasCalibration() && !confirm('Opening a new file starts a new project and discards the current calibration. Continue?')) return;
        w.setMode(null);
        w.status(`Loading ${file.name}…`);
        const project = createProject(w.tool().kind);
        Object.assign(project.panels[0].settings, w.panelDefaults(w.tool().kind));
        project.activePanelId = project.panels[0].id;
        project.name = file.name.replace(/\.[^.]+$/, '');
        project.source = { fileName: file.name, mime: file.type || null, page: 1, pageCount: 1, renderScale: 1, width: 0, height: 0, sha256: null };
        app.pdfDoc = null;
        let canvas;
        if (kind === 'pdf') {
          app.pdfDoc = await openPdf(file);
          project.source.pageCount = app.pdfDoc.numPages;
          const scale = Number($('scale-select').value);
          const r = await renderPdfPage(app.pdfDoc, 1, scale);
          canvas = r.canvas;
          project.source.renderScale = r.scale;
        } else {
          canvas = await imageToCanvas(file);
        }
        app.project = project;
        app.originalFile = file;
        w.clearHistory();
        app.lastActive.clear();
        app.pages = new Map([[1, { canvas, imageData: canvasImageData(canvas) }]]);
        app.cache.clear();
        showPage(1);
        w.status('');
        sha256Hex(file).then((h) => (project.source.sha256 = h));
      } catch (err) {
        console.error(err);
        w.status('');
        w.toast(`Could not open ${file.name}: ${err.message}`, true);
      }
    }

    function hasCalibration() {
      return app.project.panels.some((p) => p.grid.corners || p.colorbar.start || p.colorbar.colormap || w.toolFor(p)?.hasCalibration?.(p));
    }

    // Display a page that is already in app.pages.
    function showPage(page, { keepView = false } = {}) {
      const entry = app.pages.get(page);
      app.sourceCanvas = entry.canvas;
      app.imageData = entry.imageData;
      app.project.source.width = entry.canvas.width;
      app.project.source.height = entry.canvas.height;
      w.viewer.setSource(entry.canvas, { keepView });
      w.onHover(null);
      updateSourceUi();
      w.changed();
    }

    // Rendered image of a page, rendering it from the PDF when needed.
    async function ensurePage(page) {
      if (app.pages.has(page)) return app.pages.get(page);
      if (!app.pdfDoc) return null;
      const { canvas } = await renderPdfPage(app.pdfDoc, page, app.project.source.renderScale);
      const entry = { canvas, imageData: canvasImageData(canvas) };
      app.pages.set(page, entry);
      return entry;
    }

    function updateSourceUi() {
      const s = app.project.source;
      $('source-label').textContent = s.fileName;
      $('source-label').title = s.fileName;
      $('source-label').classList.remove('muted');
      // Page controls also work for a reopened project that has several page images but no PDF.
      const isPdf = !!app.pdfDoc || s.pageCount > 1;
      $('pdf-controls').hidden = !isPdf;
      // The page number is already in the page controls next to it.
      $('source-info').textContent = `${s.fileName} · ${s.width} × ${s.height} px`;
      if (isPdf) {
        $('page-input').max = s.pageCount;
        w.setValue($('page-input'), s.page);
        $('page-count').textContent = `of ${s.pageCount}`;
        $('page-prev').disabled = s.page <= 1;
        $('page-next').disabled = s.page >= s.pageCount;
        const opt = [...$('scale-select').options].find((o) => Math.abs(Number(o.value) - s.renderScale) < 1e-6);
        if (opt) $('scale-select').value = opt.value;
      }
    }

    // 100% is the page's true size: a PDF rendered at 3× shows 100% at viewer scale 1/3.
    function showZoom(v) {
      const el = $('zoom-level');
      if (document.activeElement === el) return; // don't overwrite what is being typed
      const pct = `${Math.round(v.scale * (app.project?.source?.renderScale || 1) * 100)}%`;
      if (el.value !== pct) el.value = pct;
    }
    // Typed zoom: "150", "150%" or "1.5x"; zooms around the view's center. Bad input reverts.
    function applyZoomInput() {
      const el = $('zoom-level');
      const m = el.value.trim().match(/^(\d+(?:\.\d+)?)\s*(%|x|×)?$/i);
      const pct = m ? Number(m[1]) * (/x|×/i.test(m[2] || '') ? 100 : 1) : NaN;
      if (pct > 0 && w.viewer.source) w.viewer.zoomBy(pct / 100 / (app.project.source.renderScale || 1) / w.viewer.scale);
      el.value = '';
      showZoom(w.viewer);
    }

    // Switch the view to another PDF page. Panels stay with the page they were
    // made on; the new page shows its own panels (or a fresh one).
    async function goToPage(page, { keepActive = false } = {}) {
      const s = app.project.source;
      if (!s) return;
      page = Math.min(s.pageCount, Math.max(1, Math.round(page) || 1));
      if (page === s.page) {
        updateSourceUi();
        return;
      }
      try {
        w.status(`Rendering page ${page}…`);
        if (!(await ensurePage(page))) throw new Error('the page image is not available');
        w.setMode(null);
        const oldPage = s.page;
        const leaving = w.activePanel();
        app.lastActive.set(w.activeKey(oldPage), leaving.id);
        // Drop untouched placeholder panels left on the page being left.
        app.project.panels = app.project.panels.filter((p) => p.page !== oldPage || !w.isEmptyPanel(p));
        s.page = page;
        w.ensurePagePanel(page, leaving.tool === w.tool().kind ? leaving.settings : undefined);
        if (!keepActive || !w.pagePanels().some((p) => p.id === app.project.activePanelId)) {
          const remembered = app.lastActive.get(w.activeKey(page));
          app.project.activePanelId = w.pagePanels().some((p) => p.id === remembered) ? remembered : w.pagePanels()[0].id;
        }
        app.tableCell = null;
        app.hoverCell = null;
        showPage(page);
        w.status('');
      } catch (err) {
        console.error(err);
        w.status('');
        updateSourceUi();
        w.toast(`Could not show page ${page}: ${err.message}`, true);
      }
    }

    // Re-render at another resolution. All panel coordinates scale with it.
    async function changeScale(scale) {
      const s = app.project.source;
      if (!app.pdfDoc || Math.abs(scale - s.renderScale) < 1e-9) return;
      try {
        w.status('Rendering…');
        const r = await renderPdfPage(app.pdfDoc, s.page, scale);
        const factor = r.scale / s.renderScale;
        app.project.panels.forEach((p) => rescalePanel(p, factor));
        w.clearHistory(); // coordinates changed space; older snapshots no longer apply
        s.renderScale = r.scale;
        app.pages = new Map([[s.page, { canvas: r.canvas, imageData: canvasImageData(r.canvas) }]]);
        app.cache.clear();
        showPage(s.page);
        if (r.scale < scale) w.toast(`Resolution limited to ${Math.round(72 * r.scale)} dpi by the browser canvas size.`);
        w.status('');
      } catch (err) {
        console.error(err);
        w.status('');
        w.toast(`Could not render page: ${err.message}`, true);
      }
    }

    async function openProjectZip(file) {
      if (hasCalibration() && !confirm('Opening a project replaces the current one. Continue?')) return;
      w.setMode(null);
      w.status(`Opening ${file.name}…`);
      const { project, pageImages, originalFile } = await readProjectZip(window.JSZip, file);
      const src = project.source || {};
      app.pdfDoc = null;
      const origFile = originalFile ? new File([originalFile.blob], originalFile.name, { type: src.mime || '' }) : null;
      if (origFile && fileKind(origFile) === 'pdf') {
        try {
          app.pdfDoc = await openPdf(origFile);
        } catch (err) {
          console.warn('Could not reopen the original PDF', err);
        }
      }
      const pages = new Map();
      for (const [page, blob] of pageImages) {
        const canvas = await imageToCanvas(blob);
        pages.set(page, { canvas, imageData: canvasImageData(canvas) });
      }
      const page = src.page || 1;
      project.source = {
        fileName: src.fileName || origFile?.name || 'source.png',
        mime: src.mime || null,
        page,
        pageCount: app.pdfDoc ? app.pdfDoc.numPages : Math.max(src.pageCount || 1, ...pages.keys()),
        renderScale: src.renderScale || 1,
        width: src.width || 0,
        height: src.height || 0,
        sha256: src.sha256 || null,
      };
      app.project = project;
      app.pages = pages;
      app.cache.clear();
      app.lastActive.clear();
      if (!app.pages.has(page)) {
        if (app.pdfDoc) await ensurePage(page);
        else if (origFile) {
          const canvas = await imageToCanvas(origFile);
          // An image re-decoded at a different size than recorded: scale the calibration.
          if (src.width && canvas.width !== src.width) project.panels.forEach((p) => rescalePanel(p, canvas.width / src.width));
          app.pages.set(page, { canvas, imageData: canvasImageData(canvas) });
        } else throw new Error('The project zip contains no source image.');
      }
      project.panels.forEach((p) => p.colorbar.ticks.forEach((k) => (k.id = w.newTickId())));
      w.ensurePagePanel(page);
      project.activePanelId = w.pagePanels()[0].id;
      app.originalFile = origFile;
      w.clearHistory();
      showPage(page);
      w.status('');
      if (origFile && !project.source.sha256) sha256Hex(origFile).then((h) => (project.source.sha256 = h));
      const pageCount = new Set(project.panels.map((p) => p.page)).size;
      const counts = Object.values(w.tools)
        .map((t) => [t, project.panels.filter((p) => p.tool === t.kind && !w.isEmptyPanel(p)).length])
        .filter(([, n]) => n)
        .map(([t, n]) => `${n} ${t.label || t.kind} panel${n === 1 ? '' : 's'}`);
      w.toast(`Opened project with ${counts.join(' and ') || 'no calibrated panels'}${pageCount > 1 ? ` on ${pageCount} pages` : ''}.`);
    }

    // File inputs, drag & drop, paste
    for (const id of ['file-input', 'file-input-2']) {
      $(id).addEventListener('change', (e) => {
        openFile(e.target.files[0]);
        e.target.value = '';
      });
    }

    // The whole dashed drop area opens the file dialog; the button inside already does.
    $('dropzone').addEventListener('click', (e) => {
      if (!e.target.closest('label')) $('file-input-2').click();
    });

    // Example files ship with the app. fetch() fails on file://, so say how to run it.
    for (const btn of document.querySelectorAll('[data-example]')) {
      btn.addEventListener('click', async () => {
        try {
          const res = await fetch(btn.dataset.example);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          await openFile(new File([blob], btn.dataset.example.split('/').pop(), { type: btn.dataset.exampleType }));
        } catch (err) {
          w.toast(`Could not load the example (${err.message}). Serve the folder with npm run serve.`, true);
        }
      });
    }

    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      $('drop-overlay').hidden = false;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('drop-overlay').hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      $('drop-overlay').hidden = true;
      openFile(e.dataTransfer?.files?.[0]);
    });
    window.addEventListener('paste', (e) => {
      const target = e.target;
      if (target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) return;
      const blob = item.getAsFile();
      const ext = item.type.split('/')[1] || 'png';
      openFile(new File([blob], `pasted-image.${ext}`, { type: item.type }));
    });

    // Source
    $('zoom-level').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('zoom-level').value = ''; // cancel: empty input reverts on blur
      if (e.key === 'Enter' || e.key === 'Escape') $('zoom-level').blur();
    });
    $('zoom-level').addEventListener('blur', applyZoomInput);
    $('zoom-level').addEventListener('focus', () => $('zoom-level').select());
    $('page-prev').addEventListener('click', () => goToPage(w.currentPage() - 1));
    $('page-next').addEventListener('click', () => goToPage(w.currentPage() + 1));
    $('page-input').addEventListener('change', (e) => goToPage(Number(e.target.value)));
    $('scale-select').addEventListener('change', (e) => changeScale(Number(e.target.value)));

    window.addEventListener('beforeunload', (e) => {
      if (hasCalibration()) e.preventDefault();
    });

    return { openFile, hasCalibration, ensurePage, showZoom, goToPage };
  }

  Object.assign(CM, { setupWorkspaceSource });
})((globalThis.Colormeris ??= {}));
