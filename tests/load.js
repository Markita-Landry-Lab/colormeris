// Load the browser scripts (classic scripts registering on globalThis.Colormeris)
// in dependency order and expose the shared namespace to tests.
import '../assets/js/color.js';
import '../assets/js/grid.js';
import '../assets/js/colormap.js';
import '../assets/js/cvd.js';
import '../assets/js/cmap-metrics.js';
import '../assets/js/cmap-refs.js';
import '../assets/js/cmap-data.js';
import '../assets/js/cmap-identify.js';
import '../assets/js/cmap-recolor.js';
import '../assets/js/state.js';
import '../assets/js/settings.js';
import '../assets/js/extract.js';
import '../assets/js/export.js';
import '../assets/js/roi.js';
import '../assets/js/quantify.js';
import '../assets/js/agent-schema.js';
import '../assets/js/agent-llm.js';

export default globalThis.Colormeris;
