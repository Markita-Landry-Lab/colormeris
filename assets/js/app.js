(function (CM) {
  'use strict';
  const { createWorkspace, setupHeatmapTool, setupIvisTool, createAgentApi, setupAgentPanel } = CM;

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
  // LLM agent with a vision reviewer for heatmaps (agent-panel.js, agent-runner.js).
  setupAgentPanel(ws, window.colormeris);
})((globalThis.Colormeris ??= {}));
