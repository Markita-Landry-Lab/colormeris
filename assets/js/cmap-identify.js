(function (CM) {
  'use strict';
  const { rgbToLab, deltaE2000, deltaE76 } = CM;

  // Which known colormap is this? Two ways for the colormap viewer:
  //   identifyColorbar   colors sampled along a colorbar, start → end. Also
  //                      tells the direction (reversed or not).
  //   identifyColors     loose colors, e.g. the pixels of a heatmap without its
  //                      colorbar. Cannot tell the direction.
  // Maps are { name, kind, rgbs } with rgbs 0–255 sRGB in colormap order.
  // Both return all maps, best first; scores are ΔE2000.

  const MATCH_N = 48; // points compared along the bar
  // The sampled line may overshoot into the frame or labels, so up to 6% is
  // trimmed off each end and the best trim kept.
  const TRIMS = [0, 0.02, 0.04, 0.06];
  const KEEP = 0.9; // scores ignore the worst 10% (tick marks, blur at block edges)
  // Score (ΔE2000) below `exact` is the same map (sampling noise and JPEG
  // artifacts add ≈ 1–3); below `close` a near relative.
  const MATCH_LEVELS = { exact: 3, close: 6 };

  // Color of a map at position t in [0, 1]: interpolated for continuous maps,
  // the block it falls in for qualitative ones (as a discrete colorbar shows it).
  function colorAt(map, t) {
    const c = map.rgbs;
    const n = c.length;
    if (map.kind === 'qualitative') return c[Math.min(n - 1, Math.floor(t * n))];
    const x = Math.max(0, Math.min(1, t)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(x));
    const f = x - i;
    return [0, 1, 2].map((k) => c[i][k] + f * (c[i + 1][k] - c[i][k]));
  }

  function sampleAt(rgbs, t) {
    const x = t * (rgbs.length - 1);
    const i = Math.min(rgbs.length - 2, Math.floor(x));
    const f = x - i;
    return [0, 1, 2].map((k) => rgbs[i][k] + f * (rgbs[i + 1][k] - rgbs[i][k]));
  }

  // Mean of the smallest KEEP share of the values.
  function robustMean(values) {
    const v = values.slice().sort((a, b) => a - b);
    const k = Math.max(1, Math.round(v.length * KEEP));
    let s = 0;
    for (let i = 0; i < k; i++) s += v[i];
    return s / k;
  }

  // samples: [[r, g, b], …] along the bar, at least 2.
  // Returns [{ name, reversed, score, mean, max, trim: [start, end] }].
  function identifyColorbar(samples, maps, { n = MATCH_N } = {}) {
    if (samples.length < 2) return [];
    const ts = Array.from({ length: n }, (_, i) => i / (n - 1));
    // Sample colors for each trim pair, as Lab.
    const trimmed = [];
    for (const a of TRIMS) {
      for (const b of TRIMS) {
        const labs = ts.map((t) => rgbToLab(sampleAt(samples, a + t * (1 - a - b))));
        trimmed.push({ trim: [a, b], labs });
      }
    }
    const out = [];
    for (const map of maps) {
      const fwd = ts.map((t) => rgbToLab(colorAt(map, t)));
      for (const reversed of [false, true]) {
        const ref = reversed ? fwd.slice().reverse() : fwd;
        let best = null;
        for (const { trim, labs } of trimmed) {
          const d = labs.map((lab, i) => deltaE2000(lab, ref[i]));
          const score = robustMean(d);
          if (!best || score < best.score) best = { score, d, trim };
        }
        out.push({
          name: map.name,
          reversed,
          score: best.score,
          mean: best.d.reduce((x, y) => x + y, 0) / n,
          max: Math.max(...best.d),
          trim: best.trim,
        });
      }
    }
    return out.sort((x, y) => x.score - y.score);
  }

  // Many loose colors (pixels). Repeated colors are counted once, so a large
  // area of one value does not outweigh the rest, and white, black and gray
  // pixels (background, text, axes) are left out unless the image has little
  // else. Each color is matched to the nearest color of each map.
  // Returns [{ name, score, coverage }]: coverage is the share of the map
  // (64 points) that has a color in the image nearby, so a map that fits but
  // is barely used can be told from one whose whole range appears.
  const COVER_DE = 6;

  function distinctColors(pixels, max = 1500) {
    const seen = new Map();
    for (const p of pixels) {
      const key = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3);
      if (!seen.has(key)) seen.set(key, p);
    }
    let list = [...seen.values()];
    if (list.length > max) {
      const step = list.length / max;
      list = Array.from({ length: max }, (_, i) => list[Math.floor(i * step)]);
    }
    return list;
  }

  function isNeutral(lab) {
    return Math.hypot(lab[1], lab[2]) < 4 && (lab[0] > 94 || lab[0] < 6);
  }

  function identifyColors(pixels, maps) {
    let labs = distinctColors(pixels).map((p) => rgbToLab(p));
    const colored = labs.filter((l) => !isNeutral(l));
    if (colored.length >= Math.max(8, labs.length * 0.1)) labs = colored;
    if (!labs.length) return [];
    const out = [];
    for (const map of maps) {
      const ref = map.kind === 'qualitative'
        ? map.rgbs.map((c) => rgbToLab(c))
        : Array.from({ length: 64 }, (_, i) => rgbToLab(colorAt(map, i / 63)));
      const covered = new Array(ref.length).fill(false);
      const d = labs.map((lab) => {
        // Nearest by ΔE76 (fast), then the ΔE2000 to that color.
        let bi = 0;
        let bd = Infinity;
        for (let i = 0; i < ref.length; i++) {
          const e = deltaE76(lab, ref[i]);
          if (e < bd) { bd = e; bi = i; }
        }
        const e = deltaE2000(lab, ref[bi]);
        if (e < COVER_DE) covered[bi] = true;
        return e;
      });
      out.push({ name: map.name, score: robustMean(d), coverage: covered.filter(Boolean).length / ref.length });
    }
    return out.sort((x, y) => x.score - y.score);
  }

  // 'exact' | 'close' | 'none' for a score.
  function matchLevel(score) {
    return score < MATCH_LEVELS.exact ? 'exact' : score < MATCH_LEVELS.close ? 'close' : 'none';
  }

  // 'rrggbb…' → [[r, g, b], …]. Kept here so the heatmap page needs no cvd.js.
  function unpack(hex) {
    const out = [];
    for (let i = 0; i + 6 <= hex.length; i += 6) out.push([0, 2, 4].map((k) => parseInt(hex.slice(i + k, i + k + 2), 16)));
    return out;
  }

  // The maps of cmap-data.js in the form above, parsed once.
  let known = null;
  function knownMaps() {
    if (!known && CM.cmapData) {
      known = CM.cmapData.maps.map((m) => ({ name: m.name, kind: m.kind, source: m.source, rgbs: unpack(m.colors) }));
    }
    return known || [];
  }

  // A reference colormap for a calibrated colorbar (heatmap and IVIS tools).
  //   rgbs        colors sampled from the bar's start to its end
  //   lowAtStart  true / false when the ticks say which end has the lower
  //               values, null when unknown
  // Returns null without colormap data, else { name, mplName ('viridis' or
  // 'viridis_r'), source ('matplotlib', 'cmasher'), reversed, byValue, score, level, same: [names with the same
  // colors] }. With byValue, reversed is relative to rising values (as
  // matplotlib names it); otherwise relative to start → end.
  function suggestColormap(rgbs, { lowAtStart = null } = {}) {
    const maps = knownMaps();
    if (!maps.length || rgbs.length < 2) return null;
    const ranked = identifyColorbar(rgbs, maps);
    const best = ranked[0];
    const byValue = lowAtStart != null;
    const flip = (r) => (lowAtStart === false ? !r : r);
    const name = (m) => `${m.name}${flip(m.reversed) ? '_r' : ''}`;
    const same = ranked.slice(1).filter((m) => m.score - best.score < 0.01).map(name);
    return {
      name: best.name,
      mplName: name(best),
      source: knownMaps().find((m) => m.name === best.name).source,
      reversed: flip(best.reversed),
      byValue,
      score: best.score,
      level: matchLevel(best.score),
      same,
    };
  }

  Object.assign(CM, { identifyColorbar, identifyColors, matchLevel, MATCH_LEVELS, suggestColormap, cmapColorAt: colorAt });
})((globalThis.Colormeris ??= {}));
