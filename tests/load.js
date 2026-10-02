// Load the pure browser scripts (classic scripts registering on
// globalThis.Colormeris) in dependency order and expose the shared namespace
// to tests and scripts. Every pure file belongs here.
import '../assets/js/core/color.js';
import '../assets/js/core/cvd.js';
import '../assets/js/core/grid.js';
import '../assets/js/core/colorbar.js';
import '../assets/js/core/colormap-library.js';
import '../assets/js/core/colormap-match.js';
import '../assets/js/colormaps/metrics.js';
import '../assets/js/colormaps/references.js';
import '../assets/js/colormaps/route.js';
import '../assets/js/colormaps/recolor.js';
import '../assets/js/extract/project.js';
import '../assets/js/extract/settings.js';
import '../assets/js/extract/project-files.js';
import '../assets/js/extract/heatmap/sampling.js';
import '../assets/js/extract/roi/geometry.js';
import '../assets/js/extract/roi/quantify.js';
import '../assets/js/extract/map/field.js';
import '../assets/js/agent/schema.js';
import '../assets/js/agent/llm.js';

export default globalThis.Colormeris;
