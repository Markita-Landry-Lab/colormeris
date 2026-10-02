(function (CM) {
  'use strict';

  // References and the footer of the colormap viewer: "About the ratings,
  // methods and references". References are numbered in order of first use
  // in the list, so the footer is built after the rows.
  function setupCmapFooter(ctx) {
    const { el, data, RATING_COLS } = ctx;

    const refOrder = []; // keys in order of first appearance in the list
    const refNumber = (key) => {
      let i = refOrder.indexOf(key);
      if (i < 0) { refOrder.push(key); i = refOrder.length - 1; }
      return i + 1;
    };

    // `id` is left out for copies (the detail view), so the footer keeps the anchors.
    function refItem(k, { id = true } = {}) {
      const ref = CM.CMAP_REFS[k];
      const li = el('li', id ? { id: `ref-${k}` } : {});
      li.append(ref.text);
      if (ref.url) {
        li.append(' ');
        li.append(el('a', { href: ref.url, target: '_blank', rel: 'noopener' }, 'Link'));
      }
      return li;
    }

    // How each rating is made; in the "?" popover of the list and in the footer.
    function methodList() {
      const text = CM.ratingMethod();
      const ul = el('ul');
      for (const c of RATING_COLS) {
        const li = el('li');
        li.append(el('strong', {}, `${c.label}. `), text[c.key]);
        ul.append(li);
      }
      return ul;
    }

    function buildFooter() {
      const d = el('details', { class: 'cmap-about', id: 'cmap-about' });
      d.append(el('summary', {}, 'About the ratings, methods and references'));
      d.append(el('h3', {}, 'How the ratings work'));
      d.append(el('p', {}, 'Each colormap gets up to four ratings: yes (✓), partly (~) or no (✕). They are rules of thumb tuned on the Matplotlib maps, not standards. Hover a rating for the numbers.'));
      d.append(methodList());
      const p = el('p', { class: 'muted' }, 'A ΔE2000 of about 2 is roughly the smallest difference you notice side by side. Color differences use CIEDE2000 (');
      p.append(el('a', { href: '#ref-ciede2000' }, 'Sharma, Wu & Dalal 2005'), ').');
      d.append(p);

      d.append(el('h3', {}, 'References'));
      const ol = el('ol');
      for (const k of refOrder) ol.append(refItem(k));
      d.append(ol);
      d.append(el('h3', {}, 'Methods'));
      d.append(el('p', { class: 'muted' }, 'CVD views simulate Machado et al. (2009) at full severity in linear RGB, the same model matplotlib’s docs use via colorspacious. Grayscale is each color’s CIELAB L*. Color differences are CIEDE2000 (ΔE2000). The CVD tab also offers Brettel et al. (1997) and Viénot et al. (1999), and Machado et al. at partial severity, following the DaltonLens review.'));
      const ol2 = el('ol', { start: String(refOrder.length + 1) });
      for (const k of ['machado', 'cielab', 'ciede2000', 'brettel', 'vienot', 'daltonlens']) ol2.append(refItem(k));
      d.append(ol2);
      // A family whose members share one version (the R packages, from paletteer) is named once;
      // the Python packages each have their own.
      const shared = (fam) => new Set(data.sources.filter((s) => s.family === fam).map((s) => s.version)).size === 1;
      const versions = [...new Map(data.sources.map((src) => src.family && shared(src.family)
        ? [src.family, `${src.family} (${src.version})`]
        : [src.key, `${src.label} ${src.version}`])).values()];
      d.append(el('p', { class: 'muted small' }, `Colormap data comes from ${versions.slice(0, -1).join(', ')}${versions.length > 1 ? ' and ' : ''}${versions.at(-1)}.`));
      return d;
    }

    return { refNumber, refItem, methodList, buildFooter };
  }

  Object.assign(CM, { setupCmapFooter });
})((globalThis.Colormeris ??= {}));
