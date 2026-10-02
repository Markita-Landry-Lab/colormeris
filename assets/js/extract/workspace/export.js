(function (CM) {
  'use strict';
  const { canvasToPngBlob, buildProjectZip, safeFileName, panelFileBases } = CM;

  // Downloads: CSV names and the project zip with every tool's data files.
  //
  // w is the workspace's private context (workspace.js). Other modules'
  // functions are called through it at call time (ensurePage, resultFor, ...).
  function setupWorkspaceExport(w) {
    const { $, app } = w;

    function download(blob, name) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }

    function csvName(panel, suffix = '') {
      return `${safeFileName(app.project.name)}_${safeFileName(panel.name)}${suffix}.csv`;
    }

    async function exportZip() {
      if (!window.JSZip) {
        w.toast('Zip library failed to load.', true);
        return;
      }
      try {
        w.status('Building zip…');
        // Every page that has panels (plus the one on screen) goes into the zip.
        const pages = [...new Set([w.currentPage(), ...app.project.panels.map((p) => p.page)])].sort((a, b) => a - b);
        const pagePngs = new Map();
        for (const page of pages) {
          const entry = await w.ensurePage(page);
          if (entry) pagePngs.set(page, await canvasToPngBlob(entry.canvas));
        }
        const results = app.project.panels.map(w.resultFor);
        const incomplete = results.filter((r) => r.error).length;
        // Data files of every tool, with file names unique across all panels.
        const bases = panelFileBases(app.project.panels);
        const files = Object.values(w.tools).flatMap((t) => {
          const idx = app.project.panels.map((p, i) => (p.tool === t.kind ? i : -1)).filter((i) => i >= 0);
          if (!idx.length || !t.panelFiles) return [];
          return t.panelFiles(idx.map((i) => app.project.panels[i]), idx.map((i) => results[i]), idx.map((i) => bases[i]));
        });
        for (const extra of w.ws.zipExtras) files.push(...extra());
        const blob = await buildProjectZip(window.JSZip, {
          project: app.project,
          sourceFile: app.originalFile,
          pagePngs,
          files,
        });
        download(blob, `colormeris-${safeFileName(app.project.name)}.zip`);
        w.status('');
        if (incomplete) w.toast(`${incomplete} panel${incomplete === 1 ? ' is' : 's are'} not fully calibrated; saved calibration without data.`);
      } catch (err) {
        console.error(err);
        w.status('');
        w.toast(`Export failed: ${err.message}`, true);
      }
    }

    $('btn-export-zip').addEventListener('click', exportZip);

    return { download, csvName, exportZip };
  }

  Object.assign(CM, { setupWorkspaceExport });
})((globalThis.Colormeris ??= {}));
