(function (CM) {
  'use strict';

  // Color space conversions and perceptual color differences.
  // All RGB values are 0–255 sRGB; Lab is CIELAB with a D65 white point.

  const WHITE_D65 = [0.95047, 1.0, 1.08883];

  function srgbToLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(v) {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  }

  function labF(t) {
    return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  }

  function labFInv(t) {
    const t3 = t * t * t;
    return t3 > 216 / 24389 ? t3 : (116 * t - 16) / (24389 / 27);
  }

  function rgbToLab([r, g, b]) {
    const R = srgbToLinear(r);
    const G = srgbToLinear(g);
    const B = srgbToLinear(b);
    const X = 0.4124564 * R + 0.3575761 * G + 0.1804375 * B;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
    const Z = 0.0193339 * R + 0.119192 * G + 0.9503041 * B;
    const fx = labF(X / WHITE_D65[0]);
    const fy = labF(Y / WHITE_D65[1]);
    const fz = labF(Z / WHITE_D65[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function labToRgb([L, a, b]) {
    const fy = (L + 16) / 116;
    const fx = fy + a / 500;
    const fz = fy - b / 200;
    const X = labFInv(fx) * WHITE_D65[0];
    const Y = labFInv(fy) * WHITE_D65[1];
    const Z = labFInv(fz) * WHITE_D65[2];
    const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
    const G = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
    const B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
    return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
  }

  function deltaE76(lab1, lab2) {
    const dL = lab1[0] - lab2[0];
    const da = lab1[1] - lab2[1];
    const db = lab1[2] - lab2[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  // CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. Written for speed
  // (sqrt instead of hypot, products instead of pow, no closures): the
  // colormap ratings call it about 10 000 times per map.
  const RAD = Math.PI / 180;
  const POW25_7 = 25 ** 7;

  function hueDeg(b, ap) {
    if (b === 0 && ap === 0) return 0;
    const h = Math.atan2(b, ap) / RAD;
    return h >= 0 ? h : h + 360;
  }

  function deltaE2000(lab1, lab2) {
    const L1 = lab1[0];
    const a1 = lab1[1];
    const b1 = lab1[2];
    const L2 = lab2[0];
    const a2 = lab2[1];
    const b2 = lab2[2];

    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const Cbar = (C1 + C2) / 2;
    const Cbar3 = Cbar * Cbar * Cbar;
    const Cbar7 = Cbar3 * Cbar3 * Cbar;
    const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);
    const h1p = hueDeg(b1, a1p);
    const h2p = hueDeg(b2, a2p);

    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    const chroma = C1p * C2p !== 0;
    let dhp = 0;
    if (chroma) {
      dhp = h2p - h1p;
      if (dhp > 180) dhp -= 360;
      else if (dhp < -180) dhp += 360;
    }
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * RAD);

    const Lbarp = (L1 + L2) / 2;
    const Cbarp = (C1p + C2p) / 2;
    let hbarp = h1p + h2p;
    if (chroma) {
      if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
      else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
      else hbarp = (h1p + h2p - 360) / 2;
    }

    const T =
      1 -
      0.17 * Math.cos((hbarp - 30) * RAD) +
      0.24 * Math.cos(2 * hbarp * RAD) +
      0.32 * Math.cos((3 * hbarp + 6) * RAD) -
      0.2 * Math.cos((4 * hbarp - 63) * RAD);
    const hx = (hbarp - 275) / 25;
    const dTheta = 30 * Math.exp(-hx * hx);
    const Cbarp3 = Cbarp * Cbarp * Cbarp;
    const Cbarp7 = Cbarp3 * Cbarp3 * Cbarp;
    const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
    const Lm = (Lbarp - 50) * (Lbarp - 50);
    const Sl = 1 + (0.015 * Lm) / Math.sqrt(20 + Lm);
    const Sc = 1 + 0.045 * Cbarp;
    const Sh = 1 + 0.015 * Cbarp * T;
    const Rt = -Math.sin(2 * dTheta * RAD) * Rc;

    const tL = dLp / Sl;
    const tC = dCp / Sc;
    const tH = dHp / Sh;
    return Math.sqrt(tL * tL + tC * tC + tH * tH + Rt * tC * tH);
  }

  function colorDistance(name) {
    return name === 'de76' ? deltaE76 : deltaE2000;
  }

  function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }

  Object.assign(CM, { srgbToLinear, linearToSrgb, rgbToLab, labToRgb, deltaE76, deltaE2000, colorDistance, rgbToHex });
})((globalThis.Colormeris ??= {}));
