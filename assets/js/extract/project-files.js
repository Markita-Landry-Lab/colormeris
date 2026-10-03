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

  // ---------------------------------------------------------------- map CSVs
  // Results come from extractMap (map/field.js, loaded after this file, so its
  // flag constants are looked up on CM at call time).

  // Column headers of a map: axis names when calibrated, else pixel offsets.
  const mapAxisNames = (result) => [result.xAxis ? 'x' : 'x_px', result.yAxis ? 'y' : 'y_px'];

  // Matrix layout: header row of x at bin centres, first column y at bin centres,
  // rows top to bottom as on the page.
  function mapMatrixCsv(panel, result) {
    const [xn, yn] = mapAxisNames(result);
    const lines = [csvLine([`${yn}\\${xn}`, ...result.xs.map(formatNumber)])];
    for (let r = 0; r < result.rows; r++) {
      const row = [formatNumber(result.ys[r])];
      for (let c = 0; c < result.cols; c++) row.push(formatNumber(result.values[r * result.cols + c]));
      lines.push(row.join(','));
    }
    return lines.join('\n') + '\n';
  }

  // Tidy layout with diagnostics, one line per bin. `items` is [{panel, result}].
  function mapLongCsv(items) {
    const [xn, yn] = items.length && !items[0].result.error ? mapAxisNames(items[0].result) : ['x', 'y'];
    const lines = [csvLine(['panel', 'page', 'row', 'col', xn, yn, 'value', 'deltaE', 'flagged', 'clipped'])];
    for (const { panel, result } of items) {
      if (result.error) continue;
      const name = csvEscape(panel.name);
      for (let r = 0; r < result.rows; r++) {
        for (let c = 0; c < result.cols; c++) {
          const i = r * result.cols + c;
          const f = result.flags[i];
          const clip = f & CM.FLAG_LOW ? 'low' : f & CM.FLAG_HIGH ? 'high' : '';
          lines.push(
            [name, panel.page, r + 1, c + 1, formatNumber(result.xs[c]), formatNumber(result.ys[r]), formatNumber(result.values[i]), result.deltaE[i].toFixed(2), f & CM.FLAG_DELTA_E ? 1 : 0, clip].join(','),
          );
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  // One line per profile sample (from sampleProfile). With norm = {mode,
  // divisor} ('max' | 'mean', see profileDivisor), a value_per_<mode> column
  // follows the value.
  function profileCsv(samples, norm = null) {
    const head = ['d_px', 'x', 'y', 'page_x', 'page_y', 'value', ...(norm ? [`value_per_${norm.mode}`] : []), 'deltaE', 'flagged', 'clipped'];
    const lines = [csvLine(head)];
    for (const s of samples) {
      const scaled = norm ? [formatNumber(s.value / norm.divisor)] : [];
      lines.push(
        [s.d.toFixed(2), formatNumber(s.x), formatNumber(s.y), s.px.toFixed(2), s.py.toFixed(2), formatNumber(s.value), ...scaled, s.deltaE.toFixed(2), s.flagged ? 1 : 0, s.clipped ? 1 : 0].join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  // Several profiles in one long table with a profile column: [{name,
  // samples, norm}] (norm as in profileCsv, the same mode for all).
  function profilesCsv(entries) {
    const lines = [`profile,${profileCsv([], entries[0]?.norm).trim()}`];
    for (const { name, samples, norm } of entries) {
      for (const line of profileCsv(samples, norm).trim().split('\n').slice(1)) lines.push(`${csvEscape(name)},${line}`);
    }
    return lines.join('\n') + '\n';
  }

  // Map data files for one panel: the matrix, the long format and each profile.
  function mapPanelFiles(panel, result, base) {
    if (!result) return [];
    const files = [];
    if (!result.error) {
      files.push({ path: `data/${base}_map.csv`, content: mapMatrixCsv(panel, result) });
      files.push({ path: `data/${base}_map_long.csv`, content: mapLongCsv([{ panel, result }]) });
    }
    const used = new Set();
    for (const l of panel.map.profiles) {
      const samples = result.profiles?.[l.id];
      if (!Array.isArray(samples)) continue;
      let name = safeFileName(l.name);
      while (used.has(name)) name += '_';
      used.add(name);
      files.push({ path: `data/${base}_profile_${name}.csv`, content: profileCsv(samples) });
    }
    return files;
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

  Object.assign(CM, { formatNumber, csvEscape, csvLine, toWideCsv, toLongCsv, roiCsv, mapMatrixCsv, mapLongCsv, profileCsv, profilesCsv, mapPanelFiles, safeFileName, panelFileBases, heatmapPanelFiles, buildProjectZip, readProjectZip });
})((globalThis.Colormeris ??= {}));
