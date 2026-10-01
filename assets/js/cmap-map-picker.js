(function (CM) {
  'use strict';

  // A text field that filters the colormaps as you type (an ARIA combobox),
  // shared by Recolor (pick the new map) and Compare (add maps). Empty, it
  // lists them all in their groups. Typing "name_r" counts as the reversed map.
  // Leaving it with text that names no map puts the text back.
  //
  // opts: id (unique), label, placeholder,
  //   current(): the name the field shows when idle, or null to stay empty,
  //   onChoose(name, typedReversed): called when a map is picked.

  const GROUPS = [
    ['sequential', 'Sequential'],
    ['diverging', 'Diverging'],
    ['cyclic', 'Cyclic'],
    ['rainbow', 'Rainbow'],
    ['others', 'Others'],
  ];

  function createMapPicker(ctx, opts) {
    const { el, data, mapByName, base, stripSvg } = ctx;
    const listId = `${opts.id}-maps`;
    const box = el('div', { class: 'cmap-rc-pick' });
    const input = el('input', {
      type: 'text', role: 'combobox', 'aria-label': opts.label, 'aria-autocomplete': 'list',
      'aria-expanded': 'false', 'aria-controls': listId, autocomplete: 'off', spellcheck: 'false', placeholder: opts.placeholder || 'Type to search',
    });
    const idle = () => opts.current() || '';
    input.value = idle();
    const list = el('ul', { class: 'cmap-rc-maps', id: listId, role: 'listbox', 'aria-label': 'Colormaps', hidden: '' });
    box.append(input, list);
    const groupOf = new Map(GROUPS);
    let options = []; // the li elements shown, in order
    let active = -1;

    const optionFor = (m) => {
      const li = el('li', { role: 'option', id: `${listId}-${m.name}`, 'aria-selected': String(m.name === opts.current()) });
      li.dataset.name = m.name;
      const mini = el('span', { class: 'cmap-mini' });
      mini.innerHTML = stripSvg(base(m), m.kind === 'qualitative');
      li.append(mini, el('span', { class: 'cmap-rc-opt-name' }, m.name));
      // mousedown, not click, so the input keeps the focus.
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(m.name); });
      return li;
    };

    // Name matches first that start with the text, then any that contain it.
    function fill(text) {
      const q = text.trim().toLowerCase().replace(/_r$/, '');
      list.replaceChildren();
      options = [];
      if (!q) {
        for (const [group, title] of GROUPS) {
          const maps = data.maps.filter((m) => m.group === group);
          if (!maps.length) continue;
          list.append(el('li', { class: 'cmap-rc-group', role: 'presentation' }, title));
          for (const m of maps) options.push(list.appendChild(optionFor(m)));
        }
      } else {
        const lower = (m) => m.name.toLowerCase();
        const hits = [
          ...data.maps.filter((m) => lower(m).startsWith(q)),
          ...data.maps.filter((m) => !lower(m).startsWith(q) && lower(m).includes(q)),
        ];
        for (const m of hits) {
          const li = optionFor(m);
          li.append(el('span', { class: 'cmap-rc-opt-group' }, groupOf.get(m.group) || ''));
          options.push(list.appendChild(li));
        }
        if (!hits.length) list.append(el('li', { class: 'cmap-rc-none', role: 'presentation' }, 'No colormap matches'));
      }
      const at = options.findIndex((o) => o.dataset.name === opts.current());
      setActive(q ? 0 : at);
    }

    function setActive(i) {
      options[active]?.classList.remove('active');
      active = options.length ? Math.max(-1, Math.min(options.length - 1, i)) : -1;
      const o = options[active];
      if (o) {
        o.classList.add('active');
        input.setAttribute('aria-activedescendant', o.id);
        o.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function open(text) {
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      fill(text);
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function choose(name) {
      const typedReversed = /_r$/i.test(input.value.trim()) && !mapByName.has(input.value.trim());
      close();
      opts.onChoose(name, typedReversed);
      input.value = idle();
    }

    // An exact name (any case, with or without _r) counts as chosen.
    function exact(text) {
      const q = text.trim().toLowerCase();
      const find = (n) => data.maps.find((m) => m.name.toLowerCase() === n);
      return find(q) || find(q.replace(/_r$/, ''));
    }

    // Focused with nothing typed: show all, so the list is a menu.
    input.addEventListener('focus', () => { input.select(); open(''); });
    input.addEventListener('click', () => { if (list.hidden) open(''); });
    input.addEventListener('input', () => open(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { open(input.value === idle() ? '' : input.value); return; }
        setActive(active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        if (list.hidden) return;
        e.preventDefault();
        const m = options[active] ? mapByName.get(options[active].dataset.name) : exact(input.value);
        if (m) choose(m.name);
      } else if (e.key === 'Escape') {
        if (list.hidden) return;
        e.preventDefault();
        input.value = idle();
        close();
      }
    });
    input.addEventListener('blur', () => {
      const m = input.value.trim() && input.value !== idle() ? exact(input.value) : null;
      if (m) choose(m.name);
      else { input.value = idle(); close(); }
    });
    return { box, input };
  }

  Object.assign(CM, { createMapPicker });
})((globalThis.Colormeris ??= {}));
