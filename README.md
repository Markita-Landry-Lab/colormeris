# Colormeris

Colormeris is a set of static web pages that turn colors in scientific figures back into numbers. You load a PDF, PNG or JPG and click to mark the colorbar. The page reads values out of the colors and exports them as CSV. It can also save a project zip, which you can load again later to review or re-run the extraction.

`index.html` is a landing page for two tools that share the same loading, viewer, colorbar calibration and project files:

- **Heatmap** (`heatmap.html`) gives one value per cell of a gridded heatmap.
- **IVIS** (`ivis.html`) measures signal inside regions drawn on in vivo luminescence images.

Everything runs in the browser. Files are never uploaded anywhere.

## Heatmap tool

1. **Open** a PDF, PNG or JPG. You can use *Open file…*, drag and drop, or paste an image from the clipboard. For a PDF, choose the page and the render resolution. The default is 216 dpi.
2. **Panels**: add one panel for each heatmap in the figure. Each panel has its own grid, labels and colorbar. In a PDF, panels belong to the page they were made on. Switching pages keeps them and shows the new page's own panels. The Panels card links to other pages that already have panels.
3. **Grid**: press *Place grid corners* (`G`). Click the outer top-left corner of the heatmap, then the outer bottom-right corner. Colormeris guesses the number of rows and columns from where the colors change and fills them in. Correct them if needed, or press *Detect* to guess again. Then paste the row and column labels. You can drag the corner handles to adjust. Uncheck *Keep rectangular* for skewed or rotated scans.
4. **Colorbar**: press *Place colorbar ends* (`B`) and click both ends of the bar along its middle. Lines within 3° of vertical or horizontal snap straight; hold Alt to turn snapping off. Next, click at least two labelled ticks on the bar and type their values (`T`). Values between ticks are interpolated linearly, and values beyond the outer ticks are extrapolated. If the tick labels are raw numbers on a logarithmic bar, choose *Log₁₀*.
5. **Results**: hover a table cell to find it on the image. Turn on *Reconstruct* to repaint each sampled area with the color the matched value predicts, so you can check the match by eye. Cells whose color is far from every colorbar color (ΔE above the threshold) are outlined in red.
6. **Export**:
   - *Download CSV* saves the matrix (rows × columns).
   - *Long CSV* saves one row per cell, with the sampled RGB and ΔE.
   - *Export project (.zip)* saves everything needed to reload the project.

Navigation: scroll to zoom and drag to pan. Space-drag or middle-drag always pans. `F` fits the image to the view, Esc cancels the current tool, and Ctrl/⌘+Z undoes.

## IVIS tool

1. **Open** the figure as for the heatmap tool. Panels work the same way, including across PDF pages.
2. **Grid** (optional): if the animals are shown in boxes, place the grid. Include the name labels above each row so every animal sits at the same place in its box. Check rows and columns (*Detect* guesses them) and type the box names in reading order, e.g. `B-a11, B-a16, …`. *Remove* drops the grid.
3. **Colorbar**: place the ends and ticks as for heatmaps. For bars with a ×10ⁿ multiplier, type values like `1.4e9`.
4. **Regions**:
   - Pick *Ellipse* (`E`), *Rectangle* (`R`) or *Polygon* (`P`).
   - Drag to draw an ellipse or rectangle; hold Shift for a circle or square.
   - For a polygon, click its points, then click the first point, double-click or press Enter. Backspace removes the last point.
   - With *Copy new regions into every grid box* on, a region drawn inside a box is copied into every box. Copies share their shape: dragging a handle on any copy resizes all of them.
   - Dragging the inside of a copy nudges only that box's copy. Alt-drag moves all copies, and *Reset nudges* puts them back.
   - Regions drawn with the option off, or without a grid, are single regions. They report under the box they sit in.
   - Different shapes can be mixed freely. Select a region to rename or delete it (Del).
5. **Scale** (optional): *Measure scale bar*, click both ends of a known distance, then enter its length in cm or mm. Areas are then also reported in cm² or mm².
6. **Results**: pick a measurement for the table (boxes × regions). *Download CSV* saves every measurement for every region copy. Turn on *Show signal* to tint the pixels counted as signal.

Measurements for each region copy:

| Column | Meaning |
| --- | --- |
| `area_px` | pixels inside the region |
| `signal_px` | pixels with colormap color (not gray) |
| `sum` | total of the colorbar values over the region (gray = 0), like total flux in pixel units |
| `mean` | `sum / area_px`, like average radiance |
| `mean_signal` | `sum / signal_px` |
| `max` | highest value |
| `flagged_px` | colored pixels that match no colorbar color (ΔE above the limit), e.g. colored text. They are still counted as signal with their nearest colorbar value. |
| `area_<unit>2`, `signal_area_<unit>2`, `sum_x_area` | with a scale bar: areas in real units, and `sum` × pixel area |

**Background**: a pixel whose CIELAB chroma is at or below the *gray* threshold is the photograph, i.e. no signal. The default is 20, which removes the JPEG color noise seen in published IVIS figures while keeping the dimmest overlay colors. Adjust it under *Signal settings* and check with *Show signal*.

## How heatmap values are computed

- **Cell color**: each channel's median over the central part of the cell. The *Sampled area* setting controls how much, 50% by default. Using the center avoids grid lines, anti-aliased edges and JPEG noise.
- **Colorbar**: sampled at 256 evenly spaced points from one end to the other. Each point averages ±*half-width* pixels across the bar.
- **Matching**: the cell color is converted to CIELAB and matched to the nearest colorbar sample by CIEDE2000 (CIE76 is optional). The match is refined between neighbouring samples. That position along the bar is then converted to a value using the ticks.

## Project zip layout

```
project.json            kind (heatmap or ivis), and per panel: page, grid, colorbar,
                        labels, settings, and for IVIS the regions and scale bar
README.txt
source/<original file>  the uploaded PDF/image
source/page-<n>.png     the rendered image of each page that has panels
data/<panel>.csv        heatmap: matrix of values
data/<panel>_long.csv   heatmap: per-cell values with page, RGB and ΔE
data/<panel>_rois.csv   IVIS: measurements per region copy
```

Each panel records its `page`. Its coordinates are pixels in that page's `source/page-<n>.png`. Regions copied into every box are stored relative to a box, where a box spans 0–1 in each direction, with per-box nudges. Each tool opens only its own kind of project and points to the other tool otherwise. Zips made before the IVIS tool existed open as heatmap projects.

## Development

There is no build step. The pages are plain HTML, CSS and classic scripts that register on a shared `Colormeris` namespace. Each tool page loads them in order. pdf.js 6.3.289 and JSZip 3.10.2 are vendored in `assets/vendor/`.

You can open `index.html` directly from disk or serve the folder:

```bash
npm run serve   # python3 -m http.server 8000, then open http://localhost:8000
npm test        # unit tests (node:test, no dependencies)
```

Opened from disk (`file://`), browsers block module files, fetches and workers. There, pdf.js is loaded from `assets/vendor/pdfjs/pdf.embed.js` and runs on the main thread. PDFs that need extra data (non-embedded fonts, CJK character maps, JPEG 2000 images) render best when served over HTTP. After updating the vendored pdf.js, regenerate the embed with `node scripts/embed-pdfjs.mjs`.

To deploy, publish the repository root with GitHub Pages or any static host. `.nojekyll` is already included.

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
| `assets/js/roi.js` | region shapes, copies into grid boxes, pixel scan |
| `assets/js/quantify.js` | background/signal classification and region statistics |
| `assets/js/workspace.js` | shared tool shell: loading, pages, panels, grid, colorbar, undo, zip |
| `assets/js/heatmap.js` | heatmap tool |
| `assets/js/ivis.js` | IVIS tool |
