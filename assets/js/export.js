(function (CM) {
  'use strict';
  const { effectiveLabels, serializeProject, parseProject } = CM;

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
    const lines = [csvLine(['panel', 'row', 'col', 'value', 'r', 'g', 'b', 'deltaE', 'flagged'])];
    for (const { panel, result } of items) {
      if (result.error) continue;
      const rowLabels = effectiveLabels(panel.grid.rowLabels, result.rows, 'R');
      const colLabels = effectiveLabels(panel.grid.colLabels, result.cols, 'C');
      result.cells.forEach((row, r) =>
        row.forEach((c, k) => {
          lines.push(
            csvLine([
              panel.name,
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
                        labels, settings). Coordinates are pixels in source/page-*.png.
  source/               The original uploaded file and the rendered page image that
                        was used for extraction.
  data/<panel>.csv      Extracted values as a matrix (rows x columns).
  data/<panel>_long.csv One line per cell with sampled RGB and color distance (deltaE).

  Load this zip back into Colormeris to review or re-run the extraction.
  `;

  // Build the project zip. `JSZip` is the JSZip constructor; `sourceFile` is the
  // original upload (File/Blob, may be null); `pagePng` is a PNG Blob.
  async function buildProjectZip(JSZip, { project, results, sourceFile, pagePng }) {
    const zip = new JSZip();
    const json = serializeProject(project);
    if (json.source) {
      json.source.originalFile = sourceFile ? `source/${safeFileName(sourceFile.name)}` : null;
      json.source.pageImage = `source/page-${json.source.page || 1}.png`;
    }
    zip.file('project.json', JSON.stringify(json, null, 2));
    zip.file('README.txt', README);
    if (sourceFile) zip.file(json.source.originalFile, sourceFile);
    if (pagePng && json.source) zip.file(json.source.pageImage, pagePng);
    const used = new Set();
    project.panels.forEach((panel, i) => {
      const result = results[i];
      if (!result || result.error) return;
      let base = safeFileName(panel.name);
      while (used.has(base)) base += `_${i + 1}`;
      used.add(base);
      zip.file(`data/${base}.csv`, toWideCsv(panel, result));
      zip.file(`data/${base}_long.csv`, toLongCsv([{ panel, result }]));
    });
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  // Parse a project zip. Returns {project, pageImage: Blob|null,
  // originalFile: {name, blob}|null}.
  async function readProjectZip(JSZip, blob) {
    const zip = await JSZip.loadAsync(blob);
    const entry = zip.file('project.json');
    if (!entry) throw new Error('Invalid project zip: project.json not found.');
    let json;
    try {
      json = JSON.parse(await entry.async('string'));
    } catch {
      throw new Error('Invalid project zip: project.json is not valid JSON.');
    }
    const project = parseProject(json);
    const src = json.source || {};
    const png = src.pageImage && zip.file(src.pageImage);
    const pageImage = png ? await png.async('blob') : null;
    const orig = src.originalFile && zip.file(src.originalFile);
    const originalFile = orig
      ? { name: src.fileName || src.originalFile.split('/').pop(), blob: await orig.async('blob') }
      : null;
    return { project, pageImage, originalFile };
  }

  Object.assign(CM, { formatNumber, csvEscape, toWideCsv, toLongCsv, safeFileName, buildProjectZip, readProjectZip });
})((globalThis.Colormeris ??= {}));
