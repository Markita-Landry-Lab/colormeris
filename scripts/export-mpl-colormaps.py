"""Write assets/js/core/colormap-library.js with the colormaps for colormaps.html.

Run:  uv run --with matplotlib --with cmasher --with cmcrameri --with cmocean --with colorcet --with seaborn --with colormaps python scripts/export-mpl-colormaps.py

The maps come from matplotlib, CMasher (van der Velden 2020) and Crameri's
Scientific colour maps (via cmcrameri; Zenodo 10.5281/zenodo.8409685) and
cmocean (Thyng et al. 2016), colorcet (Kovesi 2015), seaborn (Waskom 2021), CarbonPlan, NCAR's NCL color tables and SciVisColor (all
from the colormaps package by Pratiman Patel, which ships their color tables) and
CARTOColors (CARTO's cartocolor npm package, fetched from unpkg at a pinned
version). CARTOColors are discrete palettes of up to 7 steps; like
palettable's mpl_colormap, the continuous versions interpolate the 7-step
palette linearly in sRGB. Qualitative ones keep their longest palette.
Continuous maps are sampled at 256 evenly spaced points (matplotlib's own
lookup-table size); qualitative maps keep their listed colors. Groups follow the
categories of matplotlib's colormap reference, regrouped into sequential,
diverging, cyclic, rainbow, multi-sequential, qualitative and others. CMasher maps keep matplotlib's
registered names (cmr.amber), since copper and ocean exist in both; Crameri's
maps likewise (cmc.batlow). A map already shown under an earlier source
(berlin, managua and vanimo ship with matplotlib) is not added again.
"""
import base64
import json
import re
import urllib.request
from pathlib import Path

import cmasher
import cmcrameri
import cmcrameri.cm
import cmocean
import colorcet
import seaborn
from seaborn.palettes import SEABORN_PALETTES
from importlib.metadata import distribution, version as pkg_version
import matplotlib
import numpy as np
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap, ListedColormap, to_hex

# Aliases (grey, Grays, gist_grey, gist_yerg) and _r variants are left out.
# (group, sub-heading, names); order is the display order.
GROUPS = [
    ("sequential", "Matplotlib (perceptually uniform)", ["viridis", "plasma", "inferno", "magma", "cividis"]),
    ("sequential", "Matplotlib (ColorBrewer)", ["Greys", "Purples", "Blues", "Greens", "Oranges", "Reds",
                                  "YlOrBr", "YlOrRd", "OrRd", "PuRd", "RdPu", "BuPu", "GnBu",
                                  "PuBu", "YlGnBu", "PuBuGn", "BuGn", "YlGn"]),
    ("sequential", "Matplotlib (classic)", ["binary", "gist_yarg", "gist_gray", "gray", "bone", "pink",
                                      "spring", "summer", "autumn", "winter", "cool", "Wistia",
                                      "hot", "afmhot", "gist_heat", "copper"]),
    ("diverging", "Matplotlib", ["PiYG", "PRGn", "BrBG", "PuOr", "RdGy", "RdBu", "RdYlBu", "RdYlGn",
                       "coolwarm", "bwr", "seismic", "berlin", "managua", "vanimo"]),
    ("cyclic", "Matplotlib", ["twilight", "twilight_shifted", "hsv"]),
    ("rainbow", "Matplotlib", ["jet", "rainbow", "gist_rainbow", "turbo", "nipy_spectral", "gist_ncar", "Spectral"]),
    ("qualitative", "Matplotlib", ["Pastel1", "Pastel2", "Paired", "Accent", "Dark2", "Set1", "Set2",
                               "Set3", "tab10", "tab20", "tab20b", "tab20c", "okabe_ito"]),
    ("others", "Matplotlib (miscellaneous)", ["flag", "prism", "ocean", "gist_earth", "terrain", "gist_stern",
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
    ("multi-sequential", "Crameri", ["oleron", "bukavu", "fes"]),
]


def crameri_groups():
    listed = {n for _, _, names in CMC_GROUPS for n in names}
    missing = {n for n in cmcrameri.cm.cmaps if not n.endswith(("_r", "S"))} - listed
    assert not missing, f"new Crameri maps: {missing}"
    for group, sub, names in CMC_GROUPS:
        yield group, sub, [f"cmc.{n}" for n in names]


# cmocean's classes, from its docs (matplotlib.org/cmocean), except oxy.
CMO_GROUPS = [
    ("sequential", "cmocean", ["thermal", "haline", "solar", "ice", "gray", "deep", "dense",
                               "algae", "matter", "turbid", "speed", "amp", "tempo", "rain"]),
    ("diverging", "cmocean", ["balance", "delta", "curl", "diff", "tarn"]),
    ("cyclic", "cmocean", ["phase"]),
    ("multi-sequential", "cmocean", ["topo"]),
    # oxy is gray with red and yellow ends for out-of-range values, not one sequence.
    ("others", "cmocean (miscellaneous)", ["oxy"]),
]


def cmocean_groups():
    listed = {n for _, _, names in CMO_GROUPS for n in names}
    assert set(cmocean.cm.cmapnames) == listed, f"cmocean maps changed: {set(cmocean.cm.cmapnames) ^ listed}"
    for group, sub, names in CMO_GROUPS:
        yield group, sub, [f"cmo.{n}" for n in names]


# colorcet registers each Kovesi map up to three times: by its descriptive
# name (linear_kryw_0_100_c71), a short alias (fire) and its CET code
# (CET_L3). We keep one, under the short alias if there is one, the
# descriptive name otherwise; CET codes only survive for maps that have no
# other name (the duplicate check drops the rest). The _s25 maps are the
# cyclic ones rotated, and the 256-color Glasbey palettes are not colormaps
# one reads values from, so both are left out.
CET_PREFIX = [  # (start of the descriptive name, group, sub-heading)
    ("linear", "sequential", "colorcet"),
    ("diverging", "diverging", "colorcet"),
    (("cyclic", "circle"), "cyclic", "colorcet"),
    ("rainbow", "rainbow", "colorcet"),
    ("isoluminant", "others", "colorcet (isoluminant)"),
]
CET_CODE = {"L": 0, "D": 1, "C": 2, "R": 3, "I": 4}  # CET_L3, CET_CBL1, CET_CBTD1 -> index in CET_PREFIX


def colorcet_groups():
    registered = sorted(n[4:] for n in colormaps if n.startswith("cet_") and not n.endswith("_r"))
    aliases = {a for names in colorcet.aliases.values() for a in names}
    groups = {}
    for n in registered:
        if n in aliases or n.startswith(("CET_", "glasbey")) or n.endswith("_s25"):
            continue
        i = next(i for i, (pre, _, _) in enumerate(CET_PREFIX) if n.startswith(pre))
        short = colorcet.aliases.get(n, [n])[0]
        groups.setdefault(i, []).append(f"cet_{short}")
    for n in registered:
        if n.startswith("CET_"):
            code = re.match(r"CET_(?:CBT|CB)?([LDCRI])\d", n).group(1)
            groups.setdefault(CET_CODE[code], []).append(f"cet_{n}")
    for i in sorted(groups):
        yield CET_PREFIX[i][1], CET_PREFIX[i][2], groups[i]


EXTRA = {}  # name -> colormap, for maps matplotlib does not register


# seaborn registers its continuous maps in matplotlib without a prefix
# (rocket, vlag); its qualitative palettes are only in seaborn, and the
# 6-color ones (deep6) are subsets of the 10-color ones.
SNS_GROUPS = [
    ("sequential", "seaborn", ["rocket", "mako", "flare", "crest"]),
    ("diverging", "seaborn", ["vlag", "icefire"]),
    ("qualitative", "seaborn", ["deep", "muted", "pastel", "bright", "dark", "colorblind"]),
]


def seaborn_groups():
    listed = {n for _, _, names in SNS_GROUPS for n in names}
    assert {n for n in SEABORN_PALETTES if not n.endswith("6")} <= listed, "new seaborn palettes"
    for group, sub, names in SNS_GROUPS:
        if group == "qualitative":
            for n in names:
                EXTRA[n] = ListedColormap(SEABORN_PALETTES[n], name=n)
        yield group, sub, names


# CarbonPlan's maps come in a light and a dark version (for light and dark
# backgrounds); both are kept, as their colors differ. Groups follow
# carbonplan.org/design/colormaps; the *grey maps diverge through white
# (light) or near-black (dark) to grey.
CP_GROUPS = [
    ("sequential", "CarbonPlan", ["reds", "oranges", "yellows", "greens", "teals", "blues", "purples",
                                  "pinks", "greys", "fire", "earth", "water", "heart", "wind",
                                  "warm", "cool"]),
    ("diverging", "CarbonPlan", ["pinkgreen", "redteal", "orangeblue", "yellowpurple", "redgrey",
                                 "orangegrey", "yellowgrey", "greengrey", "tealgrey", "bluegrey",
                                 "purplegrey", "pinkgrey"]),
    ("cyclic", "CarbonPlan", ["sinebow"]),
    ("rainbow", "CarbonPlan", ["rainbow"]),
]


# Each .rgb file is "ncolors=255", a header line "r g b", then one color per line.
def carbonplan_groups():
    # Found through the package metadata: the colormaps module's __getattr__
    # hides __spec__, so importlib.resources cannot see it.
    folder = Path(distribution("colormaps").locate_file("colormaps/colormaps/carbonplan"))
    found = {f.name.removesuffix(".rgb") for f in folder.iterdir() if f.name.endswith(".rgb")}
    listed = {f"{n}_{t}" for _, _, names in CP_GROUPS for n in names for t in ("light", "dark")}
    assert found == listed, f"CarbonPlan maps changed: {found ^ listed}"
    for group, sub, names in CP_GROUPS:
        out = []
        for n in names:
            for theme in ("light", "dark"):
                rows = (folder / f"{n}_{theme}.rgb").read_text().split("\n")[2:]
                rgb = [[int(v) / 255 for v in r.split()] for r in rows if r.strip()]
                full = f"carbonplan.{n}_{theme}"
                EXTRA[full] = LinearSegmentedColormap.from_list(full, rgb, N=N)
                out.append(full)
        yield group, sub, out


# NCL's tables are lists of colors (2 to 256), many of them stepped
# contour levels (precip_11lev). They are shown as matplotlib draws a
# ListedColormap: steps, not blends. NCL has no types, so the groups are
# ours, chosen by looking at each table's lightness and hues.
NCL_GROUPS = [
    ("sequential", "NCL", [
        "GMT_copper", "GMT_cool", "GMT_gebco", "GMT_gray", "GMT_hot",
        "GMT_ocean", "GreenYellow", "gsdtol", "gsltod", "GSFC_landsat_udf_density", "helix", "helix1",
        "thelix", "matlab_hot", "NEO_modis_ndvi", "sunshine_9lev", "WhiteBlue",
        "WhiteGreen", "WhiteYellowOrangeRed"]),
    # Two sequential runs joined: the lightness jumps or turns once.
    ("multi-sequential", "NCL", ["GMT_nighttime", "SVG_es_landscape_79", "GMT_relief"]),
    ("diverging", "NCL", [
        "amwg_blueyellowred", "BlAqGrWh2YeOrReVi22", "BlRe", "BlueDarkOrange18", "BlueDarkRed18",
        "BlueGreen14", "BlueRed", "BlueRedGray", "BlueWhiteOrangeRed", "BlueYellowRed", "BlWhRe",
        "BrownBlue12", "cmp_b2r", "drought_severity", "GHRSST_anomaly", "GMT_no_green", "GMT_panoply",
        "GMT_polar", "GMT_red2green", "GMT_seis", "GMT_split", "GrayWhiteGray", "GreenMagenta16",
        "hotcold_18lev", "hotcolr_19lev", "NCV_blu_red", "NCV_blue_red", "NCV_jaisnd", "ncview_default",
        "NEO_div_vegetation_a", "NEO_div_vegetation_b", "NEO_div_vegetation_c", "nrl_sirkes",
        "nrl_sirkes_nowhite", "precip_diff_12lev", "precip4_diff_19lev", "sunshine_diff_12lev",
        "temp_19lev", "temp_diff_18lev", "UKM_hadcrut", "vegetation_ClarkU", "ViBlGrWhYeOrRe"]),
    ("cyclic", "NCL", ["circular_0", "circular_1", "circular_2", "cyclic", "gscyclic", "matlab_hsv"]),
    ("rainbow", "NCL", [
        "amwg", "amwg256", "BkBlAqGrYeOrReViWh200", "BlAqGrYeOrRe", "BlAqGrYeOrReVi200",
        "BlGrYeOrReVi200", "cb_rainbow", "cb_rainbow_inv", "cmp_haxby", "cosam", "cosam12", "detail",
        "extrema", "gauss3", "GMT_haxby", "GMT_jet", "GMT_wysiwyg", "GMT_wysiwygcont", "grads_rainbow",
        "gui_default", "matlab_jet", "NCV_bright", "NCV_jet", "NCV_rainbow2", "ncl_default", "rainbow",
        "rainbow_gray", "rainbow_white", "rainbow_white_gray", "saw3", "WhBlGrYeRe", "wh_bl_gr_ye_re",
        "WhViBlGrYeOrRe", "WhViBlGrYeOrReWh", "precip2_15lev", "precip2_17lev", "precip3_16lev",
        "precip4_11lev", "precip_11lev", "prcp_1", "prcp_2", "prcp_3", "rh_19lev", "wind_17lev",
        "spread_15lev", "perc2_9lev", "percent_11lev", "t2m_29lev", "temp1", "NMCRef", "NMCVel", "wgne15"]),
    ("qualitative", "NCL", ["Cat12", "GMT_paired", "default", "hlu_default", "grads_default"]),
    ("others", "NCL (miscellaneous)", [
        "cb_9step", "StepSeq25", "cmp_flux", "GMT_drywet", "GMT_globe",
        "WhiteBlueGreenYellowRed", "GMT_relief_oceanonly", "GMT_topo", "NCV_gebco", "OceanLakeLandSnow", "topo_15lev",
        "vegetation_modis", "NOC_ndvi", "nice_gfdl", "hotres", "NCV_banded", "NCV_manga", "NCV_roullet",
        "posneg_1", "posneg_2", "seaice_1", "seaice_2", "so4_21", "so4_23", "srip_reanalysis",
        "mch_default", "radar", "radar_1", "SVG_bhw3_22", "SVG_feb_sunrise", "SVG_foggy_sunrise",
        "SVG_fs2006", "SVG_Gallet13", "SVG_Lindaa06", "SVG_Lindaa07", "tbr_240_300", "tbr_stdev_0_30",
        "tbr_var_0_500", "tbrAvg1", "tbrStd1", "tbrVar1", "wxpEnIR", "WhBlReWh"]),
]
# Test tables, 2-color tables and long lists of categories (matlab_lines
# repeats 7 colors; lithology, uniform and psgcap have 170+ classes).
# NCL's cividis is an earlier table of matplotlib's cividis (up to 23/255
# apart), so it is the same map, not a new one.
NCL_SKIP = ["cividis", "example", "testcmap", "precip_diff_1lev", "temp_diff_1lev", "matlab_lines", "lithology",
            "uniform", "psgcap"]


# A table is "ncolors=N", maybe a header, then "r g b" per line, 0–255 or 0–1.
def read_ncl(path):
    rows = [r.split()[:3] for r in path.read_text().splitlines()]
    rgb = np.array([r for r in rows if len(r) == 3 and all(re.fullmatch(r"[0-9.]+", v) for v in r)], float)
    return rgb / 255 if rgb.max() > 1 + 1e-6 else rgb


def ncl_groups():
    folder = Path(distribution("colormaps").locate_file("colormaps/colormaps/ncar_ncl"))
    found = {f.stem for f in folder.glob("*.rgb")}
    listed = {n for _, _, names in NCL_GROUPS for n in names}
    assert found == listed | set(NCL_SKIP), f"NCL tables changed: {found ^ (listed | set(NCL_SKIP))}"
    for group, sub, names in NCL_GROUPS:
        for n in names:
            EXTRA[f"ncl.{n}"] = ListedColormap(read_ncl(folder / f"{n}.rgb"), name=f"ncl.{n}")
        yield group, sub, [f"ncl.{n}" for n in names]


# SciVisColor (sciviscolor.org). Every table not listed below is sequential
# (they all get steadily lighter or darker). The rest were sorted by eye:
# diverging maps, maps of several sequential segments joined (high3,
# hier5), maps with highlighted outlier ranges (other_outl_*), and the
# discrete palettes, whose files list each color twice.
SVC_DIVERGING = ["br4div", "bruce2", "d_blgr3", "d_seteq2", "dasy_grbr1", "div1_blue_orange",
                 "div2_gray_gold", "div3_green_brown", "div5_asym_Ob", "hier2p", "speed_yel",
                 "w5m4", "w_ymiddle1"]
SVC_MULTI = ["c_blgr1", "high2ml", "high3", "high4", "high5", "hier4w", "hier5", "wlteqcool", "wmutedset"]
SVC_OUTLIER = [f"other_outl_{i}" for i in range(1, 9)]
SVC_DISCRETE = ["discrete_autumn", "discrete_Bg", "discrete_Bo", "discrete_dark", "discrete_light_aut",
                "discrete_muted", "discrete_vaneyck"]
# "test" is yg3 under another name, tr4 is div2_gray_gold; colormap66 and
# yel_peach_br are brown_peachy (the duplicate check would also drop them).
SVC_SKIP = ["test", "tr4", "colormap66", "yel_peach_br"]


def sciviz_groups():
    folder = Path(distribution("colormaps").locate_file("colormaps/colormaps/sciviz"))
    found = sorted((f.stem for f in folder.glob("*.rgb") if f.stem not in SVC_SKIP), key=str.lower)
    special = set(SVC_DIVERGING + SVC_MULTI + SVC_OUTLIER + SVC_DISCRETE)
    assert special <= set(found), f"SciVisColor tables missing: {special - set(found)}"
    groups = [("sequential", "SciVisColor", [n for n in found if n not in special]),
              ("diverging", "SciVisColor", SVC_DIVERGING),
              ("multi-sequential", "SciVisColor", SVC_MULTI),
              ("others", "SciVisColor (outlier ranges)", SVC_OUTLIER),
              ("qualitative", "SciVisColor", SVC_DISCRETE)]
    for group, sub, names in groups:
        for n in names:
            rgb = read_ncl(folder / f"{n}.rgb")
            full = f"sciviz.{n}"
            if group == "qualitative":
                keep = [c for i, c in enumerate(rgb) if i == 0 or np.abs(c - rgb[i - 1]).max() > 1e-6]
                EXTRA[full] = ListedColormap(keep, name=full)
            else:
                EXTRA[full] = LinearSegmentedColormap.from_list(full, rgb, N=N)
        yield group, sub, [f"sciviz.{n}" for n in names]


CARTO_VERSION = "5.0.2"
CARTO_URL = f"https://unpkg.com/cartocolor@{CARTO_VERSION}/src/carto.js"
# CARTO's tags -> (group, sub-heading). Aggregation maps are sequential too.
CARTO_TAGS = {
    "quantitative": ("sequential", "CARTOColors"),
    "aggregation": ("sequential", "CARTOColors"),
    "diverging": ("diverging", "CARTOColors"),
    "qualitative": ("qualitative", "CARTOColors"),
}


# carto.js is `export const Burg = { 2: [...], …, 7: [...], tags: [...] };` per palette.
def carto_groups():
    js = urllib.request.urlopen(CARTO_URL).read().decode()
    groups = {}
    for name, body in re.findall(r"export const (\w+) = \{(.*?)\n\};", js, re.S):
        sizes = {int(k): re.findall(r"#[0-9A-Fa-f]{6}", v)
                 for k, v in re.findall(r"(\d+): \[(.*?)\]", body, re.S)}
        tags = re.findall(r'"(\w+)"', re.search(r"tags: \[(.*?)\]", body, re.S).group(1))
        group, sub = CARTO_TAGS[tags[0]]
        colors = [c.lower() for c in sizes[max(sizes)]]
        full = f"carto.{name}"
        if group == "qualitative":
            EXTRA[full] = ListedColormap(colors, name=full)
        else:
            EXTRA[full] = LinearSegmentedColormap.from_list(full, colors, N=N)
        groups.setdefault((group, sub), []).append(full)
    assert len(EXTRA) >= 34, f"only {len(EXTRA)} CARTO palettes parsed"
    for (group, sub), names in groups.items():
        yield group, sub, names


# MATLAB's colormap page lists jet, hsv, hot, cool, spring, summer, autumn,
# winter, gray, bone, copper, pink, prism, flag and turbo; Matplotlib already
# ships those (the duplicate check would drop them). Only parula (MathWorks'
# R2014b default, 64 colors, as published in the BIDS/colormap repository) and
# the "lines" color order are new here.
PARULA = [
    (0.2081, 0.1663, 0.5292), (0.2116238095, 0.1897809524, 0.5776761905), (0.212252381, 0.2137714286, 0.6269714286), (0.2081, 0.2386, 0.6770857143),
    (0.1959047619, 0.2644571429, 0.7279), (0.1707285714, 0.2919380952, 0.779247619), (0.1252714286, 0.3242428571, 0.8302714286), (0.0591333333, 0.3598333333, 0.8683333333),
    (0.0116952381, 0.3875095238, 0.8819571429), (0.0059571429, 0.4086142857, 0.8828428571), (0.0165142857, 0.4266, 0.8786333333), (0.032852381, 0.4430428571, 0.8719571429),
    (0.0498142857, 0.4585714286, 0.8640571429), (0.0629333333, 0.4736904762, 0.8554380952), (0.0722666667, 0.4886666667, 0.8467), (0.0779428571, 0.5039857143, 0.8383714286),
    (0.079347619, 0.5200238095, 0.8311809524), (0.0749428571, 0.5375428571, 0.8262714286), (0.0640571429, 0.5569857143, 0.8239571429), (0.0487714286, 0.5772238095, 0.8228285714),
    (0.0343428571, 0.5965809524, 0.819852381), (0.0265, 0.6137, 0.8135), (0.0238904762, 0.6286619048, 0.8037619048), (0.0230904762, 0.6417857143, 0.7912666667),
    (0.0227714286, 0.6534857143, 0.7767571429), (0.0266619048, 0.6641952381, 0.7607190476), (0.0383714286, 0.6742714286, 0.743552381), (0.0589714286, 0.6837571429, 0.7253857143),
    (0.0843, 0.6928333333, 0.7061666667), (0.1132952381, 0.7015, 0.6858571429), (0.1452714286, 0.7097571429, 0.6646285714), (0.1801333333, 0.7176571429, 0.6424333333),
    (0.2178285714, 0.7250428571, 0.6192619048), (0.2586428571, 0.7317142857, 0.5954285714), (0.3021714286, 0.7376047619, 0.5711857143), (0.3481666667, 0.7424333333, 0.5472666667),
    (0.3952571429, 0.7459, 0.5244428571), (0.4420095238, 0.7480809524, 0.5033142857), (0.4871238095, 0.7490619048, 0.4839761905), (0.5300285714, 0.7491142857, 0.4661142857),
    (0.5708571429, 0.7485190476, 0.4493904762), (0.609852381, 0.7473142857, 0.4336857143), (0.6473, 0.7456, 0.4188), (0.6834190476, 0.7434761905, 0.4044333333),
    (0.7184095238, 0.7411333333, 0.3904761905), (0.7524857143, 0.7384, 0.3768142857), (0.7858428571, 0.7355666667, 0.3632714286), (0.8185047619, 0.7327333333, 0.3497904762),
    (0.8506571429, 0.7299, 0.3360285714), (0.8824333333, 0.7274333333, 0.3217), (0.9139333333, 0.7257857143, 0.3062761905), (0.9449571429, 0.7261142857, 0.2886428571),
    (0.9738952381, 0.7313952381, 0.266647619), (0.9937714286, 0.7454571429, 0.240347619), (0.9990428571, 0.7653142857, 0.2164142857), (0.9955333333, 0.7860571429, 0.196652381),
    (0.988, 0.8066, 0.1793666667), (0.9788571429, 0.8271428571, 0.1633142857), (0.9697, 0.8481380952, 0.147452381), (0.9625857143, 0.8705142857, 0.1309),
    (0.9588714286, 0.8949, 0.1132428571), (0.9598238095, 0.9218333333, 0.0948380952), (0.9661, 0.9514428571, 0.0755333333), (0.9763, 0.9831, 0.0538),
]
MATLAB_LINES = ["#0072BD", "#D95319", "#EDB120", "#7E2F8E", "#77AC30", "#4DBEEE", "#A2142F"]
MATLAB_GROUPS = [
    ("sequential", "MATLAB", ["matlab.parula"]),
    ("qualitative", "MATLAB", ["matlab.lines"]),
]


def matlab_groups():
    EXTRA["matlab.parula"] = LinearSegmentedColormap.from_list("matlab.parula", PARULA, N=N)
    EXTRA["matlab.lines"] = ListedColormap(MATLAB_LINES, name="matlab.lines")
    yield from MATLAB_GROUPS


# R's palettes, as listed by R Charts (r-charts.com/color-palettes), which
# shows the palettes of the paletteer package. scripts/fetch-r-palettes.py
# saved them in scripts/data/r-palettes.json: continuous ones as 30 samples
# (interpolated linearly here), discrete ones with every color (shown as
# steps, like NCL's tables). Names are paletteer's: "ggthemes::Blue".
# paletteer has no types, so the groups are ours: the continuous and the
# stepped ramps by their lightness profile (monotone: sequential; lighter or
# darker in the middle than at both ends: diverging), the discrete sets of
# colors by package, with the exceptions below.
R_FILE = Path(__file__).resolve().parent / "data" / "r-palettes.json"
# RColorBrewer is Matplotlib's ColorBrewer; the viridis package and the
# grDevices copies of viridis and Crameri's maps are in earlier sources.
R_SKIP_PACKAGES = {"RColorBrewer", "viridis"}
# ggsci::default_igv has 51 colors, too many categories for the viewer (32 at most).
R_SKIP = {"ggsci::default_igv"} | {f"grDevices::{n}" for n in ["Viridis", "Plasma", "Inferno", "Cividis", "Lajolla", "Turku", "Broc", "Cork",
                                      "Vik", "Berlin", "Lisbon", "Tofino", "Oslo"]}
# By hand where the lightness rule fails.
R_GROUP = {
    "grDevices::rainbow": "rainbow", "grDevices::topo.colors": "rainbow", "grDevices::terrain.colors": "rainbow",
    "grDevices::cm.colors": "diverging",
    "ggthemes::Blue Light": "sequential", "ggthemes::Orange Light": "sequential",
    "ggthemes::Orange-Blue Light Diverging": "diverging", "ggthemes::Classic Red-Green Light": "diverging",
    "colorBlindness::paletteMartin": "qualitative", "colorBlindness::PairedColor12Steps": "qualitative",
    "dichromat::Categorical_12": "qualitative", "cartography::pastel.pal": "qualitative",
    "colorBlindness::Blue2Green14Steps": "diverging", "dichromat::BluetoGreen_14": "diverging",
    "colorBlindness::SteppedSequential5Steps": "others", "dichromat::SteppedSequential_5": "others",
    "grDevices::blues9": "sequential",
    "ggthemes::Seattle_Grays": "sequential", "ggthemes::Classic_Gray_5": "sequential",
    "cartography::harmo.pal": "qualitative", "cartography::multi.pal": "qualitative",
}
R_BY_LIGHTNESS = {"colorBlindness", "dichromat"}  # discrete packages of ramps
R_PACKAGE_LABEL = {"ggthemes_solarized": "ggthemes Solarized", "ggthemes_ptol": "ggthemes"}


def lightness(rgb):
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    f = lin @ np.array([0.2126, 0.7152, 0.0722])
    f = np.where(f > 0.008856, np.cbrt(f), 7.787 * f + 16 / 116)
    return 116 * f - 16


def r_group(name, kind, rgb):
    if name in R_GROUP:
        return R_GROUP[name]
    pkg = name.split("::")[0]
    if kind == "discrete" and pkg not in R_BY_LIGHTNESS:
        if pkg == "ggsci" and name.endswith("_material"):
            return "sequential"
        if pkg == "ggthemes" and re.search(r"Classic_(Purple_Gray|Green_Orange|Blue_Red)_\d+", name):
            return "diverging"
        return "qualitative"
    if kind == "dynamic":  # cartography's ramps (its three mixed palettes are in R_GROUP); the rest are accents
        return "sequential" if pkg == "cartography" else "qualitative"
    L = lightness(rgb)
    steps = np.diff(L)
    if (steps >= -0.5).mean() >= 0.9 or (steps <= 0.5).mean() >= 0.9:
        return "sequential" if L.max() - L.min() >= 12 or pkg != "grDevices" else "others"
    mid, ends = L[len(L) // 2], (L[0], L[-1])
    if mid - max(ends) > 10 or min(ends) - mid > 10:
        return "diverging"
    return "others"


def r_groups():
    rows = json.loads(R_FILE.read_text())
    blocks = {}
    for kind, name, hexes in rows:
        pkg = name.split("::")[0]
        if pkg in R_SKIP_PACKAGES or name in R_SKIP:
            continue
        rgb = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in hexes]) / 255
        group = r_group(name, kind, rgb)
        assert name not in EXTRA, f"duplicate R palette {name}"
        if group == "qualitative" or kind != "continuous":
            EXTRA[name] = ListedColormap(rgb, name=name)
        else:
            EXTRA[name] = LinearSegmentedColormap.from_list(name, rgb, N=N)
        label = R_PACKAGE_LABEL.get(pkg, pkg)
        sub = f"{label} (R)" if group != "others" else f"{label} (R, miscellaneous)"
        blocks.setdefault((group, sub), []).append(name)
    for (group, sub), names in blocks.items():
        yield group, sub, names


# A map from a later source that matches an earlier one (or its reverse) to
# within 2/255 is not added. Cyclic maps also match when rotated (CET_C1s is
# CET_C1 started a quarter turn later). A short table (ncl.matlab_jet, 64
# colors) is also compared at its own colors: the earlier map is sampled at
# the table's positions, both ends-in and bin centers, within 3/255.
def duplicate_of(rgb, seen, cyclic=False, table=None):
    shifts = range(len(rgb)) if cyclic else [0]
    for name, other in seen.items():
        for flip in (rgb, rgb[::-1]):
            if any(np.abs(np.roll(flip, k, axis=0) - other).max() < 2 / 255 for k in shifts):
                return name
        if table is not None and len(table) < N:
            n = len(table)
            for t in (np.linspace(0, 1, n), (np.arange(n) + 0.5) / n):
                at = np.stack([np.interp(t, X, other[:, c]) for c in range(3)], axis=1)
                if min(np.abs(table - at).max(), np.abs(table[::-1] - at).max()) < 3 / 255:
                    return name
    return None


maps = []
seen = {}  # name -> sampled rgb, for the duplicate check
for source, groups in [("matplotlib", GROUPS), ("cmasher", list(cmasher_groups())),
                       ("crameri", list(crameri_groups())), ("cmocean", list(cmocean_groups())),
                       ("colorcet", list(colorcet_groups())),
                       ("seaborn", list(seaborn_groups())), ("carbonplan", list(carbonplan_groups())),
                       ("ncl", list(ncl_groups())), ("sciviz", list(sciviz_groups())), ("carto", list(carto_groups())),
                       ("matlab", list(matlab_groups())),
                       ("r", list(r_groups()))]:
    for group, sub, names in groups:
        for name in names:
            cmap = EXTRA.get(name) or colormaps[name]
            qualitative = group == "qualitative"
            assert not qualitative or isinstance(cmap, ListedColormap), name
            if not qualitative:
                rgb = cmap(X)[:, :3]
                table = np.asarray(cmap.colors)[:, :3] if isinstance(cmap, ListedColormap) else None
                twin = source != "matplotlib" and duplicate_of(rgb, seen, cyclic=group == "cyclic", table=table)
                if twin:
                    print(f"skipped {name}: same colors as {twin}")
                    continue
                seen[name] = rgb
            else:
                hexes = colors_of(cmap, True)
                twin = next((m["name"] for m in maps if m["colors"] == hexes), None)
                if twin:
                    print(f"skipped {name}: same colors as {twin}")
                    continue
            maps.append({
                "name": name,
                "group": group,
                "sub": sub,
                "source": source,
                "kind": "qualitative" if qualitative else "continuous",
                "colors": colors_of(cmap, qualitative),
            })

# ---- order each sub-heading by similarity ----
# Neighbors in the list should look alike, so a reader scanning a section
# sees families together (blues next to blues). Distance is the mean CIELAB
# ΔE76 at 32 positions, taking the closer of the two directions (and, for
# cyclic maps, of all starting points); qualitative palettes use the mean
# distance from each color to the nearest color of the other palette. The
# order is the shortest path through all maps (greedy from every start,
# then 2-opt), turned so the old first map sits in the top half.

K = 32


def to_lab(rgb):
    rgb = np.asarray(rgb, float)
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    xyz = lin @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    f = xyz / [0.95047, 1, 1.08883]
    f = np.where(f > 0.008856, np.cbrt(f), 7.787 * f + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], 1)


def lab_of(m):
    h = m["colors"]
    rgb = np.array([[int(h[i + k:i + k + 2], 16) for k in (0, 2, 4)] for i in range(0, len(h), 6)]) / 255
    if m["kind"] == "continuous":
        rgb = rgb[np.linspace(0, len(rgb) - 1, K).round().astype(int)]
    return to_lab(rgb)


def distance(a, b, kind, cyclic):
    if kind == "qualitative":
        d = np.linalg.norm(a[:, None] - b[None], axis=2)
        return (d.min(1).mean() + d.min(0).mean()) / 2
    shifts = range(K) if cyclic else [0]
    return min(np.linalg.norm(np.roll(x, k, axis=0) - b, axis=1).mean() for x in (a, a[::-1]) for k in shifts)


def path_length(order, d):
    return sum(d[order[i], order[i + 1]] for i in range(len(order) - 1))


def shortest_path(d):
    n = len(d)
    best = None
    for start in range(n):
        order, left = [start], set(range(n)) - {start}
        while left:
            nxt = min(left, key=lambda j: d[order[-1], j])
            order.append(nxt)
            left.remove(nxt)
        if best is None or path_length(order, d) < path_length(best, d):
            best = order
    improved = True
    while improved:  # 2-opt: reverse any stretch that shortens the path
        improved = False
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                new = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                if path_length(new, d) < path_length(best, d) - 1e-9:
                    best, improved = new, True
    return best


def by_similarity(block):
    if len(block) < 3:
        return block
    labs = [lab_of(m) for m in block]
    kind, cyclic = block[0]["kind"], block[0]["group"] == "cyclic"
    n = len(block)
    d = np.zeros((n, n))
    for i in range(n):
        for j in range(i + 1, n):
            d[i, j] = d[j, i] = distance(labs[i], labs[j], kind, cyclic)
    order = shortest_path(d)
    if order[-1] == 0 or order.index(0) > n - 1 - order.index(0):
        order = order[::-1]  # the old first map stays near the top
    return [block[i] for i in order]


# Sub-headings keep their first-appearance order; maps move only within one.
blocks = {}
for m in maps:
    blocks.setdefault((m["group"], m["sub"]), []).append(m)
maps = [m for block in blocks.values() for m in by_similarity(block)]


# Sequential maps all run dark to light. Maps that start lighter than they
# end get `flip`, and Browse shows them reversed.
for m in maps:
    if m["group"] == "sequential":
        L = lab_of(m)[:, 0]
        if L[-1] < L[0]:
            m["flip"] = True
print(f"pre-reversed {sum('flip' in m for m in maps)} sequential maps")

# In the order of the source filter in colormaps.html.
sources = [
    {"key": "matplotlib", "label": "Matplotlib", "version": matplotlib.__version__},
    {"key": "cmasher", "label": "CMasher", "version": cmasher.__version__},
    {"key": "crameri", "label": "Crameri", "version": cmcrameri.__scm_version__},
    {"key": "cmocean", "label": "cmocean", "version": cmocean.__version__.lstrip("v")},
    {"key": "colorcet", "label": "colorcet", "version": colorcet.__version__},
    {"key": "seaborn", "label": "seaborn", "version": seaborn.__version__},
    {"key": "carbonplan", "label": "CarbonPlan", "version": pkg_version("colormaps")},
    {"key": "ncl", "label": "NCL", "version": pkg_version("colormaps")},
    {"key": "sciviz", "label": "SciVisColor", "version": pkg_version("colormaps")},
    {"key": "carto", "label": "CARTOColors", "version": CARTO_VERSION},
    {"key": "matlab", "label": "MATLAB", "version": "R2014b"},
    {"key": "r", "label": "R packages", "version": "paletteer"},
]


def pack_colors(hexes):
    """Base64 of each channel's difference from the previous color (mod 256).

    Smooth maps become long runs of small numbers, which gzip shrinks to about
    a quarter of the hex strings (100 KB instead of 390 KB for the page).
    """
    b = bytes.fromhex(hexes)
    return base64.b64encode(bytes((b[i] - (b[i - 3] if i >= 3 else 0)) % 256 for i in range(len(b)))).decode()


def packed(m):
    return {("rgb" if k == "colors" else k): (pack_colors(v) if k == "colors" else v) for k, v in m.items()}


# The unpacking side, written into the file. `colors` is unpacked on first use
# into the 6-digit hex strings the viewer, the tests and core/colormap-match.js read.
UNPACK_JS = """\
  function unpackRgb(b64) {
    const s = atob(b64);
    const v = new Uint8Array(s.length);
    let hex = '';
    for (let i = 0; i < s.length; i++) {
      v[i] = (s.charCodeAt(i) + (i >= 3 ? v[i - 3] : 0)) & 255;
      hex += (v[i] < 16 ? '0' : '') + v[i].toString(16);
    }
    return hex;
  }
  for (const m of data.maps) {
    const rgb = m.rgb;
    delete m.rgb;
    let hex = null;
    Object.defineProperty(m, 'colors', { enumerable: true, get: () => (hex ??= unpackRgb(rgb)) });
  }
"""

data = {"sources": sources, "maps": [packed(m) for m in maps]}
out = Path(__file__).resolve().parent.parent / "assets" / "js" / "core" / "colormap-library.js"
out.write_text(
    "// Generated by scripts/export-mpl-colormaps.py; do not edit by hand.\n"
    "// Colors are packed (`rgb`: base64 of per-channel differences, see pack_colors);\n"
    "// `colors` unpacks them into 6-digit hex strings concatenated (256 samples, or the listed colors).\n"
    "(function (CM) {\n"
    "  'use strict';\n"
    f"  const data = {json.dumps(data, separators=(',', ':'))};\n"
    + UNPACK_JS +
    "  CM.cmapData = data;\n"
    "})((globalThis.Colormeris ??= {}));\n"
)
counts = {s["key"]: sum(m["source"] == s["key"] for m in maps) for s in sources}
print(f"wrote {out} ({len(maps)} maps: {counts}; matplotlib {matplotlib.__version__}, cmasher {cmasher.__version__}, Crameri {cmcrameri.__scm_version__}, cmocean {cmocean.__version__}, colorcet {colorcet.__version__}, seaborn {seaborn.__version__}, CarbonPlan, NCL and SciVisColor (colormaps {pkg_version('colormaps')}), CARTOColors {CARTO_VERSION}, MATLAB R2014b)")
