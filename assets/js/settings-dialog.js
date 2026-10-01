(function (CM) {
  'use strict';
  const { HOTKEY_ACTIONS, defaultSettings, normalizeSettings, normalizeCombo, comboFromEvent, findHotkey, formatCombo, buildSettingsZip, readSettingsFile, MATCHING_DEFAULTS } = CM;

  // Settings dialog: agent connection, matching defaults, hotkeys, and
  // settings zips. The settings object is ws.settings (see settings.js for
  // its shape); every change is saved in localStorage at once. The API key
  // is only stored when "Remember" is ticked, otherwise it lasts for this visit.

  const STORE = 'colormeris.settings';
  const OLD_AGENT_STORE = 'colormeris.agent'; // before the dialog, the Agent card saved here

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  function loadStored() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE));
      if (raw) return normalizeSettings(raw);
      const old = JSON.parse(localStorage.getItem(OLD_AGENT_STORE));
      if (old) return normalizeSettings({ agent: { ...old, rememberKey: !!old.key } });
    } catch {
      // Unreadable or unavailable storage: start from the defaults.
    }
    return defaultSettings();
  }

  function setupSettings(ws) {
    const { $, app } = ws;
    const settings = loadStored();
    ws.settings = settings;
    const listeners = [];

    function save() {
      const stored = structuredClone(settings);
      if (!stored.agent.rememberKey) stored.agent.key = '';
      try {
        localStorage.setItem(STORE, JSON.stringify(stored));
        localStorage.removeItem(OLD_AGENT_STORE);
      } catch {
        // Storage can be unavailable (private windows, file://); settings then last for this visit.
      }
    }
    function changed() {
      save();
      for (const fn of listeners) fn(settings);
    }

    // Replace every value (import, reset) in place, so ws.settings stays the same object.
    function replaceAll(next) {
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, next);
      changed();
      fill();
      for (const kind of Object.keys(MATCHING_DEFAULTS)) ws.applyMatching(kind, settings.matching[kind]);
    }

    // ------------------------------------------------------------ dialog

    const dialog = $('settings-dialog');
    function open(tab = null) {
      if (tab) showTab(tab);
      fill();
      if (!dialog.open) dialog.showModal();
    }
    function showTab(name) {
      for (const b of dialog.querySelectorAll('[data-settings-tab]')) b.classList.toggle('active', b.dataset.settingsTab === name);
      for (const p of dialog.querySelectorAll('[data-settings-pane]')) p.hidden = p.dataset.settingsPane !== name;
      stopCapture();
    }
    for (const b of dialog.querySelectorAll('[data-settings-tab]')) b.addEventListener('click', () => showTab(b.dataset.settingsTab));
    $('btn-settings').addEventListener('click', () => open());
    // Clicking the backdrop closes the dialog.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('cancel', (e) => {
      if (capturing) e.preventDefault();
    });
    dialog.addEventListener('close', stopCapture);

    function fill() {
      const a = settings.agent;
      ws.setValue($('agent-key'), a.key);
      $('agent-remember').checked = a.rememberKey;
      ws.setValue($('agent-minconf'), a.minConfidence);
      ws.setValue($('agent-steps'), a.maxSteps);
      ws.setValue($('agent-base'), a.base);
      const hm = settings.matching.heatmap;
      const iv = settings.matching.ivis;
      ws.setValue($('set-hm-distance'), hm.distance);
      ws.setValue($('set-hm-maxde'), hm.maxDeltaE);
      ws.setValue($('set-iv-distance'), iv.distance);
      ws.setValue($('set-iv-maxde'), iv.maxDeltaE);
      ws.setValue($('set-iv-gray'), iv.grayChroma);
      $('matching-note').textContent = matchingNote();
      renderHotkeys();
    }

    // ------------------------------------------------------------ agent

    $('agent-key').addEventListener('input', () => {
      settings.agent.key = $('agent-key').value.trim();
      for (const fn of listeners) fn(settings);
    });
    $('agent-key').addEventListener('change', changed);
    $('agent-remember').addEventListener('change', () => {
      settings.agent.rememberKey = $('agent-remember').checked;
      changed();
    });
    $('agent-base').addEventListener('input', () => {
      settings.agent.base = $('agent-base').value.trim();
      for (const fn of listeners) fn(settings);
    });
    $('agent-base').addEventListener('change', changed);
    bindNumber('agent-minconf', 0, 1, (v) => (settings.agent.minConfidence = v));
    bindNumber('agent-steps', 5, 400, (v) => (settings.agent.maxSteps = Math.round(v)));

    // Numbers apply on change; an empty or invalid entry goes back to the stored value.
    function bindNumber(id, lo, hi, apply) {
      $(id).addEventListener('change', () => {
        const v = Number($(id).value);
        if ($(id).value !== '' && Number.isFinite(v)) {
          apply(Math.min(hi, Math.max(lo, v)));
          changed();
        }
        fill();
      });
    }

    // ------------------------------------------------------------ matching

    function setMatching(kind, key, value) {
      settings.matching[kind][key] = value;
      ws.applyMatching(kind, settings.matching[kind]);
    }
    for (const [id, kind] of [['set-hm-distance', 'heatmap'], ['set-iv-distance', 'ivis']]) {
      $(id).addEventListener('change', (e) => {
        setMatching(kind, 'distance', e.target.value);
        changed();
        fill();
      });
    }
    bindNumber('set-hm-maxde', 0, 1000, (v) => setMatching('heatmap', 'maxDeltaE', v));
    bindNumber('set-iv-maxde', 0, 1000, (v) => setMatching('ivis', 'maxDeltaE', v));
    bindNumber('set-iv-gray', 0, 60, (v) => setMatching('ivis', 'grayChroma', v));
    $('matching-reset').addEventListener('click', () => {
      for (const [kind, defs] of Object.entries(MATCHING_DEFAULTS)) {
        settings.matching[kind] = { ...defs };
        ws.applyMatching(kind, settings.matching[kind]);
      }
      changed();
      fill();
    });

    // Panels of the open project can differ (an opened zip, or the agent's set_settings).
    function matchingNote() {
      if (!app.sourceCanvas) return '';
      const parts = [];
      for (const [kind, label] of [['heatmap', 'heatmap'], ['ivis', 'IVIS']]) {
        const m = settings.matching[kind];
        const n = app.project.panels.filter((p) => p.tool === kind && Object.entries(m).some(([k, v]) => p.settings[k] !== v)).length;
        if (n) parts.push(`${n} ${label} panel${n === 1 ? '' : 's'}`);
      }
      return parts.length ? `In the open project, ${parts.join(' and ')} use other values. They keep them until you change a value of that tool here.` : '';
    }

    // ------------------------------------------------------------ hotkeys

    let capturing = null; // action id waiting for a key
    const label = (combo) => formatCombo(combo, isMac);

    function renderHotkeys() {
      $('hotkey-list').replaceChildren(
        ...HOTKEY_ACTIONS.map((action) => {
          const tr = document.createElement('tr');
          tr.className = capturing === action.id ? 'capturing' : '';
          const name = document.createElement('td');
          name.textContent = action.label;
          const keys = document.createElement('td');
          const combos = settings.hotkeys[action.id] || [];
          if (capturing === action.id) keys.textContent = 'Press a key… (Esc cancels)';
          else if (!combos.length) keys.append(Object.assign(document.createElement('span'), { className: 'muted', textContent: 'none' }));
          else keys.append(...combos.map((c) => Object.assign(document.createElement('kbd'), { textContent: label(c) })));
          const btns = document.createElement('td');
          const change = button(capturing === action.id ? 'Cancel' : 'Change', () => (capturing === action.id ? stopCapture() : startCapture(action.id)));
          const isDefault = JSON.stringify(combos) === JSON.stringify(action.keys);
          const reset = button('Reset', () => setKeys(action.id, [...action.keys]));
          reset.disabled = isDefault;
          reset.title = `Default: ${action.keys.map(label).join(', ')}`;
          const clear = button('Clear', () => setKeys(action.id, []));
          clear.disabled = !combos.length;
          btns.append(change, ' ', reset, ' ', clear);
          tr.append(name, keys, btns);
          return tr;
        }),
      );
    }

    function button(text, onClick) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn small', textContent: text });
      b.addEventListener('click', onClick);
      return b;
    }

    function setKeys(id, keys) {
      settings.hotkeys[id] = keys;
      changed();
      renderHotkeys();
    }

    function startCapture(id) {
      capturing = id;
      renderHotkeys();
    }
    function stopCapture() {
      if (!capturing) return;
      capturing = null;
      renderHotkeys();
    }

    // Capture phase on window, so the key reaches neither the workspace nor the viewer.
    window.addEventListener(
      'keydown',
      (e) => {
        if (!capturing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') return stopCapture();
        const raw = comboFromEvent(e);
        if (!raw) return; // a modifier on its own: wait for the key
        const combo = normalizeCombo(raw);
        if (!combo) {
          ws.toast(`${label(raw)} is fixed and cannot be a hotkey.`, true);
          return;
        }
        const id = capturing;
        const other = findHotkey(settings.hotkeys, combo);
        if (other && other !== id) {
          settings.hotkeys[other] = settings.hotkeys[other].filter((c) => c !== combo);
          ws.toast(`${label(combo)} moved from “${HOTKEY_ACTIONS.find((a) => a.id === other).label}”.`);
        }
        capturing = null;
        setKeys(id, [combo]);
      },
      true,
    );

    $('hotkeys-reset').addEventListener('click', () => {
      stopCapture();
      settings.hotkeys = defaultSettings().hotkeys;
      changed();
      renderHotkeys();
    });

    // Tooltips name the current keys: data-title, with {key} where the keys go
    // (otherwise they are added in parentheses).
    function updateTitles() {
      for (const el of document.querySelectorAll('[data-hotkey]')) {
        const keys = (settings.hotkeys[el.dataset.hotkey] || []).map(label).join(' or ');
        const base = el.dataset.title || '';
        el.title = base.includes('{key}') ? (keys ? base.replace('{key}', keys) : base.replace(/\s*[:(]?\s*\{key\}\)?/, '')) : keys ? `${base} (${keys})` : base;
      }
    }
    listeners.push(updateTitles);
    updateTitles();

    // ------------------------------------------------------------ import / export / reset

    $('settings-export').addEventListener('click', async () => {
      if (!window.JSZip) return ws.toast('Zip library failed to load.', true);
      const includeKey = $('settings-include-key').checked;
      if (includeKey && !settings.agent.key) ws.toast('There is no API key to include.');
      const blob = await buildSettingsZip(window.JSZip, settings, { includeKey });
      ws.download(blob, 'colormeris-settings.zip');
    });

    $('settings-import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        if (!window.JSZip && !/\.json$/i.test(file.name)) throw new Error('Zip library failed to load.');
        const { settings: next, hasKey } = await readSettingsFile(window.JSZip, file, file.name);
        if (!hasKey) next.agent = { ...next.agent, key: settings.agent.key, rememberKey: settings.agent.rememberKey };
        replaceAll(next);
        ws.toast(`Settings imported from ${file.name}${hasKey ? ', with an API key' : ''}.`);
      } catch (err) {
        console.error(err);
        ws.toast(`Could not import settings: ${err.message}`, true);
      }
    });

    $('settings-reset').addEventListener('click', () => {
      if (!confirm('Reset all settings to the defaults? The API key is kept.')) return;
      const next = defaultSettings();
      next.agent.key = settings.agent.key;
      next.agent.rememberKey = settings.agent.rememberKey;
      replaceAll(next);
      ws.toast('Settings reset.');
    });

    fill();
    return {
      get: () => settings,
      save: changed,
      open,
      onChange: (fn) => listeners.push(fn),
    };
  }

  Object.assign(CM, { setupSettings });
})((globalThis.Colormeris ??= {}));
