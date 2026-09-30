# Colormeris

Colormeris is a static web page for pulling numbers out of heatmap figures that have a regular grid. You load a PDF, PNG or JPG. Then you click to mark where the heatmap grid and its colorbar are. The page matches each cell's color against the colorbar and exports the values as CSV. It can also save a project zip, which you can load again later to review or re-run the extraction.

Everything runs in the browser. Files are never uploaded anywhere.

## Usage

1. **Open** a PDF, PNG or JPG. You can use *Open file…*, drag and drop, or paste an image from the clipboard. For a PDF, choose the page and the render resolution. The default is 216 dpi.
2. **Panels**: add one panel for each heatmap in the figure. Each panel has its own grid, labels and colorbar.
3. **Grid**: press *Place grid corners* (`G`). Click the outer top-left corner of the heatmap, then the outer bottom-right corner. Set the number of rows and columns and paste the row and column labels. You can drag the corner handles to adjust. Uncheck *Keep rectangular* for skewed or rotated scans.
4. **Colorbar**: press *Place colorbar ends* (`B`) and click both ends of the bar along its middle. Lines within 3° of vertical or horizontal snap straight; hold Alt to turn snapping off. Next, click at least two labelled ticks on the bar and type their values (`T`). Values between ticks are interpolated linearly, and values beyond the outer ticks are extrapolated. If the tick labels are raw numbers on a logarithmic bar, choose *Log₁₀*.
5. **Results**: hover a table cell to find it on the image. Turn on *Reconstruct* to repaint each sampled area with the color the matched value predicts, so you can check the match by eye. Cells whose color is far from every colorbar color (ΔE above the threshold) are outlined in red.
6. **Export**:
   - *Download CSV* saves the matrix (rows × columns).
   - *Long CSV* saves one row per cell, with the sampled RGB and ΔE.
   - *Export project (.zip)* saves everything needed to reload the project.

Navigation: scroll to zoom and drag to pan. Space-drag or middle-drag always pans. `F` fits the image to the view, Esc cancels the current tool, and Ctrl/⌘+Z undoes.

## How values are computed

- **Cell color**: each channel's median over the central part of the cell. The *Sampled area* setting controls how much, 50% by default. Using the center avoids grid lines, anti-aliased edges and JPEG noise.
- **Colorbar**: sampled at 256 evenly spaced points from one end to the other. Each point averages ±*half-width* pixels across the bar.
- **Matching**: the cell color is converted to CIELAB and matched to the nearest colorbar sample by CIEDE2000 (CIE76 is optional). The match is refined between neighbouring samples. That position along the bar is then converted to a value using the ticks.

## Project zip layout

```
project.json            calibration: grid corners, colorbar line and ticks, labels, settings
README.txt
source/<original file>  the uploaded PDF/image
source/page-<n>.png     the rendered page that coordinates refer to
data/<panel>.csv        matrix of values
data/<panel>_long.csv   per-cell values with RGB and ΔE
```

Coordinates in `project.json` are pixels in `source/page-<n>.png`.

## Development

There is no build step. The page is plain HTML, CSS and ES modules. pdf.js 6.3.289 and JSZip 3.10.2 are vendored in `assets/vendor/`.

```bash
npm run serve   # python3 -m http.server 8000, then open http://localhost:8000
npm test        # unit tests (node:test, no dependencies)
```

A server is needed because ES modules and the pdf.js worker don't load from `file://`. To deploy, publish the repository root with GitHub Pages or any static host. `.nojekyll` is already included.

| File | Purpose |
| --- | --- |
| `assets/js/color.js` | sRGB ↔ CIELAB, ΔE76 and ΔE2000 |
| `assets/js/grid.js` | 4-corner (bilinear) grid geometry and median cell sampling |
| `assets/js/colormap.js` | colorbar sampling, tick interpolation, color → position |
| `assets/js/extract.js` | per-panel extraction |
| `assets/js/state.js` | project model and `project.json` (de)serialization |
| `assets/js/export.js` | CSV and zip |
| `assets/js/loader.js` | PDF/image loading |
| `assets/js/viewer.js` | zoom/pan canvas, handles, loupe |
| `assets/js/main.js` | UI wiring |
