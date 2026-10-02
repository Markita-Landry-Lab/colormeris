(function (CM) {
  'use strict';
  const { createWorkspace, setupHeatmapTool, setupRoiTool, createAgentApi, setupAgentPanel, setupSettings } = CM;

  // One page, two tools sharing one workspace: the loaded file, pages and
  // project (with every tool's panels) persist when switching tools. The tool
  // follows the URL hash (#heatmap or #roi) so links and reloads keep it.

  // If anything here fails (a script that did not load, a stale cached file),
  // say so on the page. Otherwise the example buttons work but no tool exists.
  function showStartupError(err) {
    console.error(err);
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;padding:10px 14px;background:#b3261e;color:#fff;font:14px system-ui,sans-serif';
    el.textContent = `Colormeris could not start (${err?.message || err}). Try a hard refresh (Ctrl+Shift+R). If it persists, report the first error in the browser console.`;
    document.body.prepend(el);
  }

  try {
    const ws = createWorkspace();
    // Settings dialog (settings-dialog.js): loads the stored settings into ws.settings.
    const settings = setupSettings(ws);
    setupHeatmapTool(ws);
    setupRoiTool(ws);

    const toolFromHash = () => (location.hash === '#roi' ? 'roi' : 'heatmap');
    ws.setTool(toolFromHash());
    window.addEventListener('hashchange', () => ws.setTool(toolFromHash()));
    ws.render();

    // Typed API for software agents (agent/api.js).
    window.colormeris = createAgentApi(ws);
    // LLM agent with a vision reviewer for heatmaps (agent/agent-card.js, agent/runner.js).
    setupAgentPanel(ws, window.colormeris, settings);
  } catch (err) {
    showStartupError(err);
  }
})((globalThis.Colormeris ??= {}));
