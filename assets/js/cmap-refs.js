(function (CM) {
  'use strict';

  // Sources of the colormaps shown in colormaps.html, and of the methods used
  // there. citeFor(name) gives the reference keys for one colormap.

  const MPL_URL = 'https://matplotlib.org/stable/users/explain/colors/colormaps.html';

  const REFS = {
    matplotlib: {
      text: 'Hunter JD (2007). Matplotlib: A 2D graphics environment. Computing in Science & Engineering 9(3):90–95. Colormap reference: matplotlib.org.',
      url: MPL_URL,
    },
    cmasher: {
      text: 'van der Velden E (2020). CMasher: Scientific colormaps for making accessible, informative and ‘cmashing’ plots. Journal of Open Source Software 5(46):2004.',
      url: 'https://doi.org/10.21105/joss.02004',
    },
    viridis: {
      text: 'van der Walt S, Smith N (2015). A better default colormap for Matplotlib. SciPy 2015 (viridis, magma, inferno, plasma).',
      url: 'https://bids.github.io/colormap/',
    },
    cividis: {
      text: 'Nuñez JR, Anderton CR, Renslow RS (2018). Optimizing colormaps with consideration for color vision deficiency to enable accurate interpretation of scientific data. PLOS ONE 13(7):e0199239.',
      url: 'https://doi.org/10.1371/journal.pone.0199239',
    },
    colorbrewer: {
      text: 'Harrower M, Brewer CA (2003). ColorBrewer.org: an online tool for selecting colour schemes for maps. The Cartographic Journal 40(1):27–37.',
      url: 'https://doi.org/10.1179/000870403235002042',
    },
    crameri: {
      text: 'Crameri F, Shephard GE, Heron PJ (2020). The misuse of colour in science communication. Nature Communications 11:5444. Scientific colour maps (berlin, managua, vanimo in Matplotlib; the cmc.* maps).',
      url: 'https://doi.org/10.1038/s41467-020-19160-7',
    },
    cmocean: {
      text: 'Thyng KM, Greene CA, Hetland RD, Zimmerle HM, DiMarco SF (2016). True colors of oceanography: guidelines for effective and accurate colormap selection. Oceanography 29(3):9–13.',
      url: 'https://doi.org/10.5670/oceanog.2016.66',
    },
    colorcet: {
      text: 'Kovesi P (2015). Good colour maps: how to design them. arXiv:1509.03700. As packaged in colorcet (HoloViz).',
      url: 'https://colorcet.holoviz.org/',
    },
    carto: {
      text: 'CARTO. CARTOColors: color schemes for maps, version 5.0.2 (CC BY 4.0). Continuous versions here interpolate the 7-step palettes linearly in sRGB.',
      url: 'https://carto.com/carto-colors/',
    },
    scm: {
      text: 'Crameri F (2023). Scientific colour maps, version 8.0.1. Zenodo. Read through the cmcrameri package.',
      url: 'https://doi.org/10.5281/zenodo.8409685',
    },
    coolwarm: {
      text: 'Moreland K (2009). Diverging color maps for scientific visualization. Advances in Visual Computing (ISVC 2009), LNCS 5876:92–103.',
      url: 'https://doi.org/10.1007/978-3-642-10520-3_9',
    },
    twilight: {
      text: 'Bechtold B. twilight, a perceptually uniform cyclic colormap, added in Matplotlib 3.0 (2018).',
      url: 'https://github.com/bastibe/twilight',
    },
    turbo: {
      text: 'Mikhailov A (2019). Turbo, an improved rainbow colormap for visualization. Google Research Blog.',
      url: 'https://research.google/blog/turbo-an-improved-rainbow-colormap-for-visualization/',
    },
    cubehelix: {
      text: 'Green DA (2011). A colour scheme for the display of astronomical intensity images. Bulletin of the Astronomical Society of India 39:289–295.',
      url: 'https://arxiv.org/abs/1108.5083',
    },
    tableau: {
      text: 'Tableau 10 and Tableau 20 categorical palettes (Tableau Software, 2016), as included in Matplotlib 2.0.',
      url: MPL_URL,
    },
    okabeito: {
      text: 'Okabe M, Ito K (2008). Color Universal Design (CUD): how to make figures and presentations that are friendly to colorblind people.',
      url: 'https://jfly.uni-koeln.de/color/',
    },
    cmrmap: {
      text: 'Rappaport C (2009). CMRmap: a colormap that prints well in black and white.',
      url: MPL_URL,
    },
    matlab: {
      text: 'Ports of MATLAB colormaps (jet, hsv, hot, cool, spring, summer, autumn, winter, bone, copper, pink, gray).',
      url: MPL_URL,
    },
    yorick: {
      text: 'Ports of the Yorick colormaps (gist_earth, gist_heat, gist_ncar, gist_rainbow, gist_stern, gist_yarg, gist_gray).',
      url: 'https://github.com/LLNL/yorick',
    },
    gnuplot: {
      text: 'gnuplot rgbformulae color palettes (gnuplot, gnuplot2, ocean, rainbow, afmhot), as ported to Matplotlib.',
      url: 'http://www.gnuplot.info/',
    },
    idl: {
      text: 'IDL color tables (nipy_spectral, prism, flag, terrain, brg, bwr, seismic, binary), as ported to Matplotlib.',
      url: MPL_URL,
    },
    machado: {
      text: 'Machado GM, Oliveira MM, Fernandes LAF (2009). A physiologically-based model for simulation of color vision deficiency. IEEE TVCG 15(6):1291–1298. Used at severity 1.0 in linear RGB for the strips; the CVD tab also uses its partial-severity matrices.',
      url: 'https://doi.org/10.1109/TVCG.2009.113',
    },
    brettel: {
      text: 'Brettel H, Viénot F, Mollon JD (1997). Computerized simulation of color appearance for dichromats. JOSA A 14(10):2647–2655. Used in the CVD tab with libDaltonLens’ sRGB parameters.',
      url: 'https://doi.org/10.1364/JOSAA.14.002647',
    },
    vienot: {
      text: 'Viénot F, Brettel H, Mollon JD (1999). Digital video colourmaps for checking the legibility of displays by dichromats. Color Research & Application 24(4):243–252. Used in the CVD tab for protan and deutan.',
      url: 'https://doi.org/10.1002/(SICI)1520-6378(199908)24:4<243::AID-COL5>3.0.CO;2-3',
    },
    daltonlens: {
      text: 'DaltonLens (2021). Review of open source color blindness simulations. The CVD tab follows its advice: Brettel 1997 for tritan, Machado 2009 for partial severity.',
      url: 'https://daltonlens.org/opensource-cvd-simulation/',
    },
    cielab: {
      text: 'CIE (1976), ISO/CIE 11664-4. CIELAB L* lightness, D65 white point. Grayscale shows each color as the gray of the same L*.',
      url: null,
    },
    ciede2000: {
      text: 'Sharma G, Wu W, Dalal EN (2005). The CIEDE2000 color-difference formula: implementation notes, supplementary test data, and mathematical observations. Color Research & Application 30(1):21–30. Used for ΔE2000.',
      url: 'https://doi.org/10.1002/col.20070',
    },
  };

  const BY_NAME = {};
  const set = (key, names) => names.forEach((n) => (BY_NAME[n] = key));
  set('viridis', ['viridis', 'plasma', 'inferno', 'magma']);
  set('cividis', ['cividis']);
  set('colorbrewer', [
    'Greys', 'Purples', 'Blues', 'Greens', 'Oranges', 'Reds', 'YlOrBr', 'YlOrRd', 'OrRd', 'PuRd', 'RdPu', 'BuPu',
    'GnBu', 'PuBu', 'YlGnBu', 'PuBuGn', 'BuGn', 'YlGn', 'PiYG', 'PRGn', 'BrBG', 'PuOr', 'RdGy', 'RdBu', 'RdYlBu',
    'RdYlGn', 'Spectral', 'Pastel1', 'Pastel2', 'Paired', 'Accent', 'Dark2', 'Set1', 'Set2', 'Set3',
  ]);
  set('crameri', ['berlin', 'managua', 'vanimo']);
  set('coolwarm', ['coolwarm']);
  set('twilight', ['twilight', 'twilight_shifted']);
  set('turbo', ['turbo']);
  set('cubehelix', ['cubehelix']);
  set('tableau', ['tab10', 'tab20', 'tab20b', 'tab20c']);
  set('okabeito', ['okabe_ito']);
  set('cmrmap', ['CMRmap']);
  set('matlab', ['jet', 'hsv', 'hot', 'cool', 'spring', 'summer', 'autumn', 'winter', 'bone', 'copper', 'pink', 'gray']);
  set('yorick', ['gist_earth', 'gist_heat', 'gist_ncar', 'gist_rainbow', 'gist_stern', 'gist_yarg', 'gist_gray']);
  set('gnuplot', ['gnuplot', 'gnuplot2', 'ocean', 'rainbow', 'afmhot']);
  set('idl', ['nipy_spectral', 'prism', 'flag', 'terrain', 'brg', 'bwr', 'seismic', 'binary']);

  // CMasher maps (cmr.*) cite CMasher, Crameri maps (cmc.*) the paper and the release, CARTOColors (carto.*) CARTO, cmocean (cmo.*) Thyng et al., colorcet (cet_*) Kovesi. The others come from Matplotlib, with
  // the original source (if any) first.
  function citeFor(name) {
    if (name.startsWith('cmr.')) return ['cmasher'];
    if (name.startsWith('cmc.')) return ['crameri', 'scm'];
    if (name.startsWith('carto.')) return ['carto'];
    if (name.startsWith('cmo.')) return ['cmocean'];
    if (name.startsWith('cet_')) return ['colorcet'];
    const key = BY_NAME[name];
    return key ? [key, 'matplotlib'] : ['matplotlib'];
  }

  Object.assign(CM, { CMAP_REFS: REFS, citeFor });
})((globalThis.Colormeris ??= {}));
