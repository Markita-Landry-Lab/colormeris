(function (CM) {
  'use strict';
  const { effectiveLabels, boxLabel, serializeProject, parseProject } = CM;

  // CSV formatting and project zip packaging.


  function formatNumber(v) {
    if (!Number.isFinite(v)) return '';
    return String(Number(v.toPrecision(6)));
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const csvLine = (cells) => cells.map(csvEscape).join(',');

  // Matrix layout: first column row labels, header row column labels.
  function toWideCsv(panel, result) {
    const rowLabels = effectiveLabels(panel.grid.rowLabels, result.rows, 'R');
    const colLabels = effectiveLabels(panel.grid.colLabels, result.cols, 'C');
    const lines = [csvLine(['row\\col', ...colLabels])];
    result.cells.forEach((row, r) => {
      lines.push(csvLine([rowLabels[r], ...row.map((c) => formatNumber(c.value))]));
    });
    return lines.join('\n') + '\n';
  }

  // Tidy layout with diagnostics, one line per cell. `items` is [{panel, result}].
  function toLongCsv(items) {
    const lines = [csvLine(['panel', 'page', 'row', 'col', 'value', 'r', 'g', 'b', 'deltaE', 'flagged'])];
    for (const { panel, result } of items) {
      if (result.error) continue;
      const rowLabels = effectiveLabels(panel.grid.rowLabels, result.rows, 'R');
      const colLabels = effectiveLabels(panel.grid.colLabels, result.cols, 'C');
      result.cells.forEach((row, r) =>
        row.forEach((c, k) => {
          lines.push(
            csvLine([
              panel.name,
              panel.page,
              rowLabels[r],
              colLabels[k],
              formatNumber(c.value),
              ...c.rgb.map((x) => Math.round(x)),
              c.deltaE.toFixed(2),
              c.flagged ? 1 : 0,
            ]),
          );
        }),
      );
    }
    return lines.join('\n') + '\n';
  }

  function safeFileName(name) {
    const s = String(name).trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'untitled';
  }

  const README = `Colormeris project archive

project.json          Calibration metadata (grid corners, colorbar line and ticks,
                      labels, settings, page and review of each panel).
                      Coordinates are pixels in the panel's source/page-<n>.png.
source/               The original uploaded file and the rendered image of each
                      page that has panels.
data/                 Extracted data as CSV, one or more files per panel.
agent/                actions.json and decisions.json: what the agent API and the
                      heatmap agent changed and decided (with confidences).

Load this zip back into Colormeris to review or re-run the extraction.
`;

  const pageImagePath = (page) => `source/page-${page}.png`;

  // Region statistics, one line per region copy. `items` is [{panel, result}]
  // with results from quantifyPanel.
  function roiCsv(items) {
    const unit = items.find((it) => it.result.unit)?.result.unit;
    const head = ['panel', 'page', 'box', 'row', 'col', 'roi', 'shape', 'area_px', 'signal_px', 'flagged_px', 'sum', 'mean', 'mean_signal', 'max'];
    if (unit) head.push(`area_${unit}2`, `signal_area_${unit}2`, 'sum_x_area');
    const lines = [csvLine(head)];
    for (const { panel, result } of items) {
      if (result.error) continue;
      for (const r of result.rows) {
        const s = r.stats;
        const inBox = r.row !== null;
        const line = [
          panel.name,
          panel.page,
          inBox ? boxLabel(panel.grid, r.row, r.col) : '',
          inBox ? r.row + 1 : '',
          inBox ? r.col + 1 : '',
          r.roi.name,
          r.roi.shape,
          s.areaPx,
          s.signalPx,
          s.flaggedPx,
          formatNumber(s.sum),
          formatNumber(s.mean),
          formatNumber(s.meanSignal),
          formatNumber(s.max),
        ];
        if (unit) line.push(...(s.area !== undefined ? [formatNumber(s.area), formatNumber(s.signalArea), formatNumber(s.sumArea)] : ['', '', '']));
        lines.push(csvLine(line));
      }
    }
    return lines.join('\n') + '\n';
  }

  // Unique, file-system safe base names for panels, in panel order.
  function panelFileBases(panels) {
    const used = new Set();
    return panels.map((panel, i) => {
      let base = safeFileName(panel.name);
      while (used.has(base)) base += `_${i + 1}`;
      used.add(base);
      return base;
    });
  }

  // Heatmap data files for one panel: the matrix and the long format.
  function heatmapPanelFiles(panel, result, base) {
    if (!result || result.error) return [];
    return [
      { path: `data/${base}.csv`, content: toWideCsv(panel, result) },
      { path: `data/${base}_long.csv`, content: toLongCsv([{ panel, result }]) },
    ];
  }

  // Build the project zip. `JSZip` is the JSZip constructor; `sourceFile` is the
  // original upload (File/Blob, may be null); `pagePngs` maps page number to a
  // PNG Blob of that rendered page; `files` are extra [{path, content}] entries
  // such as data CSVs.
  async function buildProjectZip(JSZip, { project, sourceFile, pagePngs, files = [] }) {
    const zip = new JSZip();
    const json = serializeProject(project);
    if (json.source) {
      json.source.originalFile = sourceFile ? `source/${safeFileName(sourceFile.name)}` : null;
      json.source.pageImages = {};
      for (const [page, png] of pagePngs) {
        json.source.pageImages[page] = pageImagePath(page);
        zip.file(pageImagePath(page), png);
      }
      // Readers of the first format only know the image of the current page.
      json.source.pageImage = json.source.pageImages[json.source.page || 1] || null;
    }
    zip.file('project.json', JSON.stringify(json, null, 2));
    zip.file('README.txt', README);
    if (sourceFile) zip.file(json.source.originalFile, sourceFile);
    for (const f of files) zip.file(f.path, f.content);
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  // Parse a project zip. Returns {project, pageImages: Map(page → Blob),
  // originalFile: {name, blob}|null}.
  async function readProjectZip(JSZip, blob) {
    const zip = await JSZip.loadAsync(blob);
    const entry = zip.file('project.json');
    if (!entry && zip.file('settings.json')) throw new Error('this is a settings zip. Import it under Settings → Import and export.');
    if (!entry) throw new Error('Invalid project zip: project.json not found.');
    let json;
    try {
      json = JSON.parse(await entry.async('string'));
    } catch {
      throw new Error('Invalid project zip: project.json is not valid JSON.');
    }
    const project = parseProject(json);
    const src = json.source || {};
    const paths = src.pageImages && typeof src.pageImages === 'object' ? { ...src.pageImages } : {};
    if (src.pageImage && !Object.values(paths).includes(src.pageImage)) paths[src.page || 1] = src.pageImage;
    const pageImages = new Map();
    for (const [page, path] of Object.entries(paths)) {
      const file = typeof path === 'string' && zip.file(path);
      if (file) pageImages.set(Number(page), await file.async('blob'));
    }
    const orig = src.originalFile && zip.file(src.originalFile);
    const originalFile = orig
      ? { name: src.fileName || src.originalFile.split('/').pop(), blob: await orig.async('blob') }
      : null;
    return { project, pageImages, originalFile };
  }

  Object.assign(CM, { formatNumber, csvEscape, csvLine, toWideCsv, toLongCsv, roiCsv, safeFileName, panelFileBases, heatmapPanelFiles, buildProjectZip, readProjectZip });
})((globalThis.Colormeris ??= {}));
