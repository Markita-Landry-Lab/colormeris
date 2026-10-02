"""Write scripts/data/r-palettes.json from https://r-charts.com/color-palettes/.

Run:  python3 scripts/fetch-r-palettes.py

The page shows every palette of R's paletteer package that R Charts lists,
with its colors as hex codes: continuous ones (paletteer_c) as 30 samples,
discrete and dynamic ones with all their colors. Each color run is followed by
the call that made it, e.g. paletteer_c("ggthemes::Blue", 30). The result is
a list of [kind, "package::name", [hex, ...]], kept in the repository so
export-mpl-colormaps.py needs no network for it.
"""
import json
import re
import urllib.request
from pathlib import Path

URL = "https://r-charts.com/color-palettes/"
req = urllib.request.Request(URL, headers={"User-Agent": "colormeris-export"})
html = urllib.request.urlopen(req).read().decode()
html = re.sub(r"<script.*?</script>", "", html, flags=re.S)

out, run = [], []
for color, kind, name in re.findall(r'data-clipboard-text="(#[0-9A-Fa-f]{6})"|paletteer_(\w+)\(&#34;([^&]+)&#34;', html):
    if color:
        run.append(color.lower())
    else:
        out.append([{"c": "continuous", "d": "discrete", "dynamic": "dynamic"}[kind], name, run])
        run = []
assert not run and len(out) > 450, f"parsed {len(out)} palettes"
path = Path(__file__).resolve().parent / "data" / "r-palettes.json"
path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"wrote {path} ({len(out)} palettes)")
