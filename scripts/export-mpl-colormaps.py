"""Write assets/js/cmap-data.js with the colormaps for colormaps.html.

Run:  uv run --with matplotlib --with cmasher --with cmcrameri python scripts/export-mpl-colormaps.py

The maps come from matplotlib, CMasher (van der Velden 2020) and Crameri's
Scientific colour maps (via cmcrameri; Zenodo 10.5281/zenodo.8409685).
Continuous maps are sampled at 256 evenly spaced points (matplotlib's own
lookup-table size); qualitative maps keep their listed colors. Groups follow the
categories of matplotlib's colormap reference, regrouped into sequential,
diverging, cyclic, rainbow and others. CMasher maps keep matplotlib's
registered names (cmr.amber), since copper and ocean exist in both; Crameri's
maps likewise (cmc.batlow). A map already shown under an earlier source
(berlin, managua and vanimo ship with matplotlib) is not added again.
"""
import json
from pathlib import Path

import cmasher
import cmcrameri
import cmcrameri.cm
import matplotlib
import numpy as np
from matplotlib import colormaps
from matplotlib.colors import ListedColormap, to_hex

# Aliases (grey, Grays, gist_grey, gist_yerg) and _r variants are left out.
# (group, sub-heading, names); order is the display order.
GROUPS = [
    ("sequential", "Perceptually uniform", ["viridis", "plasma", "inferno", "magma", "cividis"]),
    ("sequential", "Sequential", ["Greys", "Purples", "Blues", "Greens", "Oranges", "Reds",
                                  "YlOrBr", "YlOrRd", "OrRd", "PuRd", "RdPu", "BuPu", "GnBu",
                                  "PuBu", "YlGnBu", "PuBuGn", "BuGn", "YlGn"]),
    ("sequential", "Sequential (2)", ["binary", "gist_yarg", "gist_gray", "gray", "bone", "pink",
                                      "spring", "summer", "autumn", "winter", "cool", "Wistia",
                                      "hot", "afmhot", "gist_heat", "copper"]),
    ("diverging", "", ["PiYG", "PRGn", "BrBG", "PuOr", "RdGy", "RdBu", "RdYlBu", "RdYlGn",
                       "coolwarm", "bwr", "seismic", "berlin", "managua", "vanimo"]),
    ("cyclic", "", ["twilight", "twilight_shifted", "hsv"]),
    ("rainbow", "", ["jet", "rainbow", "gist_rainbow", "turbo", "nipy_spectral", "gist_ncar", "Spectral"]),
    ("others", "Qualitative", ["Pastel1", "Pastel2", "Paired", "Accent", "Dark2", "Set1", "Set2",
                               "Set3", "tab10", "tab20", "tab20b", "tab20c", "okabe_ito"]),
    ("others", "Miscellaneous", ["flag", "prism", "ocean", "gist_earth", "terrain", "gist_stern",
                                 "gnuplot", "gnuplot2", "CMRmap", "cubehelix", "brg"]),
]

# CMasher's own types map onto our groups. The cyclic _s maps are left out:
# they are the same colors as their base map, started half a turn later.
CMR_GROUPS = {"sequential": "sequential", "diverging": "diverging", "cyclic": "cyclic"}

N = 256
X = [i / (N - 1) for i in range(N)]  # not linspace: its rounding moves some hex values


def colors_of(cmap, qualitative):
    rgba = cmap.colors if qualitative else cmap(X)
    return "".join(to_hex(c)[1:] for c in rgba)


def cmasher_groups():
    unknown = {t for t, names in cmasher.cm.cmap_cd.items() if names} - CMR_GROUPS.keys()
    assert not unknown, f"new CMasher types: {unknown}"
    for kind, group in CMR_GROUPS.items():
        names = sorted(n for n in cmasher.cm.cmap_cd[kind] if not n.endswith(("_r", "_s")))
        yield group, "CMasher", [f"cmr.{n}" for n in names]


# Crameri's classes (Crameri et al. 2020, Fig. 2 of the user guide). The
# categorical *S maps are left out: they are the same colors, reordered.
CMC_GROUPS = [
    ("sequential", "Crameri", ["batlow", "batlowW", "batlowK", "glasgow", "lipari", "navia",
                               "hawaii", "buda", "imola", "oslo", "grayC", "nuuk", "devon",
                               "lajolla", "bamako", "davos", "bilbao", "lapaz", "acton",
                               "turku", "tokyo"]),
    ("diverging", "Crameri", ["broc", "cork", "vik", "lisbon", "tofino", "berlin", "roma",
                              "bam", "vanimo", "managua"]),
    ("cyclic", "Crameri", ["romaO", "bamO", "brocO", "corkO", "vikO"]),
    ("others", "Multi-sequential (Crameri)", ["oleron", "bukavu", "fes"]),
]


def crameri_groups():
    listed = {n for _, _, names in CMC_GROUPS for n in names}
    missing = {n for n in cmcrameri.cm.cmaps if not n.endswith(("_r", "S"))} - listed
    assert not missing, f"new Crameri maps: {missing}"
    for group, sub, names in CMC_GROUPS:
        yield group, sub, [f"cmc.{n}" for n in names]


# A CMasher or Crameri map that matches an earlier one (or its reverse) to within 2/255 is not added.
def duplicate_of(rgb, seen):
    for name, other in seen.items():
        if min(np.abs(rgb - other).max(), np.abs(rgb[::-1] - other).max()) < 2 / 255:
            return name
    return None


maps = []
seen = {}  # name -> sampled rgb, for the duplicate check
for source, groups in [("matplotlib", GROUPS), ("cmasher", list(cmasher_groups())),
                       ("crameri", list(crameri_groups()))]:
    for group, sub, names in groups:
        for name in names:
            cmap = colormaps[name]
            qualitative = sub == "Qualitative"
            assert not qualitative or isinstance(cmap, ListedColormap), name
            if not qualitative:
                rgb = cmap(X)[:, :3]
                twin = source != "matplotlib" and duplicate_of(rgb, seen)
                if twin:
                    print(f"skipped {name}: same colors as {twin}")
                    continue
                seen[name] = rgb
            maps.append({
                "name": name,
                "group": group,
                "sub": sub,
                "source": source,
                "kind": "qualitative" if qualitative else "continuous",
                "colors": colors_of(cmap, qualitative),
            })

# In the order of the source filter in colormaps.html.
sources = [
    {"key": "matplotlib", "label": "Matplotlib", "version": matplotlib.__version__},
    {"key": "cmasher", "label": "CMasher", "version": cmasher.__version__},
    {"key": "crameri", "label": "Crameri", "version": cmcrameri.__scm_version__},
]
data = {"sources": sources, "maps": maps}
out = Path(__file__).resolve().parent.parent / "assets" / "js" / "cmap-data.js"
out.write_text(
    "// Generated by scripts/export-mpl-colormaps.py; do not edit by hand.\n"
    "// Colors are 6-digit hex strings concatenated (256 samples, or the listed colors).\n"
    "(function (CM) {\n"
    "  'use strict';\n"
    f"  CM.cmapData = {json.dumps(data, separators=(',', ':'))};\n"
    "})((globalThis.Colormeris ??= {}));\n"
)
counts = {s["key"]: sum(m["source"] == s["key"] for m in maps) for s in sources}
print(f"wrote {out} ({len(maps)} maps: {counts}; matplotlib {matplotlib.__version__}, cmasher {cmasher.__version__}, Crameri {cmcrameri.__scm_version__})")
