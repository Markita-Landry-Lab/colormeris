(function (CM) {
  'use strict';
  const { comboFromEvent, findHotkey } = CM;

  // View tools (zoom, crosshair, overlay) and keyboard shortcuts.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (setMode, undo, goToPage, ...).
  function setupWorkspaceHotkeys(w) {
    const { $, app } = w;

    $('mode-done').addEventListener('click', () => w.setMode(null));
    $('zoom-in').addEventListener('click', () => w.viewer.zoomBy(1.25));
    $('zoom-out').addEventListener('click', () => w.viewer.zoomBy(0.8));
    $('zoom-fit').addEventListener('click', () => w.viewer.fit());
    // The crosshair choice is a per-browser convenience; storage may be unavailable.
    function setCrosshair(on) {
      w.viewer.crosshair = on;
      w.setPressed($('toggle-crosshair'), on);
      try {
        localStorage.setItem('colormeris.crosshair', on ? '1' : '0');
      } catch {}
      w.viewer.requestDraw();
    }
    try {
      if (localStorage.getItem('colormeris.crosshair') === '1') setCrosshair(true);
    } catch {}
    $('toggle-crosshair').addEventListener('click', () => setCrosshair(!w.viewer.crosshair));
    $('toggle-overlay').addEventListener('click', () => {
      app.showOverlay = !app.showOverlay;
      w.setPressed($('toggle-overlay'), app.showOverlay);
      w.viewer.requestDraw();
    });

    // Keyboard shortcuts. The keys come from the Settings dialog (ws.settings.hotkeys);
    // Escape always cancels, and the ROI tool handles its polygon keys in onKey.
    const hotkeys = {};
    function addHotkey(id, run, { always = false, tool: only = null } = {}) {
      hotkeys[id] = { run, always, tool: only };
    }
    addHotkey('undo', w.undo, { always: true });
    addHotkey('redo', w.redo, { always: true });
    addHotkey('grid', () => w.setMode(app.mode?.type === 'grid' ? null : 'grid'));
    addHotkey('colorbar', () => $('bar-place').click());
    addHotkey('ticks', () => w.setMode(app.mode?.type === 'tick' ? null : 'tick'));
    addHotkey('fit', () => w.viewer.fit());
    addHotkey('zoomIn', () => w.viewer.zoomBy(1.25));
    addHotkey('zoomOut', () => w.viewer.zoomBy(0.8));
    addHotkey('crosshair', () => setCrosshair(!w.viewer.crosshair));
    // Pages flip only when there are several (the page controls are shown).
    addHotkey('prevPage', () => !$('pdf-controls').hidden && w.goToPage(w.currentPage() - 1));
    addHotkey('nextPage', () => !$('pdf-controls').hidden && w.goToPage(w.currentPage() + 1));

    window.addEventListener('keydown', (e) => {
      // A modal (the Settings dialog) takes the keyboard.
      if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
      if (w.tool().onKey?.(e)) return;
      const t = e.target;
      const typing = t instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && t.type !== 'checkbox' && t.type !== 'range';
      if (e.key === 'Escape') {
        if (typing) t.blur();
        else w.setMode(null);
        return;
      }
      if (typing) return;
      const h = hotkeys[findHotkey(w.ws.settings.hotkeys, comboFromEvent(e))];
      if (!h || (!h.always && !app.sourceCanvas) || (h.tool && h.tool !== w.tool().kind)) return;
      e.preventDefault();
      h.run();
    });

    return { addHotkey };
  }

  Object.assign(CM, { setupWorkspaceHotkeys });
})((globalThis.Colormeris ??= {}));
