# Colormeris

Colormeris is a set of static web pages that turn colors in scientific figures back into numbers. You load a PDF, PNG or JPG and click to mark the colorbar. The page reads values out of the colors and exports them as CSV. It can also save a project zip, which you can load again later to review or re-run the extraction.

There are three pages:

- `index.html` is the landing page.
- `extract.html` turns figure colors into numbers. It has three tools, which share the loaded file, viewer, colorbar calibration and project:
  - **Heatmap** (`extract.html#heatmap`) gives one value per cell of a gridded heatmap.
  - **ROI** (`extract.html#roi`) measures signal inside regions of interest drawn on an image, such as an IVIS luminescence image.
  - **Map** (`extract.html#map`) reads near-continuous images, such as spectroscopy maps with many bins or fluorescence images, as a dense value matrix with axis coordinates, plus line profiles.
- `colormaps.html` browses, compares and identifies colormaps (see [Colormaps](#colormaps)).

In `extract.html`, switch tools at any time with the Heatmap | ROI | Map control in the top bar. The file, the PDF page and each tool's panels stay. One project zip holds the work of every tool.

Everything runs in the browser. Files are never uploaded anywhere, except when you run the heatmap agent: it sends page images and extracted values to OpenRouter and the models you pick.

## Heatmap tool

1. **Open** a PDF, PNG or JPG. You can use *Open file…*, drag and drop, or paste an image from the clipboard. For a PDF, choose the page and the render resolution. The default is 216 dpi.
2. **Panels**: add one panel for each heatmap in the figure. Each panel has its own grid, labels and colorbar. In a PDF, panels belong to the page they were made on. Switching pages keeps them and shows the new page's own panels. The Panels card links to other pages that already have panels.
3. **Grid**: press *Place grid corners* (`G`). Click the outer top-left corner of the heatmap, then the outer bottom-right corner. Colormeris guesses the number of rows and columns from where the colors change and fills them in. Correct them if needed, or press *Detect* to guess again. Then paste the row and column labels. You can drag the corner handles to adjust. Uncheck *Keep rectangular* for skewed or rotated scans.
4. **Colorbar**: press *Place colorbar ends* (`B`) and click both ends of the bar along its middle. Lines within 3° of vertical or horizontal snap straight; hold Alt to turn snapping off. Next, click at least two labelled ticks on the bar and type their values (`T`). Values between ticks are interpolated linearly, and values beyond the outer ticks are extrapolated. If the tick labels are raw numbers on a logarithmic bar, choose *Log₁₀*. Drag an end handle to adjust the bar: under *When dragging an end, ticks*, choose whether the ticks move with the bar (keeping their proportions) or stay in place on their printed marks. Drag the line itself to move the whole calibration, ticks included. To place a tick exactly, type its position in % along the bar (0 at the start, 100 at the end) in the tick table. Under the sampled strip, the card suggests the Matplotlib, CMasher, Crameri, cmocean, colorcet, seaborn, CarbonPlan, NCL, SciVisColor, CARTOColors, MATLAB or R packages colormap the bar matches (for example `jet` or `viridis_r`, with its ΔE2000 score and a link to the colormap viewer). With two ticks the direction follows the values; this works in the ROI tool too.
   **Known colormap.** When the figure's colorbar is missing, tiny or badly compressed, set *Colors* to *Known colormap* and pick the map with the same search field as the colormap viewer (any of the 1063 maps; type `name_r` or tick *Reversed* for the reversed map). Two ticks appear at 0% and 100% of the colormap: type the values at its ends. *Type a tick* adds more by value and position in % along the colormap, and every tick's position can be edited in the table. Placing the colorbar ends is then optional; if you do, ticks clicked on the bar count too. When a figure's bar matches a known map, the suggestion under the strip has *Use its colors* to switch to that map's exact colors. This works the same in the ROI and Map tools.
5. **Results**: hover a table cell to find it on the image. Turn on *Reconstruct* to repaint each sampled area with the color the matched value predicts, so you can check the match by eye. Cells whose color is far from every colorbar color (ΔE above the threshold) are outlined in red.
6. **Export**:
   - *Download CSV* saves the matrix (rows × columns).
   - *Long CSV* saves one row per cell, with the sampled RGB and ΔE.
   - *Export project (.zip)* saves everything needed to reload the project.

Navigation: scroll to zoom and drag to pan. Space-drag or middle-drag always pans. `F` fits the image to the view, Esc cancels the current tool, and Ctrl/⌘+Z undoes.

## ROI tool

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

**Background**: a pixel whose CIELAB chroma is at or below the *gray* threshold is the photograph, i.e. no signal. The default is 20, which removes the JPEG color noise seen in published IVIS figures while keeping the dimmest overlay colors. Adjust it under *Settings → Matching* and check with *Show signal*.

## Map tool

For figures whose pixels are the data: spectroscopy maps with so many bins that they look continuous, or false-color fluorescence images with a calibration bar.

1. **Open** the figure as for the heatmap tool. Panels work the same way.
2. **Plot area**: press *Place plot area* (`G`) and click the top-left and bottom-right corners of the image area, inside the axes.
3. **Colorbar**: place the ends and ticks as for heatmaps.
4. **Axes** (optional): press *Add x ticks* (`X`), click two or more labelled ticks on the x axis and type their values. Do the same for y (`Y`). Ticks stay on the plot area's edges (x on the bottom, y on the left), so only their position along the axis counts; drag them along the edge to adjust, or type a position in % across the plot area in the tick table (0 at the left or top, 100 at the right or bottom), for example for a tick exactly at the plot's corner. Each axis can be linear or Log₁₀. Without ticks, coordinates are pixels from the plot's top-left corner.
5. **Results**: *Bin size* 1 gives one value per pixel. Larger bins give one value per N × N pixels, the median of each channel, which smooths out JPEG noise. Hover the image for the value and axis coordinates under the pointer. *Reconstruct* repaints the plot with the matched values. *Show flags* marks colors far from the colorbar in red (ΔE above the threshold) and colors at the top or bottom end of the colorbar in magenta or cyan.
6. **Profiles**: press *Draw profile* (`L`) and click both ends of a line, for example a spectrum at one delay or a line scan across a cell. The card plots its values against the axis the line mostly runs along. *Length* sets how long the line is, in units of that axis (or pixels when it is not calibrated); the start and direction stay. *Width* averages ± pixels across the line. Shift- or Cmd-click profiles (chips or lines) to overlay several in the plot, each in its own color; *Select all* overlays every profile. *Scale* plots the values as they are, so signal levels compare directly, or divides each profile by its own maximum or mean, so their shapes compare. Hover the plot or a line on the image to trace it: both show the same sample, with its position and value. Drag the ends or the line to move it; hold Shift to move it only horizontally or vertically. Ctrl+C / Ctrl+V (⌘ on a Mac) copy and paste the selected profiles, also into another panel or page: there a copy keeps its place within the plot area, so the same line scan lands in the same spot of a panel of another size.
7. **Export**: *Download CSV* saves the matrix, with x of each column in the header and y of each row in the first column. *Long CSV* saves one row per value with ΔE and flags. *Download profile CSV* saves the selected profile; with several selected it saves them in one table with a `profile` column. When *Scale* divides the values, the CSV adds a `value_per_max` or `value_per_mean` column. The project zip includes all of them.

What the numbers can and cannot tell you:

- **Compression.** JPEG stores color at half resolution and in 8 × 8 blocks. Single pixels can be off by several percent of the range; the summary and *Show flags* show where. Bins of 4–8 px bring the worst case down a lot. On a synthetic viridis map saved at JPEG quality 0.6, the worst pixel was off by 10% of the range at bin 1 and by 2.4% at bin 8; the mean error was 0.6%.
- **Levels.** A colorbar can only tell so many values apart. The summary reports how many distinct colors the sampled bar has, at most 256 for an 8-bit colormap and fewer for a short bar.
- **Display units.** Published fluorescence images are almost always contrast-adjusted. Values are in the units of the colorbar as displayed, which supports comparisons within the image, not absolute intensities.
- **Clipping.** Pixels at the top or bottom color of the bar may be saturated: their true value can lie beyond the bar. The summary counts them.

Large maps take a moment: a 600 × 400 px map at bin 1 takes about 1–2 s with CIEDE2000, and CIE76 (in *Settings*) is about 10× faster.

## Heatmap agent

The *Agent* card in the heatmap tool calibrates every heatmap on the chosen pages by itself:

1. **Connect.** Open *Settings → Agent* and enter your [OpenRouter](https://openrouter.ai/keys) key. Or keep it out of the browser: put `OPENROUTER_API_KEY=…` in `.env` (ignored by git), run `npm run proxy`, and set *API base URL* to `http://localhost:8787/api/v1` with the key field empty.
2. **Pick models.** The LLM needs image input and tool calling; the default is `anthropic/claude-sonnet-5.5`. The reviewer is a smaller vision model that checks each panel; the default is `anthropic/claude-haiku-4.5`.
3. **Run.** Choose the pages and press *Run agent*. The LLM looks at page images with pixel rulers, zooms in, places the grid, labels, colorbar and ticks, and checks them with overlays. The reviewer then looks at each panel (the figure, both overlays and a colorbar zoom) and answers typed checks: grid size, flagged cells, tick order and final acceptance. Each answer comes with a confidence and a short reason.
4. **Review.** Checks answered below *Min. confidence* appear under *Needs review*. A rejected panel gets a red dot and stays there until you accept it or it changes. Add a note on what is wrong and press *Redo with agent* to have the agent fix it. *Delete panel* removes a wrong extraction outright (undo brings it back).

The agent retries a failing tool at most 3 times per panel, then skips that step and reports it. It stops after 8 failed calls in a row or after *Max. steps*. The log shows every step, review and the cost so far.

Page images and extracted values are sent to OpenRouter and the model providers you pick.

## Settings

*Settings* (top right) holds what belongs to you rather than to a figure. It is saved in the browser as you change it.

- **Agent**: OpenRouter key (stored only if *Remember* is ticked), *Min. confidence*, *Max. steps* and *API base URL*.
- **Matching**: color difference, ΔE flag limit and, for ROI, the gray threshold. New panels start with these values; changing one applies it to every panel of that tool in the open project (Undo reverts it). Each panel keeps its own copy in the project zip, so a project reopens with the values it was made with.
- **Hotkeys**: press *Change* and then the new key. Esc, Space, Enter, Backspace and Delete are fixed.
- **Import and export**: *Export settings* writes `colormeris-settings.zip` (one `settings.json`); *Import settings* reads it back, or a bare `settings.json`. The API key is left out unless you tick *Include the API key*; importing a file without a key keeps the current one.

## Agent API

`extract.html` exposes typed actions as `window.colormeris`, so any program can drive the tools without clicking pixels:

```js
await colormeris.run('set_grid', { topLeft: { x: 40, y: 60 }, bottomRight: { x: 520, y: 400 } });
await colormeris.run('add_tick', { at: { x: 560, y: 400 }, value: 0 });
await colormeris.run('get_results');   // → { ok, result } or { ok: false, error }
```

**[docs/agent.md](docs/agent.md)** is the full reference: every action and argument, typed questions and reviews, the heatmap agent's tools, limits and system prompt. It is generated from the code with `node scripts/agent-docs.mjs`, and a test fails when it is out of date.

## Colormaps

`colormaps.html` is a viewer for 1063 colormaps: the 87 of Matplotlib, 53 from [CMasher](https://cmasher.readthedocs.io/) (`cmr.amber`), 36 from Crameri's [Scientific colour maps](https://doi.org/10.5281/zenodo.8409685) (`cmc.batlow`) 21 from [cmocean](https://matplotlib.org/cmocean/) (`cmo.thermal`) 80 from [colorcet](https://colorcet.holoviz.org/) (`cet_fire`) and 12 from [seaborn](https://seaborn.pydata.org/tutorial/color_palettes.html) (`rocket`, `vlag`, and the qualitative `deep` to `colorblind`), named as matplotlib registers them, 58 from [CarbonPlan](https://carbonplan.org/design/colormaps) (`carbonplan.fire_light`, `carbonplan.fire_dark`: one version for light and one for dark backgrounds; rainbow and sinebow are the same in both, so only `_light` is listed), 162 of NCAR's [NCL color tables](https://www.ncl.ucar.edu/Document/Graphics/color_table_gallery.shtml) (`ncl.BlueRed`; stepped tables such as `ncl.precip_11lev` are shown as steps, as matplotlib draws them, and NCL has no types, so their groups are ours), 107 from [SciVisColor](https://sciviscolor.org/) (`sciviz.yg1`; non-sequential ones sorted by eye into diverging, multi-sequential, outlier-range and discrete), and 34 from [CARTOColors](https://carto.com/carto-colors/) (`carto.Burg`) and 2 from [MATLAB](https://www.mathworks.com/help/matlab/ref/colormap.html) (`matlab.parula`, `matlab.lines`; MATLAB's other maps, such as `jet` and `hot`, are Matplotlib's) and 411 from R packages, as listed by [R Charts](https://r-charts.com/color-palettes/) from the `paletteer` collection (`ggthemes::Tableau_10`, `ggsci::nrc_npg`, `grDevices::Blue-Red`, `wesanderson::Zissou1`, and others from ggpomological, ggthemr, tidyquant, tvthemes, vapoRwave, colorBlindness, dichromat and cartography; R Charts shows continuous palettes as 30 samples, which are interpolated linearly, and discrete ones as steps; the groups are ours, sorted by lightness; RColorBrewer and viridis are already Matplotlib's, copies of maps listed earlier are left out, and so is `ggsci::default_igv`, which has 51 colors). CARTOColors are palettes of up to 7 steps; their continuous versions interpolate the 7 colors in sRGB. Maps with the same colors as one already listed are left out: the shifted cyclic CMasher maps (`_s`), Crameri's categorical maps (`S`), berlin, managua and vanimo, which ship with Matplotlib, and `cmo.gray`, which is `cmr.neutral`. colorcet registers most maps three times (`cet_fire`, `cet_linear_kryw_0_100_c71`, `cet_CET_L3`); only the short name is kept, and its rotated cyclic maps (`_s25`, `CET_C1s`) and 256-color Glasbey palettes are left out, as are seaborn's 6-color palettes (`deep6`), which are subsets of the 10-color ones, and NCL's copies of other maps (`GMT_gray`, `matlab_hot`, an older `cividis`), test tables and 170-class tables (`lithology`). *Filters* in *Browse* can show the maps of one source; the Python packages and the R packages are each a group of sources, and sub-headings read `Python packages: Matplotlib` or `R packages: ggthemes`. Every sub-heading shows how many maps it holds. Within each sub-heading, maps are ordered by similarity, so families sit together. Each row has a reverse button (⇄). In sequential sections, maps that run the other way than most of their neighbors start reversed (the button is then on), so a section reads one way; *Reversed* under ⋯ still flips everything. It has five tabs: *Browse*, *Compare*, *Identify*, *Recolor* and *CVD*. The tab, the open map and the comparison are kept in the page link, so any view can be shared.

- *Browse* shows each map as vector strips: as seen, as simulated for protanopia, deuteranopia and tritanopia, and in grayscale. Under *Views*, pick one view to show only that strip, wider; the page remembers your choice.
- Hover a strip to see the hex, RGB, position and lightness (L*) of that color. Click to copy the hex. With the keyboard, focus a strip and use the arrow keys (Shift moves by 10).
- Four columns rate each map as uniform (U), CVD-safe, grayscale-safe and readable: ✓ yes, ~ partly, ✕ no. Hover a rating for the numbers, and press **?** in the header for how they are made. Click a column name to sort by it (best first, then worst first). On phones the ratings are pills under the name.
- *Readable* is about reading values back from colors, as Colormeris does. A color can be off by a few ΔE in a figure, so a difference under 3 ΔE2000 is not trusted. A map is less readable where values 5% apart look the same (flat zones), or where a color has a look-alike at least 10% away (ambiguous). jet is readable but not uniform.
- The search box filters by name. *Filters* keeps maps rated yes (*All four ✓* for maps that pass everything). Under **⋯** are *Reversed*, which flips every map, and the full sort menu (for example *Most linear L\**). Each group folds; Rainbow and Others start folded and open when a search matches them.
- Click a name, or the arrow at the end of its row, to see one map in detail. On wide screens it opens in a panel at the right and the list stays in place; on narrower ones it opens under the row. Esc closes it. It starts with one sentence per rating and four small square plots (in one row when there is room, else 2 × 2): L*, ΔE2000 steps, chroma and hue (hover a plot title's ⓘ for what to look for). Folded below are the L* stats with a table per view (smallest difference between values at least 10% apart, distinguishable levels, flat and ambiguous share; hover a row to mark the two closest colors on its strip), where values get confused on the strip, and the map's references. *Expand all* opens every fold at once.
- Press + on a row to add it to the comparison (up to 10). A tray at the bottom lists the chosen maps. *Compare* shows them side by side: strips, four plots in a row (L*, ΔE2000 steps, chroma and hue) with all maps on the same axes and one legend (hover a name to highlight that map in every plot), and a sortable table of the key numbers (*All numbers* shows the rest; the best value in each column is bold). You can reorder or remove maps there. Use *Copy link* to share it (`colormaps.html?compare=viridis,cividis#compare`).
- *Identify*: load an image (choose, drop or paste), then drag along its colorbar. The page snaps the line to the bar, samples it and lists the closest maps and their direction. *Use the whole image* matches the colors of a heatmap without a colorbar, but cannot tell the direction. *Show* opens a match in *Browse*, and *Recolor this figure* takes the image and the line to *Recolor*. The image never leaves the browser.
- *Recolor*: load an image, drag along its colorbar and pick a new colormap (viridis by default; type in the field to search, or leave it empty to scroll through all of them, and `name_r` turns on *Reversed*). Every pixel with a color of the bar gets the new map's color at the same place on the bar, so a jet figure can be seen in viridis, for example. Pixels farther than *Match within* (ΔE) from the bar keep their color, so the background, text and axes stay as they are. When the background or other parts share colors with the bar, press *Draw regions* and drag rectangles on the original around the parts to recolor (the plot, the colorbar); only pixels inside them change. Press it again or Esc to stop drawing; *Whole image* removes the regions. When the old map is a known one and the line runs from its high end, the bar is read the other way, so low stays low. Hover a color in the figure, or a place on the strips under it, and every pixel with a similar value (*Similar within*, 2% of the bar by default) flashes quickly between its own color and its complementary color. With reduced motion turned on, the rest of the figure is dimmed instead. Press and hold the figure to see the other version (original or recolored); release to go back. *Original* / *Recolored* switch for good. *Download PNG* saves the recolored figure at full size.
- *CVD*: see a figure next to how it may look with a color vision deficiency. The jet example is shown until you load your own image (choose, drop or paste; *Clear* goes back to the example). Pick *Protan*, *Deutan* or *Tritan*, *Gray* for achromatopsia (no color at all: the gray of the same luminance, as in *Browse*), or *All* for all four next to the original. *Severity* 1 is dichromacy; lower values are the milder anomalous trichromacy. *Recommended* follows the [DaltonLens review](https://daltonlens.org/opensource-cvd-simulation/): Brettel 1997 for tritan and Machado 2009 for protan and deutan; Brettel 1997, Viénot 1999 (protan and deutan only) and Machado 2009 can also be picked. Hover a spot to mark it on every panel and compare its colors (with ΔE2000); press and hold a simulation to see the original. *Download PNG* saves the simulation (with *All*, the five panels in a grid).
- Colormap data is generated from Matplotlib, CMasher, cmcrameri, cmocean, colorcet, seaborn, the `colormaps` package (CarbonPlan, NCL, SciVisColor) the `cartocolor` npm package (fetched from unpkg) MATLAB's parula (values embedded in the script) and R palettes (`scripts/fetch-r-palettes.py` saves them from R Charts to `scripts/data/r-palettes.json`) by `uv run --with matplotlib --with cmasher --with cmcrameri --with cmocean --with colorcet --with seaborn --with colormaps python scripts/export-mpl-colormaps.py`. The CVD views use the Machado et al. (2009) model. Methods and references are in the fold at the bottom of the page.

## How heatmap values are computed

- **Cell color**: each channel's median over the central part of the cell. The *Sampled area* setting controls how much, 50% by default. Using the center avoids grid lines, anti-aliased edges and JPEG noise.
- **Colorbar**: sampled at 256 evenly spaced points from one end to the other. Each point averages ±*half-width* pixels across the bar.
- **Matching**: the cell color is converted to CIELAB and matched to the nearest colorbar sample by CIEDE2000 (CIE76 is optional). The match is refined between neighbouring samples. That position along the bar is then converted to a value using the ticks.

## Project zip layout

```
project.json            per panel: tool (heatmap, roi or map), page, grid, colorbar,
                        labels, settings, review (accepted/rejected), for ROI
                        the regions and scale bar, and for maps the bin size,
                        axis ticks and profiles
README.txt
source/<original file>  the uploaded PDF/image
source/page-<n>.png     the rendered image of each page that has panels
data/<panel>.csv        heatmap: matrix of values
data/<panel>_long.csv   heatmap: per-cell values with page, RGB and ΔE
data/<panel>_rois.csv   ROI: measurements per region copy
data/<panel>_map.csv    map: matrix of values with x and y at bin centres
data/<panel>_map_long.csv  map: one row per value with ΔE and flags
data/<panel>_profile_<name>.csv  map: values along each profile
agent/actions.json      changes made through the agent API, in order
agent/decisions.json    typed decisions (answer, confidence, source, applied)
```

The agent logs are written but not read back when a zip is reopened; panel reviews are (they live in `project.json`). Each panel records its `page`. Its coordinates are pixels in that page's `source/page-<n>.png`. Regions copied into every box are stored relative to a box, where a box spans 0–1 in each direction, with per-box nudges. A zip opens in either tool with everything in it. Version 1 zips load too; one without a tool is a heatmap project. Zips saved before the ROI tool was renamed (tool `ivis`) are refused with an error rather than opened as heatmaps.

## Development

More documentation: [docs/agent.md](docs/agent.md) (agent reference, generated), [docs/research.md](docs/research.md) (prior work, novelty, experiment plan), and [CLAUDE.md](CLAUDE.md) (architecture, conventions, status and next steps for Claude sessions).

There is no build step. The pages are plain HTML, CSS and classic scripts that register on a shared `Colormeris` namespace. Each page loads them in order. pdf.js 6.3.289, JSZip 3.10.2 and a browser bundle of the OpenRouter TypeScript SDK (loaded only when the agent runs; rebuild with `node scripts/bundle-openrouter.mjs`) are vendored in `assets/vendor/`.

You can open `index.html` directly from disk or serve the folder:

```bash
npm run serve   # python3 -m http.server 8000, then open http://localhost:8000
npm test        # unit tests (node:test, no dependencies)
npm run proxy   # optional: OpenRouter proxy on :8787 using the key in .env
npm run docs    # regenerate docs/agent.md after changing the agent
npm run fixtures  # regenerate the synthetic calibration heatmaps in tests/fixtures/
```

Opened from disk (`file://`), browsers block module files, fetches and workers. There, pdf.js is loaded from `assets/vendor/pdfjs/pdf.embed.js` and runs on the main thread. PDFs that need extra data (non-embedded fonts, CJK character maps, JPEG 2000 images) render best when served over HTTP. After updating the vendored pdf.js, regenerate the embed with `node scripts/embed-pdfjs.mjs`.

To deploy, publish the repository root with GitHub Pages or any static host. `.nojekyll` is already included.

The code is grouped by page. Files that need no DOM are loaded by the tests through `tests/load.js`; the tests mirror the folders.

| Folder | Purpose |
| --- | --- |
| `assets/css/` | `base.css` for every page, plus `landing.css`, `extract.css` and `colormaps.css` |
| `assets/js/core/` | shared by both apps: color spaces and ΔE (`color.js`), CVD simulation (`cvd.js`), grid geometry and cell sampling (`grid.js`), colorbar calibration (`colorbar.js`), the colormap data (`colormap-library.js`, generated) and matching a bar to a known colormap (`colormap-match.js`) |
| `assets/js/extract/` | `extract.html`: project model (`project.js`), CSV and zip (`project-files.js`), settings, PDF loading, the canvas viewer and `main.js`, which starts the page |
| `assets/js/extract/workspace/` | the shell both tools share: `workspace.js` (state, modes, tool switching) and one file each for undo, overlay drawing, pointer input, the Grid, Colorbar and Panels cards, opening files and pages, export and hotkeys |
| `assets/js/extract/heatmap/` | heatmap tool: extraction (`sampling.js`) and the tool (`heatmap-tool.js`) |
| `assets/js/extract/roi/` | ROI tool: region geometry (`geometry.js`), signal statistics (`quantify.js`), the tool, its overlay and its sidebar |
| `assets/js/agent/` | agent API and heatmap agent: action schema (`schema.js`), `window.colormeris` (`api.js`), prompt and reviewer mapping (`llm.js`), the loop (`runner.js`) and the Agent card (`agent-card.js`) |
| `assets/js/colormaps/` | `colormaps.html`: `viewer.js` (state, tabs, page) with one file per tab, plus strips, plots, footer, URL routing (`route.js`), ratings (`metrics.js`), references and recoloring |
| `scripts/` | generators and tools: `agent-docs.mjs` (docs/agent.md), `export-mpl-colormaps.py` (colormap data), `make-calibration.mjs` (synthetic test heatmaps, `npm run fixtures`), `bundle-openrouter.mjs`, `embed-pdfjs.mjs`, `openrouter-proxy.mjs` |
