(function (CM) {
  'use strict';
  const { createWorkspace, setupHeatmapTool, setupIvisTool, createAgentApi } = CM;

  // One page, two tools sharing one workspace: the loaded file, pages and
  // project (with every tool's panels) persist when switching tools. The tool
  // follows the URL hash (#heatmap or #ivis) so links and reloads keep it.

  const ws = createWorkspace();
  setupHeatmapTool(ws);
  setupIvisTool(ws);

  const toolFromHash = () => (location.hash === '#ivis' ? 'ivis' : 'heatmap');
  ws.setTool(toolFromHash());
  window.addEventListener('hashchange', () => ws.setTool(toolFromHash()));
  ws.render();

  // Typed API for software agents (agent.js).
  window.colormeris = createAgentApi(ws);
})((globalThis.Colormeris ??= {}));
