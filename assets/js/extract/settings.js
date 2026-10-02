(function (CM) {
  'use strict';

  // App settings (pure): the agent connection, matching defaults per tool and
  // hotkeys. Kept in localStorage by settings-dialog.js and saved to or read
  // from a settings zip (settings.json inside). Unlike project.json these
  // belong to the user, not to a figure.

  const SETTINGS_SCHEMA = 'colormeris-settings';
  const SETTINGS_VERSION = 1;
  const SETTINGS_FILE = 'settings.json';

  // Hotkeys. A combo is a string such as "G", "Mod+Shift+Z" or "ArrowLeft";
  // Mod is Ctrl, or ⌘ on a Mac. An action can have several combos.
  // `tool` limits an action to one tool; `always` also runs it before a file is open.
  const HOTKEY_ACTIONS = [
    { id: 'undo', label: 'Undo', keys: ['Mod+Z'], always: true },
    { id: 'redo', label: 'Redo', keys: ['Mod+Shift+Z', 'Mod+Y'], always: true },
    { id: 'grid', label: 'Place grid corners', keys: ['G'] },
    { id: 'colorbar', label: 'Place colorbar ends', keys: ['B'] },
    { id: 'ticks', label: 'Add ticks', keys: ['T'] },
    { id: 'fit', label: 'Fit to view', keys: ['F'] },
    { id: 'zoomIn', label: 'Zoom in', keys: ['=', '+'] },
    { id: 'zoomOut', label: 'Zoom out', keys: ['-'] },
    { id: 'crosshair', label: 'Crosshair', keys: ['C'] },
    { id: 'prevPage', label: 'Previous page', keys: ['ArrowLeft'] },
    { id: 'nextPage', label: 'Next page', keys: ['ArrowRight'] },
    { id: 'ellipse', label: 'Ellipse region (ROI)', keys: ['E'], tool: 'roi' },
    { id: 'rect', label: 'Rectangle region (ROI)', keys: ['R'], tool: 'roi' },
    { id: 'polygon', label: 'Polygon region (ROI)', keys: ['P'], tool: 'roi' },
    { id: 'xtick', label: 'Add x-axis ticks (Map)', keys: ['X'], tool: 'map' },
    { id: 'ytick', label: 'Add y-axis ticks (Map)', keys: ['Y'], tool: 'map' },
    { id: 'profile', label: 'Draw a line profile (Map)', keys: ['L'], tool: 'map' },
  ];
  // Keys with a fixed meaning: cancel, pan, and finishing or editing a polygon.
  const RESERVED_KEYS = ['Escape', 'Space', 'Enter', 'Backspace', 'Delete', 'Tab'];

  const MATCHING_DEFAULTS = {
    heatmap: { distance: 'de2000', maxDeltaE: 10 },
    // IVIS photos carry JPEG color noise up to about chroma 20 (see project.js).
    roi: { distance: 'de2000', maxDeltaE: 20, grayChroma: 20 },
    map: { distance: 'de2000', maxDeltaE: 10 },
  };

  const AGENT_DEFAULTS = { key: '', rememberKey: false, minConfidence: 0.9, maxSteps: 80, base: '', llm: '', reviewer: '' };

  function defaultSettings() {
    return {
      agent: { ...AGENT_DEFAULTS },
      matching: structuredClone(MATCHING_DEFAULTS),
      hotkeys: Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a.id, [...a.keys]])),
    };
  }

  const num = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);

  // Settings from any JSON-ish input; missing or bad values fall back to the defaults.
  function normalizeSettings(raw) {
    const out = defaultSettings();
    if (!raw || typeof raw !== 'object') return out;
    const a = raw.agent || {};
    const d = out.agent;
    out.agent = {
      key: str(a.key),
      rememberKey: typeof a.rememberKey === 'boolean' ? a.rememberKey : d.rememberKey,
      minConfidence: num(a.minConfidence, 0, 1, d.minConfidence),
      maxSteps: Math.round(num(a.maxSteps, 5, 400, d.maxSteps)),
      base: str(a.base),
      llm: str(a.llm),
      reviewer: str(a.reviewer),
    };
    for (const [kind, defs] of Object.entries(MATCHING_DEFAULTS)) {
      const m = raw.matching?.[kind] || {};
      const t = out.matching[kind];
      t.distance = m.distance === 'de76' || m.distance === 'de2000' ? m.distance : defs.distance;
      t.maxDeltaE = num(m.maxDeltaE, 0, 1000, defs.maxDeltaE);
      if ('grayChroma' in defs) t.grayChroma = num(m.grayChroma, 0, 60, defs.grayChroma);
    }
    const hk = raw.hotkeys || {};
    for (const action of HOTKEY_ACTIONS) {
      const keys = hk[action.id];
      if (!Array.isArray(keys)) continue;
      out.hotkeys[action.id] = [...new Set(keys.map(normalizeCombo).filter(Boolean))];
    }
    return out;
  }

  // ---------------------------------------------------------------- hotkeys

  const MODIFIERS = ['Mod', 'Alt', 'Shift'];

  // Canonical form of a combo: modifiers in a fixed order, letters upper case.
  // Returns '' for a combo that cannot be a hotkey.
  function normalizeCombo(combo) {
    if (typeof combo !== 'string') return '';
    // "Mod++" is Mod and the plus key.
    const parts = combo.trim().split(/\+(?=.)/);
    const key = parts.pop();
    const mods = new Set(parts.map((p) => ({ ctrl: 'Mod', cmd: 'Mod', meta: 'Mod', mod: 'Mod', alt: 'Alt', option: 'Alt', shift: 'Shift' })[p.toLowerCase()]));
    if (mods.has(undefined) || !key) return '';
    const k = key.length === 1 ? key.toUpperCase() : key === ' ' ? 'Space' : key;
    if (RESERVED_KEYS.includes(k) && !mods.size) return '';
    return [...MODIFIERS.filter((m) => mods.has(m)), k].join('+');
  }

  // Combo of a keydown event, or '' for a lone modifier key. Shift only counts
  // for letters and named keys, since for other characters it changes the
  // character itself ("+" is Shift and "=" on many keyboards).
  function comboFromEvent(e) {
    let key = e.key;
    if (!key || ['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(key)) return '';
    // Alt changes the character on a Mac (Alt+G types ©), so take the key's name from its position.
    const code = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
    if (e.altKey && code) key = code[1] || code[2];
    if (key === ' ') key = 'Space';
    const letter = /^[a-z]$/i.test(key);
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('Mod');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey && (letter || key.length > 1)) mods.push('Shift');
    return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
  }

  // Id of the action bound to a combo, or null.
  function findHotkey(hotkeys, combo) {
    if (!combo) return null;
    for (const [id, keys] of Object.entries(hotkeys || {})) if (keys.includes(combo)) return id;
    return null;
  }

  const KEY_NAMES = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down' };
  // Human-readable combo: "Ctrl+Shift+Z", or "⌘⇧Z" on a Mac.
  function formatCombo(combo, mac = false) {
    const parts = combo.split(/\+(?=.)/);
    const key = parts.pop();
    const k = KEY_NAMES[key] || key;
    if (mac) return parts.map((m) => ({ Mod: '⌘', Alt: '⌥', Shift: '⇧' })[m]).join('') + k;
    return [...parts.map((m) => (m === 'Mod' ? 'Ctrl' : m)), k].join('+');
  }

  // ---------------------------------------------------------------- file

  // JSON of a settings file. The API key is only included when asked for.
  function serializeSettings(settings, { includeKey = false } = {}) {
    const s = normalizeSettings(settings);
    const agent = { ...s.agent };
    if (!includeKey) {
      delete agent.key;
      delete agent.rememberKey;
    }
    return { schema: SETTINGS_SCHEMA, version: SETTINGS_VERSION, exportedAt: new Date().toISOString(), ...s, agent };
  }

  // Settings from a settings file's JSON. `hasKey` tells whether the file
  // carried an API key; without one the caller keeps the current key.
  function parseSettings(json) {
    if (!json || typeof json !== 'object' || json.schema !== SETTINGS_SCHEMA) throw new Error('Not a Colormeris settings file.');
    if (json.version > SETTINGS_VERSION) throw new Error(`Settings version ${json.version} is newer than this app understands (${SETTINGS_VERSION}).`);
    return { settings: normalizeSettings(json), hasKey: typeof json.agent?.key === 'string' && json.agent.key.trim() !== '' };
  }

  async function buildSettingsZip(JSZip, settings, opts) {
    const zip = new JSZip();
    zip.file(SETTINGS_FILE, JSON.stringify(serializeSettings(settings, opts), null, 2));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  }

  // Reads a settings zip, or a bare settings.json.
  async function readSettingsFile(JSZip, blob, name = '') {
    let text;
    if (/\.json$/i.test(name)) text = await blob.text();
    else {
      const zip = await JSZip.loadAsync(blob);
      const entry = zip.file(SETTINGS_FILE) || zip.file(/(^|\/)settings\.json$/)[0];
      if (!entry) throw new Error(`No ${SETTINGS_FILE} in the zip.`);
      text = await entry.async('string');
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${SETTINGS_FILE} is not valid JSON.`);
    }
    return parseSettings(json);
  }

  Object.assign(CM, {
    SETTINGS_SCHEMA,
    SETTINGS_VERSION,
    SETTINGS_FILE,
    HOTKEY_ACTIONS,
    RESERVED_KEYS,
    MATCHING_DEFAULTS,
    defaultSettings,
    normalizeSettings,
    normalizeCombo,
    comboFromEvent,
    findHotkey,
    formatCombo,
    serializeSettings,
    parseSettings,
    buildSettingsZip,
    readSettingsFile,
  });
})((globalThis.Colormeris ??= {}));
