(function (CM) {
  'use strict';
  const { createPanel } = CM;

  // Panels: the Panels card (chips, name, add and delete), links to other
  // pages with panels, and the rule that every page shown has a panel.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (setMode, changed, goToPage, ...).
  function setupWorkspacePanels(w) {
    const { $, app } = w;

    function renderPanels(active) {
      const list = $('panel-list');
      const multiPage = (app.project.source?.pageCount || 1) > 1;
      $('panel-page-note').textContent = multiPage ? `on page ${w.currentPage()}` : '';
      list.replaceChildren(
        ...w.pagePanels().map((p) => {
          const li = document.createElement('li');
          const btn = document.createElement('button');
          btn.className = 'chip';
          btn.setAttribute('aria-pressed', String(p === active));
          const dot = document.createElement('span');
          const problem = w.toolFor(p).panelProblem(p);
          const review = !problem && w.ws.reviewStatus?.(p);
          dot.className = `status-dot${problem ? '' : review === 'rejected' ? ' rejected' : ' done'}`;
          btn.append(dot, Object.assign(document.createElement('span'), { className: 'chip-label', textContent: p.name || '(unnamed)' }));
          btn.title = problem || (review === 'rejected' ? `Rejected in review${p.review.note ? `: ${p.review.note}` : ''}` : review === 'accepted' ? 'Calibrated and accepted' : 'Calibrated');
          btn.addEventListener('click', () => {
            if (p.id === app.project.activePanelId) return;
            w.setMode(null);
            app.project.activePanelId = p.id;
            app.tableCell = null;
            w.changed();
          });
          li.append(btn);
          return li;
        }),
      );
      w.setValue($('panel-name'), active.name);
      $('panel-delete').textContent = w.pagePanels().length < 2 ? 'Clear' : 'Delete';
      renderOtherPages();
    }

    // Links to other pages that already have panels.
    function renderOtherPages() {
      const byPage = new Map();
      for (const p of app.project.panels) {
        if (p.page === w.currentPage()) continue;
        if (!byPage.has(p.page)) byPage.set(p.page, []);
        byPage.get(p.page).push(p.name || '(unnamed)');
      }
      const box = $('other-pages');
      box.hidden = byPage.size === 0;
      const items = [...byPage.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, names]) => {
          const btn = document.createElement('button');
          btn.className = 'chip';
          btn.append(Object.assign(document.createElement('span'), { className: 'chip-label', textContent: `Page ${page}: ${names.join(', ')}` }));
          btn.title = `Go to page ${page}`;
          btn.addEventListener('click', () => w.goToPage(page));
          return btn;
        });
      box.replaceChildren(Object.assign(document.createElement('span'), { className: 'hint', textContent: 'Other pages:' }), ...items);
    }

    function isEmptyPanel(p) {
      return !p.grid.corners && !p.colorbar.start && !p.grid.rowLabels.length && !p.grid.colLabels.length && !p.grid.boxLabels.length && !p.rois.length && !p.map.x.ticks.length && !p.map.y.ticks.length && !p.map.profiles.length;
    }

    // Every page shown gets at least one panel of the active tool to calibrate.
    function ensurePagePanel(page, settings) {
      if (app.project.panels.some((p) => p.page === page && p.tool === w.tool().kind)) return;
      const panel = createPanel(nextPanelName(), page, w.tool().kind);
      settings ??= app.project.panels.find((p) => p.tool === w.tool().kind)?.settings;
      Object.assign(panel.settings, settings || w.panelDefaults(w.tool().kind));
      app.project.panels.push(panel);
    }

    function nextPanelName() {
      const used = new Set(app.project.panels.map((p) => p.name));
      let n = app.project.panels.filter((p) => p.tool === w.tool().kind).length + 1;
      while (used.has(`Panel ${n}`)) n++;
      return `Panel ${n}`;
    }

    $('panel-add').addEventListener('click', () => {
      w.pushHistory();
      const prev = w.activePanel();
      const panel = createPanel(nextPanelName(), w.currentPage(), w.tool().kind);
      panel.settings = { ...prev.settings };
      app.project.panels.push(panel);
      app.project.activePanelId = panel.id;
      app.tableCell = null;
      w.setMode(null);
      w.changed();
      $('panel-name').focus();
      $('panel-name').select();
    });
    // Delete a panel. Every page keeps one panel, so deleting the last one on
    // its page swaps in an empty panel instead. Undo restores it.
    function removePanel(panel) {
      const here = app.project.panels.filter((p) => p.page === panel.page && p.tool === panel.tool);
      const last = here.length < 2;
      w.pushHistory();
      const i = here.indexOf(panel);
      const at = app.project.panels.indexOf(panel);
      if (last) {
        const blank = createPanel(panel.name, panel.page, panel.tool);
        blank.settings = { ...panel.settings };
        app.project.panels.splice(at, 1, blank);
        if (app.project.activePanelId === panel.id) app.project.activePanelId = blank.id;
      } else {
        app.project.panels.splice(at, 1);
        if (app.project.activePanelId === panel.id) app.project.activePanelId = here[i === 0 ? 1 : i - 1].id;
      }
      w.setMode(null);
      w.changed();
      return { cleared: last };
    }
    $('panel-delete').addEventListener('click', () => {
      const panel = w.activePanel();
      const last = w.pagePanels().length < 2;
      if (!confirm(last ? `Clear panel "${panel.name}"? A page always keeps one panel.` : `Delete panel "${panel.name}"?`)) return;
      removePanel(panel);
    });
    w.bindText('panel-name', (p, v) => (p.name = v));
    $('panel-name').addEventListener('input', () => renderPanels(w.activePanel()));

    return { renderPanels, removePanel, isEmptyPanel, ensurePagePanel };
  }

  Object.assign(CM, { setupWorkspacePanels });
})((globalThis.Colormeris ??= {}));
