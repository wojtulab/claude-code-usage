// ==UserScript==
// @name         Claude.ai Usage & Context Overlay (DOM Sync v2.2)
// @namespace    https://github.com/wojtulab/claude-code-usage
// @version      2.12.24
// @description  Monitor Claude.ai 1M context and 5h/7d usage limits, sound/browser alerts before & after reset or response completion, and auto-click "Try again".
// @homepageURL  https://github.com/wojtulab/claude-code-usage
// @supportURL   https://github.com/wojtulab/claude-code-usage/issues
// @updateURL    https://raw.githubusercontent.com/wojtulab/claude-code-usage/main/claude-usage.user.js
// @downloadURL  https://raw.githubusercontent.com/wojtulab/claude-code-usage/main/claude-usage.user.js
// @match        https://claude.ai/*
// @match        https://*.claude.ai/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // R11 storage shim (change in one = change in both): shadows window.localStorage for the whole script. Blocked or full storage falls back
  // to per-tab memory (cross-tab sharing off) instead of throwing; a key whose write failed stays memory-only so reads never return stale data.
  const localStorage = (() => {
    const mem = new Map(), memOnly = new Set();
    let real = null;
    try { real = window.localStorage; real.getItem('ide_probe'); } catch (e) { real = null; }
    const ok = (k) => real && !memOnly.has(k);
    return {
      getItem(k) { try { if (ok(k)) return real.getItem(k); } catch (e) {} return mem.has(k) ? mem.get(k) : null; },
      setItem(k, v) {
        v = String(v);
        try { if (real) { real.setItem(k, v); memOnly.delete(k); mem.delete(k); return; } } catch (e) {}
        mem.set(k, v); memOnly.add(k);
      },
      removeItem(k) { mem.delete(k); memOnly.delete(k); try { if (real) real.removeItem(k); } catch (e) {} },
      get length() { try { if (real) return real.length; } catch (e) {} return mem.size; },
      key(i) { try { if (real) return real.key(i); } catch (e) {} return [...mem.keys()][i] || null; }
    };
  })();
  // end R11 storage shim

  const VERSION = '2.12.24';
  const TICK_INTERVAL_MS = 1000;             // Countdown, alerts, and button checks every 1s

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }; // blocked storage must not stop the script

  // Settings: ⚙ panel in overlay header, saved to localStorage (claude_overlay_cfg_v1). CFG_SCHEMA entries: [key, label, type, default].
  const CFG_SCHEMA = [
    ['threshold', 'Context warning threshold (%)', 'num', 80, [1, 100]],
    ['refreshSec', 'API refresh interval (s)', 'num', 10, [2, 3600]],
    ['soundContext', 'Sound: context ≥ threshold / quota forecast', 'bool', true],
    ['soundPre', 'Sound: 1 minute before reset', 'bool', true],
    ['soundReset', 'Sound: session recovered', 'bool', true],
    ['qSound', 'Question / approval: sound', 'bool', true],
    ['qNotify', 'Question / approval: browser notification', 'bool', true],
    ['qRepeatSec', 'Question / approval: repeat every (s, 0 = once)', 'num', 60, [0, 3600]],
    ['doneSound', 'Response ready: sound', 'bool', true],
    ['doneNotify', 'Response ready: browser notification', 'bool', true],
    ['doneMinSec', 'Response ready: min generation time (s)', 'num', 10, [0, 3600]],
    ['doneRepeatSec', 'Response ready: repeat every (s, 0 = off)', 'num', 0, [0, 3600]],
    ['fcMin', 'Forecast: alert if limit ends within (min, 0 = off)', 'num', 30, [0, 1440]],
    ['sessList', 'Session list in overlay (claude.ai/code)', 'bool', true],
    ['autoAllow', 'Auto-click "Allow once" / "Always allow" (permission)', 'bool', false],
    ['titleInfo', 'Tab title: busy state and %', 'bool', true],
    ['titlePct', 'Tab title %', 'select', 'session', [['session', 'Session (5h)'], ['weekly', 'Weekly (7d)'], ['off', 'Off']]],
    ['titleBlink', 'Response ready: blink ✅ in title + green icon (silent)', 'bool', true],
    ['hiddenOnly', 'Notifications only when tab is in background', 'bool', true],
    ['volume', 'Alert volume (%, 0 = silent)', 'num', 100, [0, 100]],
    ['reduceMotion', 'Reduce motion (no pulsing, static blink)', 'bool', false],
    ['quietFrom', 'Quiet hours: from (h, same as to = off)', 'num', 0, [0, 23]],
    ['quietTo', 'Quiet hours: to (h)', 'num', 0, [0, 23]],
    ['opacityIdle', 'Opacity (%)', 'num', 50, [10, 100]],
    ['opacityHover', 'Opacity on hover (%)', 'num', 90, [10, 100]]
  ];
  const cfg = Object.assign({ minimized: false }, Object.fromEntries(CFG_SCHEMA.map((s) => [s[0], s[3]])));
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('claude_overlay_cfg_v1')) || {}); } catch (e) {}
  // Types and ranges from the schema (num: 5th element [min, max]); applied at start, on change and on sync from another tab.
  function normCfg() {
    CFG_SCHEMA.forEach(([k, , type, def, opt]) => {
      if (type === 'num') { const n = typeof cfg[k] === 'number' ? cfg[k] : NaN; const [lo, hi] = opt || [0, 1e6]; cfg[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; }
      else if (type === 'bool') { if (typeof cfg[k] !== 'boolean') cfg[k] = def; }
      else if (type === 'select' && !opt.some(([v]) => v === cfg[k])) cfg[k] = def;
    });
  }
  normCfg();
  cfg.minimized = !!cfg.minimized;
  cfg.autoAllow = !!cfg.autoAllow;
  if (!['session', 'weekly', 'off'].includes(cfg.titlePct)) cfg.titlePct = 'session';

  function applyCfg() {
    let st = document.getElementById('claude-usage-overlay-cfgstyle');
    if (!st) { st = document.createElement('style'); st.id = 'claude-usage-overlay-cfgstyle'; document.head.appendChild(st); }
    st.textContent = `#claude-usage-overlay{opacity:${cfg.opacityIdle / 100} !important}#claude-usage-overlay:hover{opacity:${cfg.opacityHover / 100} !important}${cfg.reduceMotion ? '#claude-usage-overlay{animation:none !important}' : ''}`;
  }

  // F1: "Connection & data" block in settings: data age, API/backoff state, redacted diagnostics to clipboard.
  function diagReport() {
    let shared = 0; try { shared = +localStorage.getItem(BLOCK_KEY) || 0; } catch (e) {}
    const until = Math.max(apiBlockedUntil, shared);
    return {
      version: VERSION, at: new Date().toISOString(),
      data: { sessionPct: state.sessionPct, weeklyPct: state.weeklyPct, stale: isStale(), error: !!state.error, ageSec: lastSuccessTs ? Math.round((Date.now() - lastSuccessTs) / 1000) : null },
      api: { refreshSec: cfg.refreshSec, backoffUntil: until > Date.now() ? new Date(until).toISOString() : null, org: cachedOrgId ? cachedOrgId.slice(0, 6) + '…' : null },
      questions: qMap.size, sessionsOnPage: document.querySelectorAll('[data-row-key]').length
    };
  }
  function buildDataBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Connection & data'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    box.appendChild(h);
    const r = diagReport();
    const age = r.data.ageSec == null ? 'no successful read yet' : (r.data.ageSec < 90 ? r.data.ageSec + ' s ago' : Math.round(r.data.ageSec / 60) + ' min ago');
    const lines = [
      'Usage: session ' + r.data.sessionPct + '%, weekly ' + r.data.weeklyPct + '% · ' + age + (r.data.stale ? ' (stale)' : ''),
      'API: ' + (r.data.error ? 'error' : 'ok') + (r.api.backoffUntil ? ' · backoff until ' + r.api.backoffUntil.slice(11, 19) + ' UTC' : '') + ' · every ' + r.api.refreshSec + ' s',
      'Org: ' + (r.api.org || 'unknown') + ' · questions waiting: ' + r.questions
    ];
    lines.forEach((t) => { const d = document.createElement('div'); d.textContent = t; box.appendChild(d); });
    const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Copy diagnostics';
    b.style.cssText = 'margin-top:4px;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
    b.onclick = () => {
      let ok = false;
      try { navigator.clipboard.writeText(JSON.stringify(diagReport(), null, 2)).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); ok = true; } catch (e) {}
      if (!ok) b.textContent = 'Copy failed';
    };
    box.appendChild(b);
    return box;
  }

  const IDE_KIND = 'claude', CFG_KEY = 'claude_overlay_cfg_v1', OVERLAY_ID = 'claude-usage-overlay';
  // F4: settings export/import (preferences only: no account data, no replay requests) and resets from the UI.
  function buildToolsBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Settings backup & reset'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('div'); note.style.cssText = 'min-height:12px;color:#8ab4f8;margin-top:2px;';
    const mk = (label, fn) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = fn; return b;
    };
    const ta = document.createElement('textarea'); ta.placeholder = 'Paste exported settings JSON here'; ta.rows = 2;
    ta.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:3px;background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:4px;font-size:10px;';
    const save = () => { normCfg(); try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} applyCfg(); renderOverlay(); };
    const exportJson = () => JSON.stringify({ ide: IDE_KIND, v: 1, cfg: Object.fromEntries([...CFG_SCHEMA.map((x) => x[0]), 'minimized'].map((k) => [k, cfg[k]])) }, null, 2);
    box.append(h,
      mk('Copy settings', () => { try { navigator.clipboard.writeText(exportJson()).then(() => { note.textContent = 'Settings copied'; }, () => { note.textContent = 'Copy failed'; }); } catch (e) { note.textContent = 'Copy failed'; } }),
      mk('Reset settings', () => { CFG_SCHEMA.forEach((x) => { cfg[x[0]] = x[3]; }); cfg.minimized = false; save(); note.textContent = 'Settings reset (history and position kept)'; }),
      mk('Reset position', () => { const o = document.getElementById(OVERLAY_ID); if (o && o._resetPos) o._resetPos(); note.textContent = 'Position reset'; }),
      ta,
      mk('Import settings', () => {
        let d; try { d = JSON.parse(ta.value); } catch (e) { note.textContent = 'Invalid JSON'; return; }
        if (!d || d.ide !== IDE_KIND || d.v !== 1 || !d.cfg || typeof d.cfg !== 'object') { note.textContent = 'Not a ' + IDE_KIND + ' settings export'; return; }
        const keys = [...CFG_SCHEMA.map((x) => x[0]), 'minimized'].filter((k) => k in d.cfg);
        keys.forEach((k) => { cfg[k] = d.cfg[k]; });
        save(); note.textContent = 'Imported ' + keys.length + ' settings (invalid values reset to allowed ranges)';
      }), note);
    return box;
  }

  // F3: alert presets — one click sets the per-category sound/notification toggles (no extra stored state, so rollback-safe).
  // Visual signals (frame, title, favicon) are never touched; only sound and system notifications.
  const PRESET_GROUPS = { q: ['qSound', 'qNotify'], d: ['doneSound', 'doneNotify'], l: ['soundContext', 'soundPre', 'soundReset'] };
  function buildPresetBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Alert presets (sound + notifications)'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('span'); note.style.cssText = 'margin-left:4px;color:#8ab4f8;';
    const apply = (label, on) => {
      Object.keys(PRESET_GROUPS).forEach((g) => PRESET_GROUPS[g].forEach((k) => { cfg[k] = on.includes(g); }));
      normCfg();
      try { localStorage.setItem('claude_overlay_cfg_v1', JSON.stringify(cfg)); } catch (e) {}
      const rows = box.parentElement ? box.parentElement.querySelectorAll(':scope > label') : [];
      CFG_SCHEMA.forEach(([k, , type], idx) => { const inp = rows[idx] && rows[idx].querySelector('input'); if (inp && type === 'bool') inp.checked = !!cfg[k]; });
      if (on.length) askNotifyPermission();
      applyCfg(); renderOverlay();
      note.textContent = label + ' applied';
    };
    const mk = (label, on) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = () => apply(label, on);
      return b;
    };
    box.append(h, mk('All alerts', ['q', 'd', 'l']), mk('Questions only', ['q']), mk('Silent (visual only)', []), note);
    return box;
  }

  // F3: snooze sound + system notifications (visual signals stay); shared between tabs through localStorage.
  function buildSnoozeBox() {
    const box = document.createElement('div');
    box.style.cssText = 'margin-top:8px;border-top:1px solid #333;padding-top:6px;font-size:10px;color:#aaa;';
    const h = document.createElement('div'); h.textContent = 'Snooze alerts (sound + notifications)'; h.style.cssText = 'font-weight:bold;color:#ccc;margin-bottom:3px;';
    const note = document.createElement('span'); note.style.cssText = 'margin-left:4px;color:#8ab4f8;';
    const show = () => {
      let u = 0; try { u = +localStorage.getItem('ide_snooze_until') || 0; } catch (e) {}
      note.textContent = u > Date.now() ? '🔕 until ' + new Date(u).toTimeString().slice(0, 5) : 'alerts on';
    };
    const mk = (label, min) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
      b.style.cssText = 'margin:2px 4px 2px 0;background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      b.onclick = () => { try { if (min) localStorage.setItem('ide_snooze_until', String(Date.now() + min * 60000)); else localStorage.removeItem('ide_snooze_until'); } catch (e) {} show(); };
      return b;
    };
    box.append(h, mk('15 min', 15), mk('60 min', 60), mk('Off', 0), note);
    show();
    return box;
  }

  function openSettings() {
    const old = document.getElementById('claude-usage-overlay-cfg');
    if (old) { if (old._close) old._close(); else old.remove(); return; }
    const ov = document.getElementById('claude-usage-overlay');
    const r = ov ? ov.getBoundingClientRect() : { left: innerWidth - 16, right: innerWidth - 16, top: innerHeight - 160, bottom: innerHeight - 80 };
    const p = document.createElement('div');
    p.id = 'claude-usage-overlay-cfg';
    p.style.cssText = 'position:fixed;z-index:2147483647;background:#1e1e1e;color:#e0e0e0;border:1px solid #777;border-radius:8px;padding:10px 12px;font:12px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);min-width:240px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);box-sizing:border-box;overflow-y:auto;';
    const h = document.createElement('div');
    h.textContent = '⚙ Claude Settings';
    h.style.cssText = 'font-weight:bold;margin-bottom:8px;border-bottom:1px solid #333;padding-bottom:4px;';
    p.appendChild(h);
    CFG_SCHEMA.forEach(([k, label, type, def, opts]) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:10px;margin:4px 0;cursor:pointer;';
      const t = document.createElement('span'); t.textContent = label;
      let i;
      if (type === 'select') {
        i = document.createElement('select');
        i.style.cssText = 'background:#2d2d2d;color:#e0e0e0;border:1px solid #555;border-radius:4px;padding:1px 4px;font-size:11px;';
        opts.forEach(([val, txt]) => { const o = document.createElement('option'); o.value = val; o.textContent = txt; i.appendChild(o); });
        i.value = cfg[k];
      } else {
        i = document.createElement('input');
        i.type = type === 'bool' ? 'checkbox' : 'number';
        if (type === 'bool') i.checked = !!cfg[k]; else { i.value = cfg[k]; i.style.width = '56px'; }
      }
      i.onchange = () => {
        if (type === 'select') cfg[k] = opts.some(([v]) => v === i.value) ? i.value : def;
        else if (type === 'bool') cfg[k] = i.checked;
        else { const n = parseFloat(i.value); cfg[k] = Number.isFinite(n) ? n : def; } // 0 is a valid value; range from schema (normCfg)
        normCfg(); if (type === 'num') i.value = cfg[k];
        if (type === 'bool' && i.checked && /Notify$/.test(k)) askNotifyPermission();
        try { localStorage.setItem('claude_overlay_cfg_v1', JSON.stringify(cfg)); } catch (e) {}
        applyCfg();
        if (k === 'autoAllow' && cfg.autoAllow) tryAutoAllow();
        renderOverlay();
      };
      row.append(t, i);
      p.appendChild(row);
    });
    p.appendChild(buildDataBox());
    p.appendChild(buildPresetBox());
    p.appendChild(buildSnoozeBox());
    p.appendChild(buildToolsBox());
    const x = document.createElement('div');
    x.textContent = 'Refresh/threshold changes apply immediately; settings are stored per browser.';
    x.style.cssText = 'font-size:9px;color:#777;margin-top:6px;';
    p.appendChild(x);
    p.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(p);

    const pr = p.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    if (cx < innerWidth / 2) {
      const leftPx = (r.right + 8 + pr.width <= innerWidth - 8) ? r.right + 8 : Math.min(r.left, innerWidth - pr.width - 8);
      p.style.left = Math.max(8, leftPx) + 'px';
    } else {
      const rightPx = (r.left - 8 - pr.width >= 8) ? innerWidth - r.left + 8 : Math.min(innerWidth - r.right, innerWidth - pr.width - 8);
      p.style.right = Math.max(8, rightPx) + 'px';
    }
    if (cy < innerHeight / 2) {
      const topPx = (r.top + pr.height <= innerHeight - 8) ? r.top : Math.min(r.bottom + 6, innerHeight - pr.height - 8);
      p.style.top = Math.max(8, topPx) + 'px';
    } else {
      const botPx = (r.bottom - pr.height >= 8) ? innerHeight - r.bottom : Math.min(innerHeight - r.top + 6, innerHeight - pr.height - 8);
      p.style.bottom = Math.max(8, botPx) + 'px';
    }

    const close = (back) => {
      p.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside, true);
      if (back) { const g = document.getElementById('claude-cfg-btn'); if (g) g.focus(); } // keyboard user returns to the gear
    };
    p._close = close;
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Claude settings');
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    const onOutside = (e) => { if (!p.contains(e.target) && !(ov && ov.contains(e.target))) close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    const first = p.querySelector('input, select'); if (first) first.focus();
  }

  let cachedOrgId = lsGet('claude_overlay_org_id') || null;
  const ctxSeen = new Map(); // chat path → { alerted, known }: context alert is per chat, never on first sight (session switch)

  // Remember reset timestamps for which sounds were already played (prevents duplicates after F5)
  let lastPreResetSoundTs = Number(lsGet('claude_overlay_pre_sound_ts')) || 0;
  let lastResetSoundTs = Number(lsGet('claude_overlay_reset_sound_ts')) || 0;

  // "Try again" click tracking
  let lastTryAgainClickTime = 0;
  let tryAgainAttemptsForCycle = 0;
  let lastClickedCycleTs = 0;

  const STATE_KEY = 'claude_overlay_state_v1';
  const BLOCK_KEY = 'claude_overlay_block_until'; // shared API backoff deadline (ts)
  let statusNoteUntil = 0;
  let lastSuccessTs = 0;

  let state = {
    sessionPct: '?',
    weeklyPct: '?',
    sessionResetTs: null,
    weeklyResetTs: null,
    contextText: '?',
    contextPct: 0,
    hasContextUI: false,
    lastUpdated: null,
    error: false,
    autoTryAgain: lsGet('claude_overlay_auto_try_again') !== 'false', // enabled by default
    statusNote: ''
  };

  function setNote(txt, ttlMs = 45000) {
    state.statusNote = txt || '';
    statusNoteUntil = txt ? Date.now() + ttlMs : 0;
  }

  function sanitizeSharedState(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const clean = {};
    if ((typeof d.sessionPct === 'number' && Number.isFinite(d.sessionPct)) || d.sessionPct === '?') clean.sessionPct = d.sessionPct;
    if ((typeof d.weeklyPct === 'number' && Number.isFinite(d.weeklyPct)) || d.weeklyPct === '?') clean.weeklyPct = d.weeklyPct;
    if ((typeof d.sessionResetTs === 'number' && Number.isFinite(d.sessionResetTs) && d.sessionResetTs > 0) || d.sessionResetTs === null) clean.sessionResetTs = d.sessionResetTs;
    if ((typeof d.weeklyResetTs === 'number' && Number.isFinite(d.weeklyResetTs) && d.weeklyResetTs > 0) || d.weeklyResetTs === null) clean.weeklyResetTs = d.weeklyResetTs;
    if (typeof d.extraEnabled === 'boolean') clean.extraEnabled = d.extraEnabled;
    if ((typeof d.extraPct === 'number' && Number.isFinite(d.extraPct)) || d.extraPct === '?') clean.extraPct = d.extraPct;
    if ((typeof d.extraUsed === 'number' && Number.isFinite(d.extraUsed)) || d.extraUsed === null) clean.extraUsed = d.extraUsed;
    if ((typeof d.extraLimit === 'number' && Number.isFinite(d.extraLimit)) || d.extraLimit === null) clean.extraLimit = d.extraLimit;
    if (typeof d.lastUpdated === 'string') clean.lastUpdated = d.lastUpdated.slice(0, 40);
    else if (d.lastUpdated === null) clean.lastUpdated = null;
    if (typeof d.fetchedAt === 'number' && Number.isFinite(d.fetchedAt) && d.fetchedAt > 0) clean.fetchedAt = d.fetchedAt;
    if (cachedOrgId && d.orgId !== cachedOrgId) return null; // cache of another org (or untagged legacy cache)
    return Object.keys(clean).length ? clean : null;
  }

  try {
    const cached = localStorage.getItem(STATE_KEY);
    if (cached) {
      const clean = sanitizeSharedState(JSON.parse(cached));
      if (clean) {
        const { fetchedAt, ...fields } = clean;
        Object.assign(state, fields);
        if (fetchedAt) lastSuccessTs = fetchedAt;
      }
    }
  } catch (e) {}

  function injectStyles() {
    if (document.getElementById('claude-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'claude-overlay-styles';
    style.textContent = `
      @keyframes claudePulseRed {
        0% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0.7), 0 4px 12px rgba(0,0,0,0.5); border-color: #f44336; }
        70% { box-shadow: 0 0 0 10px rgba(244, 67, 54, 0), 0 4px 12px rgba(0,0,0,0.5); border-color: #ff7961; }
        100% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0), 0 4px 12px rgba(0,0,0,0.5); border-color: #f44336; }
      }
      @keyframes claudePulseOrange {
        0%, 100% { border-color: #444; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        50% { border-color: #ff9800; box-shadow: 0 0 14px 3px #ff9800; }
      }
      #claude-usage-overlay button:focus-visible, #claude-usage-overlay input:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 1px; }
      @media (prefers-reduced-motion: reduce) { .claude-overlay-critical, .claude-overlay-question { animation: none !important; } }
      .claude-overlay-critical {
        animation: claudePulseRed 2s infinite !important;
        background: #2a1215 !important;
      }
      .claude-overlay-question {
        border: 2px solid #ff9800 !important;
        animation: claudePulseOrange 1s ease-in-out infinite !important;
      }
    `;
    document.head.appendChild(style);
  }

  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Notification permission may only be requested from a user gesture (click on overlay/⚙/checkbox), never from a timer.
  function askNotifyPermission() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (e) {}
  }
  // Colored dot in favicon during alert (static, no timer so not throttled in background).
  // Shared blocks with antigravity-quota.user.js (change in one = change in both): setFav, away, notify, closeN, claimOnce, audio.
  let favOrig = null, favMade = false, favColor = '';
  function setFav(color) {
    let l = document.querySelector('link[rel~="icon"]');
    if (color) {
      if (favOrig === null) {
        if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); favMade = true; }
        favOrig = l.href || '';
      }
      if (favColor === color && l && l.href.startsWith('data:')) return;
      favColor = color;
      l.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='${encodeURIComponent(color)}'/%3E%3C/svg%3E`;
    } else if (favOrig !== null) {
      if (l) { if (favMade) l.remove(); else l.href = favOrig; }
      favOrig = null; favMade = false; favColor = '';
    }
  }
  const away = () => document.hidden || !document.hasFocus(); // background tab OR unfocused window (second monitor)
  const openNs = new Set(); // open sticky notifications; closeN closes all of them
  function closeN() { openNs.forEach((n) => { try { n.close(); } catch (e) {} }); openNs.clear(); }
  const snoozed = () => { try { if (Date.now() < (+localStorage.getItem('ide_snooze_until') || 0)) return true; } catch (e) {} const f = cfg.quietFrom, t = cfg.quietTo, h = new Date().getHours(); return f !== t && (f < t ? h >= f && h < t : h >= f || h < t); }; // F3: sound and system notifications muted until ts (visual signals stay)
  // R10: one persistent visually-hidden live region (outside the rebuilt overlay), updated only on alert events (change in one = change in both).
  function announce(text) {
    try {
      let n = document.getElementById('ide-live');
      if (!n) {
        n = document.createElement('div'); n.id = 'ide-live';
        n.setAttribute('role', 'status'); n.setAttribute('aria-live', 'polite');
        n.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
        document.body.appendChild(n);
      }
      n.textContent = '';
      setTimeout(() => { n.textContent = String(text).slice(0, 200); }, 50); // empty first: identical consecutive text is announced again
    } catch (e) {}
  }
  function notify(title, body, tag, force, sticky, onClick) {
    announce(title + (body ? ': ' + body : ''));
    if (snoozed()) return;
    if (cfg.hiddenOnly && !away() && !force) return;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body, tag, requireInteraction: !!sticky });
        if (sticky) openNs.add(n);
        n.onclick = () => { window.focus(); try { if (onClick) onClick(); } catch (e) {} n.close(); openNs.delete(n); };
      }
    } catch (e) {}
  }

  // Single shared AudioContext (previously created on every beep).
  let actx = null;
  function ensureAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!actx) { actx = new AudioCtx(); actx.onstatechange = () => diag('audio:' + actx.state); }
      if (actx.state !== 'running') actx.resume().catch(() => {});
      return actx;
    } catch (e) { return null; }
  }
  // Unlock audio on first user gesture (autoplay policy) so background-tab alerts do not wait until tab return.
  ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, ensureAudio, true));

  // Diagnostic log: last 120 events in localStorage, read via `__claudeDiag()` in claude.ai console.
  // i = tab (random id), h = background tab, a = AudioContext state, n = Notification permission.
  const DIAG_KEY = 'claude_overlay_diag_v1', TAB_ID = Math.random().toString(36).slice(2, 5);
  // Multi-tab coordination: only the tab that wins the claim sends the alert for an event. Write TAB_ID+time to localStorage,
  // read back after ~50 ms (last write visible to all tabs wins); key fresher than ttlMs held by another tab → false.
  // Shared block with antigravity-quota.user.js: change in one = change in both.
  // Key = readable prefix + hash of the rest: no chat titles in localStorage key names. Claims older than 1 h are removed at start.
  function claimOnce(key, ttlMs) {
    let hh = 5381; for (let i = 0; i < key.length; i++) hh = ((hh << 5) + hh + key.charCodeAt(i)) | 0;
    const k = 'ide_claim_' + key.split('-')[0] + '_' + (hh >>> 0).toString(36);
    try {
      const cur = JSON.parse(localStorage.getItem(k) || 'null');
      if (cur && cur.id !== TAB_ID && Date.now() - cur.t < ttlMs) return Promise.resolve(false);
      localStorage.setItem(k, JSON.stringify({ id: TAB_ID, t: Date.now() }));
    } catch (e) { return Promise.resolve(true); }
    return new Promise((res) => setTimeout(() => {
      try { const c = JSON.parse(localStorage.getItem(k) || 'null'); res(!c || c.id === TAB_ID); } catch (e) { res(true); }
    }, 50));
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const ck = localStorage.key(i);
      if (ck && ck.startsWith('ide_claim_')) { const c = JSON.parse(localStorage.getItem(ck) || 'null'); if (!c || !(Date.now() - c.t < 3600e3)) localStorage.removeItem(ck); }
    }
  } catch (e) {}
  function diag(k, extra) {
    try {
      const a = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]');
      a.push(Object.assign({ t: new Date().toTimeString().slice(0, 8), i: TAB_ID, k, h: document.hidden ? 1 : 0, a: actx ? actx.state : '-', n: 'Notification' in window ? Notification.permission : '-' }, extra));
      localStorage.setItem(DIAG_KEY, JSON.stringify(a.slice(-120)));
    } catch (e) {}
  }
  window.__claudeDiag = () => { try { const a = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); console.table(a); return a; } catch (e) { return []; } };

  // Generic Web Audio API tone sequence player
  function playTones(notes) {
    if (snoozed() || !cfg.volume) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = Date.now();
    const go = () => {
      if (Date.now() - t0 > 1500) { diag('beep-stale'); return; } // blocked AudioContext resumed only on tab return: stale beep is worse than silence
      try {
        notes.forEach(({ freq, start, duration, type = 'sine', gainVal = 0.09 }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = type;
          osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
          gain.gain.setValueAtTime(Math.max(0.002, gainVal * cfg.volume / 100), ctx.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + start);
          osc.stop(ctx.currentTime + start + duration);
        });
      } catch (e) {}
    };
    if (ctx.state === 'running') go(); else ctx.resume().then(go, () => diag('beep-blocked'));
  }

  // 1. Context full warning (>= 80%)
  function playContextAlertBeep() {
    playTones([
      { freq: 880, start: 0, duration: 0.15 },
      { freq: 1174.66, start: 0.18, duration: 0.25 }
    ]);
  }

  // 2. Notification 1 minute before session reset (gentle double chime)
  function playPreResetBeep() {
    playTones([
      { freq: 587.33, start: 0, duration: 0.16, type: 'triangle', gainVal: 0.11 },    // D5
      { freq: 880.00, start: 0.20, duration: 0.28, type: 'triangle', gainVal: 0.11 }  // A5
    ]);
  }

  // 3. Notification when session recovers (distinct ascending chord)
  function playSessionResetBeep() {
    playTones([
      { freq: 523.25, start: 0, duration: 0.14, type: 'triangle', gainVal: 0.12 },    // C5
      { freq: 659.25, start: 0.15, duration: 0.14, type: 'triangle', gainVal: 0.12 }, // E5
      { freq: 783.99, start: 0.30, duration: 0.14, type: 'triangle', gainVal: 0.12 }, // G5
      { freq: 1046.50, start: 0.45, duration: 0.35, type: 'triangle', gainVal: 0.13 } // C6
    ]);
  }

  // Response ready: short two-tone chime distinct from limit alerts
  function playDoneBeep() {
    playTones([
      { freq: 698.46, start: 0, duration: 0.12, type: 'triangle', gainVal: 0.1 },    // F5
      { freq: 1046.50, start: 0.14, duration: 0.22, type: 'triangle', gainVal: 0.1 } // C6
    ]);
  }

  // Question / approval alert: crisp two-tone prompt
  function playQuestionBeep() {
    playTones([
      { freq: 880, start: 0, duration: 0.14, type: 'sine', gainVal: 0.12 },
      { freq: 1175, start: 0.18, duration: 0.15, type: 'sine', gainVal: 0.12 }
    ]);
  }

  function formatResetTime(ts, showSeconds = false) {
    if (!ts) return 'No data';
    try {
      const date = new Date(ts);
      const diffMs = ts - Date.now();
      let diffStr = '';
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3600000);
        const mins = Math.floor((diffMs % 3600000) / 60000);
        const secs = Math.floor((diffMs % 60000) / 1000);
        if (hrs > 0) {
          diffStr = `in ${hrs}h ${mins}m`;
        } else if (showSeconds) {
          diffStr = `in ${mins}m ${secs}s`;
        } else {
          diffStr = `in ${mins}m`;
        }
      }
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return diffStr ? `Reset: ${timeStr} (${diffStr})` : `Reset: ${timeStr}`;
    } catch (e) {
      return 'No data';
    }
  }

  // 429/401 → backoff error; Retry-After (seconds) is honoured by updateAll
  const backoffErr = (res, what) => Object.assign(new Error(`HTTP ${what} Error: ${res.status}`), {
    backoff: true, retryAfterMs: Math.max(0, parseInt(res.headers.get('retry-after'), 10) || 0) * 1000
  });
  const API_TIMEOUT_MS = 15000; // hung request must release `updating`

  // Active org: claude.ai sets cookie `lastActiveOrg` (when not HttpOnly); fallback orgs[0]
  function activeOrgCookie() {
    const m = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    try { return m ? decodeURIComponent(m[1]) : null; } catch (e) { return null; }
  }

  function switchOrg(id) {
    if (cachedOrgId && cachedOrgId !== id) { // other org/account: never show previous limits
      Object.assign(state, { sessionPct: '?', weeklyPct: '?', sessionResetTs: null, weeklyResetTs: null, lastUpdated: null });
      try { localStorage.removeItem(STATE_KEY); } catch (e) {}
    }
    cachedOrgId = id;
    try { localStorage.setItem('claude_overlay_org_id', id); } catch (e) {}
  }

  async function getOrgId() {
    const active = activeOrgCookie();
    if (cachedOrgId && (!active || active === cachedOrgId)) return cachedOrgId;
    const orgsRes = await fetch('/api/organizations', {
      credentials: 'same-origin',
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });
    if (orgsRes.status === 429 || orgsRes.status === 401) throw backoffErr(orgsRes, 'Org');
    if (!orgsRes.ok) throw new Error(`HTTP Org Error: ${orgsRes.status}`);
    const orgs = await orgsRes.json();
    if (!Array.isArray(orgs) || !orgs.length) throw new Error('No organization found');
    const ids = orgs.map((o) => o && (o.uuid || o.id)).filter(Boolean);
    const id = ids.includes(active) ? active : ids[0];
    if (!id) throw new Error('No organization found');
    switchOrg(id);
    return id;
  }

  // percent must be a finite number in 0..100, reset must be a valid date; anything else = API error (previous reading stays, marked stale)
  const apiPct = (o, what) => {
    if (o?.utilization == null) return '?';
    const v = Number(o.utilization);
    if (typeof o.utilization === 'boolean' || !Number.isFinite(v) || v < 0 || v > 100) throw new Error(`Invalid ${what} utilization`);
    return Math.round(v);
  };
  const apiTs = (raw, what) => {
    if (!raw) return null;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) throw new Error(`Invalid ${what} resets_at`);
    return t;
  };

  async function fetchUsageFromApi() {
    const orgId = await getOrgId();
    const usageRes = await fetch(`/api/organizations/${orgId}/usage`, {
      credentials: 'same-origin',
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    });

    if (usageRes.status === 403 || usageRes.status === 404) {
      cachedOrgId = null;
      localStorage.removeItem('claude_overlay_org_id');
      throw new Error('Expired org ID');
    }
    if (usageRes.status === 429 || usageRes.status === 401) throw backoffErr(usageRes, 'Usage');
    if (!usageRes.ok) throw new Error(`HTTP Usage Error: ${usageRes.status}`);

    const data = await usageRes.json();

    if (!data || typeof data !== 'object') throw new Error('Invalid usage payload');
    const wk = data.seven_day || data.weekly_all;
    const sessionPct = apiPct(data.five_hour, 'session');
    const sessionResetTs = apiTs(data.five_hour?.resets_at, 'session');
    const weeklyPct = apiPct(wk, 'weekly');
    const weeklyResetTs = apiTs(wk?.resets_at, 'weekly');

    return { sessionPct, weeklyPct, sessionResetTs, weeklyResetTs };
  }

  // TreeWalker over text nodes (instead of reading textContent on every element): candidates are short nodes with "used"/"1M",
  // exact match is checked against parent text (up to 3 levels up), skipping our own overlay.
  function scrapeContextFromDOM() {
    let pctVal = null;
    let ratioText = '';

    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const v = n.nodeValue;
      if (!v || v.length > 60 || !/used|1M/i.test(v)) continue;
      if (n.parentElement && n.parentElement.closest('#claude-usage-overlay')) continue;
      for (let el = n.parentElement, i = 0; el && i < 3; el = el.parentElement, i++) {
        const t = (el.textContent || '').trim();
        if (/^\d{1,3}%\s+used$/i.test(t)) { pctVal = parseInt(t, 10); break; }
        if (/\/\s*1M/i.test(t) && t.length < 30) { ratioText = t; break; }
      }
    }

    if (pctVal !== null) {
      // Per chat, crossing-based: a chat first seen already above the threshold (user switched sessions) stays silent; hysteresis of 3 points.
      const path = location.pathname, rec = ctxSeen.get(path) || { alerted: false, known: false };
      if (pctVal >= cfg.threshold) {
        if (!rec.alerted) {
          rec.alerted = true;
          if (rec.known && cfg.soundContext) {
            claimOnce('ctx-alert-' + path, 60000).then((ok) => {
              if (ok && cfg.soundContext) { diag('ctx-alert', { p: pctVal }); playContextAlertBeep(); }
            });
          }
        }
      } else if (pctVal < cfg.threshold - 3) rec.alerted = false;
      rec.known = true;
      if (ctxSeen.size > 50) ctxSeen.clear();
      ctxSeen.set(path, rec);

      return {
        hasContextUI: true,
        contextPct: pctVal,
        contextText: ratioText || `${pctVal}% / 1M`
      };
    }

    return { hasContextUI: false, contextPct: 0, contextText: 'No panel' };
  }

  // Finds the limit card and "Try again" button regardless of dynamic React IDs:
  // walks up from the button to the largest ancestor (<500 chars) containing "limit reached" (instead of scanning all divs).
  function findLimitCardAndTryAgainBtn() {
    for (const btn of document.querySelectorAll('button')) {
      if (btn.disabled || !/^Try again$/i.test(btn.textContent.trim())) continue;
      let found = null;
      for (let card = btn.parentElement, i = 0; card && i < 10; card = card.parentElement, i++) {
        const txt = card.textContent || '';
        if (txt.length >= 500) break;
        if (/limit reached/i.test(txt)) found = { card, btn, text: txt };
      }
      if (found) return found;
    }
    return null;
  }

  // Fallback reset-time parsing from card text e.g. "Auto-resuming at 1:01 PM" if the API failed
  function parseFallbackResetTsFromText(text) {
    const m = text.match(/Auto-resuming at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const mins = parseInt(m[2], 10);
    const ampm = m[3] ? m[3].toUpperCase() : null;

    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, mins, 0, 0);
    if (target.getTime() < now.getTime() - 12 * 3600 * 1000) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  // Tab title: "🔄 41% · Claude Code" (busy), "✅3 🔄2 41% · …" (done/busy counters), "❓ …" (question/approval priority), "41% · …" (idle).
  // % = 5h session usage. Strip prefix before re-applying so page title updates don't loop.
  const TITLE_PREFIX_RE = /^(?:(?:❓|✅)\d*\s+)?(?:🔄\d*\s+)?(?:\d{1,3}% · )?/;
  const QUESTION_ATTRS = ['permission', 'approve', 'allow', 'confirm', 'waiting for input', 'waiting-for-input', 'waiting_for_input', 'question'];
  const QUESTION_SEL = ['[data-approval-allow]', ...QUESTION_ATTRS.flatMap((w) => [`[aria-label*="${w}" i]`, `[data-testid*="${w}" i]`])].join(', ');
  const qMap = new Map(); // key → { title, current }
  let titleDone = false, qActive = false, qBlink = false;
  function isQuestionEl(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.closest('#claude-usage-overlay, #claude-usage-overlay-cfg')) return false;
    if (el.hidden || el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) {
      let vis = typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'contents';
      if (vis) {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (p.hidden || p.getAttribute('aria-hidden') === 'true' ||
              (typeof p.checkVisibility === 'function' && !p.checkVisibility() && getComputedStyle(p).display !== 'contents')) {
            vis = false; break;
          }
        }
      }
      if (!vis) return false;
    }
    const al = el.getAttribute('aria-label') || '';
    const dt = el.getAttribute('data-testid') || '';
    if (/^More options\b/i.test(al) || /cookie/i.test(al + ' ' + dt)) return false;
    return true;
  }
  function rowHasQuestion(row) {
    for (const el of row.querySelectorAll(QUESTION_SEL)) {
      if (isQuestionEl(el) && !el.matches('a[data-row-main-button]')) return true;
    }
    return false;
  }
  function findChatQuestion() {
    const scopes = document.querySelectorAll('main, [role="main"], [role="dialog"], [role="alertdialog"]');
    const roots = scopes.length ? scopes : (document.body ? [document.body] : []);
    for (const scope of roots) {
      for (const el of scope.querySelectorAll(QUESTION_SEL)) {
        if (!isQuestionEl(el) || el.closest('[data-row-key], nav')) continue;
        return el;
      }
    }
    return null;
  }
  // Click guard per approval: same button node AND same card text; a reused node (React keeps the element for the next command)
  // or a record older than 30 s starts again, otherwise auto-click would die for good after 2 clicks.
  let allowRec = { btn: null, sig: '', count: 0, at: 0 }, lastAllowDiagAt = 0;
  function allowSig(btn) {
    const c = btn.closest('[data-approval-allow]'), card = (c && c.parentElement) || btn.parentElement;
    return ((card && card.textContent) || '').replace(/\s+/g, ' ').slice(0, 300);
  }
  let lastAutoAllowAt = 0;
  function cleanBtnText(btn) {
    if (!btn.querySelector('kbd, [data-cds="Shortcut"], .sr-only')) return (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const c = btn.cloneNode(true);
    c.querySelectorAll('kbd, [data-cds="Shortcut"], .sr-only').forEach((n) => n.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function findAllowOnceBtn() {
    const scopes = document.querySelectorAll('main, [role="main"], [role="dialog"], [role="alertdialog"]');
    const roots = scopes.length ? scopes : (document.body ? [document.body] : []);
    const okBtn = (btn) => isQuestionEl(btn) && btn.getAttribute('aria-disabled') !== 'true' && !btn.closest('[data-row-key], nav');
    for (const scope of roots) {
      for (const btn of scope.querySelectorAll('[data-approval-allow] button[data-approval-primary], [data-approval-allow] button')) {
        if (okBtn(btn) && /^Allow(?:\s+once)?$/i.test(cleanBtnText(btn))) return btn;
      }
      for (const btn of scope.querySelectorAll('button, [role="button"]')) {
        if (!okBtn(btn)) continue;
        const txt = cleanBtnText(btn);
        const al = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (/^Allow\s+once(?:\s*(?:Ctrl|⌘|Enter|⏎|↵).*)?$/i.test(txt) || /^Allow\s+once\b/i.test(al)) return btn;
        if (/^Allow(?:\s*(?:Ctrl|⌘|Enter|⏎|↵).*)?$/i.test(txt) && btn.parentElement) {
          const hasDeny = [...btn.parentElement.querySelectorAll('button, [role="button"]')].some((b) =>
            b !== btn && isQuestionEl(b) && /^(?:Deny|Reject|Decline|Don'?t allow)\b/i.test(cleanBtnText(b))
          );
          if (hasDeny) return btn;
        }
      }
    }
    // The card may be rendered outside <main>/dialog (e.g. next to the composer): the [data-approval-allow] marker is specific enough to search the whole page.
    for (const btn of document.querySelectorAll('[data-approval-allow] button')) {
      if (okBtn(btn) && /^Allow(?:\s+once)?(?:\s*(?:Ctrl|⌘|Enter|⏎|↵).*)?$/i.test(cleanBtnText(btn))) return btn;
    }
    // Owner's choice (18.11.2026): a card with only "Always allow" (no "Allow once") is clicked too — same setting.
    for (const btn of document.querySelectorAll('[data-approval-allow] button')) {
      if (okBtn(btn) && /^Always\s+allow(?:\s*(?:Ctrl|Shift|⌘|Enter|⏎|↵).*)?$/i.test(cleanBtnText(btn))) return btn;
    }
    return null;
  }
  function tryAutoAllow() {
    if (!cfg.autoAllow) return false;
    const now = Date.now();
    if (now - lastAutoAllowAt < 800) return false;
    const btn = findAllowOnceBtn();
    if (!btn) {
      allowRec = { btn: null, sig: '', count: 0, at: 0 };
      const card = document.querySelector('[data-approval-allow]');
      if (card && now - lastAllowDiagAt > 10000) { // card visible but no "Allow once" (e.g. only "Always allow"): leave a trace without the command text
        lastAllowDiagAt = now;
        diag('allow-nobtn', { btns: [...card.parentElement.querySelectorAll('button')].slice(0, 4).map((b) => cleanBtnText(b).slice(0, 24)).join('|') });
      }
      return false;
    }
    const sig = allowSig(btn);
    if (allowRec.btn !== btn || allowRec.sig !== sig || now - allowRec.at > 30000) allowRec = { btn, sig, count: 0, at: 0 };
    if (allowRec.count >= 2 || now - allowRec.at < 3000) return false;
    allowRec = { btn, sig, count: allowRec.count + 1, at: now };
    lastAutoAllowAt = now;
    diag('auto-allow');
    btn.click();
    setNote('🤖 Auto-clicked "' + cleanBtnText(btn).slice(0, 20) + '"', 10000);
    renderOverlay();
    return true;
  }
  function detectQuestions() {
    const active = new Map();
    let curRowHasQ = false;
    document.querySelectorAll('[data-row-key]').forEach((row) => {
      if (!rowHasQuestion(row)) return;
      const key = row.getAttribute('data-row-key');
      const current = !!row.querySelector('[aria-current="page"]');
      if (current) curRowHasQ = true;
      rowDone.delete(key);
      active.set(key, { title: rowLabel(row) || key, current });
    });
    const chatEl = !curRowHasQ && !(cfg.autoAllow && Date.now() - lastAutoAllowAt < 2500) ? findChatQuestion() : null;
    if (chatEl) {
      const desc = chatEl.tagName.toLowerCase() + '|' + (chatEl.getAttribute('aria-label') || '').slice(0, 40) + '|' + (chatEl.getAttribute('data-testid') || '').slice(0, 40); // attribute names only, never page text
      const chatTitle = document.title.replace(TITLE_PREFIX_RE, '').replace(/\s*[-–|]\s*Claude\s*$/i, '') || 'Claude';
      active.set('chat', { title: chatTitle, current: true, desc });
    }
    for (const k of [...qMap.keys()]) {
      if (!active.has(k)) qMap.delete(k);
    }
    const fireQ = (key, info) => claimOnce('claude-q-' + key, 5000).then((ok) => {
      if (!ok) { diag('claim-lost', { c: 'q' }); return; }
      diag('q-alert', { q: key.slice(-12), el: info.desc || '' }); // field must not be `k`: it would overwrite the event name
      if (cfg.qSound) playQuestionBeep();
      if (cfg.qNotify) {
        notify('Claude needs approval', info.title, 'claude-q-' + key, !info.current, true,
          key !== 'chat' ? () => { openSession(key); applyTitle(); } : null);
      }
    });
    active.forEach((info, key) => {
      const ex = qMap.get(key), now = Date.now();
      if (ex) { // question still waiting: repeat every qRepeatSec (like AG)
        if (cfg.qRepeatSec && now - ex.alertAt >= cfg.qRepeatSec * 1000) { ex.alertAt = now; fireQ(key, info); }
        return;
      }
      info.alertAt = now;
      qMap.set(key, info);
      fireQ(key, info);
    });
    qActive = active.size > 0;
  }
  function isCurrentWorking() {
    if (genSince && !genIdleAt) return true;
    for (const rec of rowBusy.values()) if (rec.current && !rec.idleAt && !rec.question) return true;
    return false;
  }
  function busyCount() {
    let n = 0, cur = false;
    for (const rec of rowBusy.values()) if (!rec.idleAt && !rec.question) { n++; if (rec.current) cur = true; }
    if (genSince && !genIdleAt && !cur) n++;
    return n;
  }
  function markDone() { if (away()) titleDone = true; }
  function clearDone() {
    if (away()) return;
    if (!titleDone && !openNs.size && !rowDone.size && !qBlink) return;
    closeN();
    document.querySelectorAll('[data-row-key]').forEach((r) => {
      if (r.querySelector('[aria-current="page"]')) rowDone.delete(r.getAttribute('data-row-key'));
    });
    titleDone = false;
    qBlink = false;
    applyTitle();
  }
  // ❓ takes priority over ✅; blinking and favicon are independent of 🔄/% prefix (titleInfo); ticked by applyTitle.
  function applyTitle() {
    if (isCurrentWorking()) titleDone = false;
    if (qActive && away()) qBlink = true;
    else if (!qActive) qBlink = false;
    setFav(qActive && away() ? '#f97316' : (titleDone && cfg.titleBlink ? '#22c55e' : ''));
    const base = document.title.replace(TITLE_PREFIX_RE, '');
    const blinkHide = !cfg.reduceMotion && (Math.floor(Date.now() / 1000) % 2 === 1);
    let alertPart = '';
    if (qActive) {
      alertPart = (away() && blinkHide) ? '' : '❓ ';
    } else if (titleDone && cfg.titleBlink) {
      const doneN = Math.max(rowDone.size, 1);
      alertPart = blinkHide ? '' : '✅' + (doneN > 1 ? doneN : '') + ' ';
    } else if (cfg.titleInfo && rowDone.size) {
      alertPart = '✅' + (rowDone.size > 1 ? rowDone.size : '') + ' ';
    }
    let next = base;
    if (cfg.titleInfo) {
      const busyN = busyCount();
      const busyPart = busyN ? '🔄' + (busyN > 1 ? busyN : '') + ' ' : '';
      const rawPct = cfg.titlePct === 'weekly' ? state.weeklyPct : (cfg.titlePct === 'off' ? '' : state.sessionPct);
      const pct = /^\d+$/.test(String(rawPct)) ? rawPct + '% · ' : '';
      next = alertPart + busyPart + pct + base;
    } else {
      next = alertPart + base;
    }
    if (document.title !== next) document.title = next;
  }

  // Quota exhaustion forecast: "remaining %" (100 - used) history in localStorage, burn rate window (5h: 45 min, weekly: 6h).
  // Remaining % increase = window reset → clear history. Heartbeat every 5 min, so idle gaps dilute burn rate.
  const FC_WIN = { session: 45 * 60e3, weekly: 6 * 3600e3 };
  let hist = {};
  try { hist = JSON.parse(localStorage.getItem('claude_overlay_hist_v1')) || {}; } catch (e) {}
  function recordHist(kind, pct) {
    if (!/^\d+$/.test(String(pct))) return;
    const v = 100 - Number(pct), now = Date.now();
    // Another tab may have appended points: storage is a superset of memory (we write after every change), so reload before editing.
    try { const d = JSON.parse(localStorage.getItem('claude_overlay_hist_v1')); if (d && typeof d === 'object') hist = d; } catch (e) {}
    const h = hist[kind] || (hist[kind] = []);
    const last = h[h.length - 1];
    if (last && v > last.v) h.length = 0;
    if (!h.length || v !== h[h.length - 1].v || now - h[h.length - 1].t > 300000) h.push({ t: now, v });
    while (h.length && now - h[0].t > 7 * 3600e3) h.shift();
    try { localStorage.setItem('claude_overlay_hist_v1', JSON.stringify(hist)); } catch (e) {}
  }
  // Data age: a failed request (state.stale) or a last successful read older than max(10 min, 3 refreshes) = stale.
  const isStale = () => !!state.stale || (!!lastSuccessTs && Date.now() - lastSuccessTs > Math.max(600000, cfg.refreshSec * 3000));
  function forecast(kind) {
    if (isStale()) return null; // old reading must not produce forecast/alert
    const now = Date.now(), pts = (hist[kind] || []).filter((p) => now - p.t <= FC_WIN[kind]);
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1], drop = a.v - b.v, dt = (b.t - a.t) / 3600e3;
    if (drop < 2 || dt < 3 / 60) return null; // too little change (1% rounding) or measurement window too short
    const rate = drop / dt, etaMs = (b.v / rate) * 3600e3 - (now - b.t);
    const resetTs = state[kind + 'ResetTs'];
    return { rate, etaMs: Math.max(0, etaMs), before: !!resetTs && etaMs < resetTs - now };
  }
  function fmtDur(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return m + 'm';
    if (m < 2880) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    return Math.floor(m / 1440) + 'd';
  }
  function fcHtml(kind) {
    const f = forecast(kind);
    if (!f) return '';
    const txt = f.before ? `⏱ ${f.rate.toFixed(1)}%/h → limit in ~${fmtDur(f.etaMs)} ⚠ before reset` : `⏱ ${f.rate.toFixed(1)}%/h · lasts until reset`;
    return `<div style="font-size:10px;color:${f.before ? '#ff8a80' : '#888'};margin:-4px 0 6px">${txt}</div>`;
  }
  let fcAlerted = {};
  try { fcAlerted = JSON.parse(localStorage.getItem('claude_overlay_fc_v1')) || {}; } catch (e) {}
  // Another tab played/marked an alert → refresh flags instead of reading once on startup.
  window.addEventListener('storage', (e) => {
    try {
      if (e.key === 'claude_overlay_pre_sound_ts') lastPreResetSoundTs = Number(e.newValue) || 0;
      else if (e.key === 'claude_overlay_reset_sound_ts') lastResetSoundTs = Number(e.newValue) || 0;
      else if (e.key === 'claude_overlay_fc_v1') fcAlerted = JSON.parse(e.newValue) || {};
      else if (e.key === 'claude_overlay_cfg_v1' && e.newValue) {
        const c = JSON.parse(e.newValue);
        if (c && typeof c === 'object') {
          Object.assign(cfg, c);
          normCfg();
          cfg.minimized = !!cfg.minimized;
          cfg.autoAllow = !!cfg.autoAllow;
          if (!['session', 'weekly', 'off'].includes(cfg.titlePct)) cfg.titlePct = 'session';
          applyCfg();
          if (cfg.autoAllow) tryAutoAllow();
          renderOverlay();
        }
      }
      else if (e.key === STATE_KEY && e.newValue) {
        const d = sanitizeSharedState(JSON.parse(e.newValue));
        if (d) {
          const { fetchedAt, ...fields } = d;
          Object.assign(state, fields, { error: false, stale: false });
          if (fetchedAt) lastSuccessTs = fetchedAt;
          applyTitle();
          renderOverlay();
        }
      }
    } catch (err) {}
  });
  function checkForecast() {
    if (!cfg.fcMin) return;
    [['session', 'Session 5h'], ['weekly', 'Weekly']].forEach(([kind, label]) => {
      const f = forecast(kind), rts = state[kind + 'ResetTs'];
      if (!f || !f.before || f.etaMs > cfg.fcMin * 60e3 || fcAlerted[kind] === rts) return;
      try { fcAlerted = Object.assign(JSON.parse(localStorage.getItem('claude_overlay_fc_v1')) || {}, { [kind]: rts }); } catch (e) { fcAlerted[kind] = rts; } // once per reset window
      try { localStorage.setItem('claude_overlay_fc_v1', JSON.stringify(fcAlerted)); } catch (e) {}
      const body = `${label}: ~${fmtDur(f.etaMs)} left at ${f.rate.toFixed(1)}%/h (resets in ${fmtDur(rts - Date.now())})`;
      claimOnce('fc-' + kind + '-' + rts, 600000).then((ok) => {
        if (!ok) { diag('claim-lost', { c: 'fc' }); return; }
        if (cfg.soundContext) playContextAlertBeep();
        notify('Claude: limit running out', body, 'claude-fc-' + kind);
      });
    });
  }

  function openSession(key) {
    if (!key) return;
    const row = [...document.querySelectorAll('[data-row-key]')].find((r) => r.getAttribute('data-row-key') === key);
    const a = row && (row.querySelector('a[data-row-main-button]') || row.querySelector('a[href]'));
    if (a) a.click();
    rowDone.delete(key);
  }

  // Shared "done" alert; Stop button and sidebar session spinner detectors won't duplicate it within 5s.
  let lastDone = { tag: '', at: 0 };
  let doneAlert = null; // last fired "done" alert, repeated every doneRepeatSec while still unvisited (like AG dRepeatSec)
  function fireDone(title, tag, force, sessKey) {
    claimOnce('done-' + tag + '-' + title, cfg.doneRepeatSec ? Math.min(10000, Math.max(500, cfg.doneRepeatSec * 500)) : 10000).then((ok) => {
      if (!ok) { diag('claim-lost', { c: 'done' }); return; }
      if (cfg.doneSound) playDoneBeep();
      if (cfg.doneNotify) notify('Claude responded', title, tag, force, true, sessKey ? () => { openSession(sessKey); applyTitle(); } : null);
    });
  }
  function repeatDone() {
    if (!(titleDone || rowDone.size) || !away()) { doneAlert = null; return; }
    if (!doneAlert || !cfg.doneRepeatSec || Date.now() - doneAlert.at < cfg.doneRepeatSec * 1000) return;
    doneAlert.at = Date.now();
    fireDone(doneAlert.title, doneAlert.tag, doneAlert.force, doneAlert.sessKey);
  }
  function alertDone(title, tag, force, sessKey) {
    const now = Date.now();
    // same completion seen by both detectors (tag "claude-done" = Stop); distinct sessions don't block each other
    if (now - lastDone.at < 5000 && (lastDone.tag === tag || lastDone.tag === 'claude-done' || tag === 'claude-done')) return;
    lastDone = { tag, at: now };
    diag('alert', { tag: String(tag).slice(-14), f: force ? 1 : 0 });
    doneAlert = { title, tag, force, sessKey, at: now };
    fireDone(title, tag, force, sessKey);
  }

  // Response ready (open chat): "Stop response" button (or data-is-streaming) disappears for >=2s.
  let genSince = 0, genIdleAt = 0, genPath = location.pathname;
  function detectResponseDone() {
    const now = Date.now();
    if (location.pathname !== genPath) { genPath = location.pathname; genSince = 0; genIdleAt = 0; } // SPA switched chat: don't report the old one as done
    const stopBtn = document.querySelector('button[aria-label^="Stop" i], [data-is-streaming="true"]');
    if (stopBtn) {
      if (!genSince) { genSince = now; diag('stop+'); }
      genIdleAt = 0;
      return;
    }
    if (!genSince) return;
    if ([...qMap.values()].some((q) => q.current)) { genIdleAt = 0; return; }
    if (!genIdleAt) { genIdleAt = now; diag('stop-'); }
    if (now - genIdleAt < 2000) return;
    const dur = now - genSince;
    genSince = 0; genIdleAt = 0;
    markDone();
    if (dur < cfg.doneMinSec * 1000) { diag('too-short', { s: Math.round(dur / 1000) }); return; }
    // tag = active sidebar row (same as detectRowsDone) so Stop and sidebar share one alert and other sessions aren't suppressed; no row → global 'claude-done'
    const curRow = document.querySelector('[data-row-key] [aria-current="page"]');
    const curKey = curRow && curRow.closest('[data-row-key]').getAttribute('data-row-key');
    alertDone(document.title.replace(TITLE_PREFIX_RE, '').replace(/\s*[-–|]\s*Claude\s*$/i, ''), curKey ? 'claude-row-' + curKey : 'claude-done');
  }

  // Sidebar sessions (claude.ai/code): active `[data-row-key]` row has a dot in `[data-row-decoration]`:
  // `<span role="img" aria-label="Running"><span data-cds="Pulse">` (CSS animation dframe-dot-blink; also on the active row).
  // Indicator gone for >=2s → "done".
  const BUSY_SEL = '[data-cds="Pulse"], [aria-label="Running"]';
  // Active visible session → sound only; another session → notification even when the tab is visible.
  const rowBusy = new Map(); // data-row-key → { since, idleAt, seen, title, current }
  const rowDone = new Map(); // data-row-key → { title, at }: finished but not yet visited
  function rowLabel(row) {
    const el = row.querySelector('[data-row-label] [dir="auto"]') || row.querySelector('[data-row-label]');
    if (!el) return row.getAttribute('data-row-key') || '';
    const c = el.cloneNode(true);
    c.querySelectorAll('.sr-only').forEach((n) => n.remove());
    return (c.textContent || '').trim();
  }
  function detectRowsDone() {
    const now = Date.now();
    document.querySelectorAll('[data-row-key]').forEach((row) => {
      const key = row.getAttribute('data-row-key');
      let rec = rowBusy.get(key);
      if (!away() && row.querySelector('[aria-current="page"]')) rowDone.delete(key); // session visited
      if (row.querySelector(BUSY_SEL)) {
        rowDone.delete(key);
        if (!rec) { rowBusy.set(key, rec = { since: now, idleAt: 0, seen: now, title: '', current: false, question: false }); diag('spin+', { r: key.slice(-6) }); }
        rec.idleAt = 0; rec.seen = now; rec.title = rowLabel(row); rec.current = !!row.querySelector('[aria-current="page"]'); rec.question = false;
        return;
      }
      if (!rec) return;
      rec.seen = now;
      rec.title = rowLabel(row);
      rec.current = !!row.querySelector('[aria-current="page"]');
      if (rowHasQuestion(row)) { rowDone.delete(key); rec.idleAt = 0; rec.question = true; return; }
      rec.question = false;
      if (!rec.idleAt) { rec.idleAt = now; diag('spin-', { r: key.slice(-6) }); }
      if (now - rec.idleAt < 2000) return;
      rowBusy.delete(key);
      if (!(rec.current && !away())) rowDone.set(key, { title: rec.title, at: now });
      if (rec.current) markDone();
      if (now - rec.since < cfg.doneMinSec * 1000) { diag('too-short', { s: Math.round((now - rec.since) / 1000) }); return; }
      alertDone(rec.title, 'claude-row-' + key, !rec.current, key);
    });
    rowBusy.forEach((rec, k) => { if (now - rec.seen > 30000) rowBusy.delete(k); }); // row vanished (re-render)
    rowDone.forEach((d, k) => { if (now - d.at > 6 * 3600e3) rowDone.delete(k); });
  }

  // Session row snapshot for debugging in DevTools console:
  // __claudeDumpRows() = table, __claudeDumpRows('opus') = with HTML of matching rows.
  // Icon-font PUA and invisible chars get stripped on paste, so encode as ⟦U+XXXX⟧; keep only descriptive classes (blue/accent/spin/dot/...).
  const visChars = (t) => t.replace(/[\ue000-\uf8ff\u200b-\u200f\u2060\ufeff]/g, (c) => '⟦U+' + c.charCodeAt(0).toString(16).toUpperCase() + '⟧');
  const slimHtml = (h) => visChars(h)
    .replace(/ class="([^"]*)"/g, (m, c) => { const k = c.split(/\s+/).filter((t) => t.length < 40 && !t.includes(':') && /blue|accent|spin|anim|pulse|busy|dot|unread|status/i.test(t)); return k.length ? ` class="${k.join(' ')}"` : ''; })
    .replace(/ d="([^"]{30})[^"]*"/g, ' d="$1…"');
  function dumpRows(filter, withHtml) {
    return [...document.querySelectorAll('[data-row-key]')]
      .filter((r) => filter ? (rowLabel(r) + r.getAttribute('data-row-key')).toLowerCase().includes(String(filter).toLowerCase()) : /^code:/.test(r.getAttribute('data-row-key')))
      .slice(0, 12)
      .map((row) => {
        const all = [...row.querySelectorAll('*')];
        const o = {
          key: row.getAttribute('data-row-key').slice(-12), label: rowLabel(row), current: !!row.querySelector('[aria-current="page"]'),
          spinner: !!row.querySelector(BUSY_SEL),
          question: rowHasQuestion(row),
          cds: all.filter((e) => e.hasAttribute('data-cds')).map((e) => e.getAttribute('data-cds') + (e.textContent.trim() ? '«' + visChars(e.textContent.trim()) + '»' : '')).join(' '),
          aria: all.filter((e) => e.matches('[aria-busy],[role=progressbar],[role=status],svg')).length,
          anim: all.map((e) => getComputedStyle(e).animationName).filter((a) => a && a !== 'none').join(' ')
        };
        if (withHtml) o.html = slimHtml(row.outerHTML);
        return o;
      });
  }
  window.__claudeDumpRows = (filter) => { const out = dumpRows(filter, !!filter); console.table(out.map(({ html, ...r }) => r)); return out; };

  // 1s tick: pre/post-reset sounds and auto-clicking "Try again"
  let lastTick = 0;
  function handleTimersAndAutoClick() {
    const now = Date.now();
    if (lastTick && now - lastTick > 3000) diag('tick-gap', { s: Math.round((now - lastTick) / 1000) }); // timer throttled or tab frozen
    lastTick = now;
    tryAutoAllow();
    detectQuestions();
    detectResponseDone();
    detectRowsDone();
    repeatDone();
    if (statusNoteUntil && now > statusNoteUntil) setNote('');
    const limitUI = findLimitCardAndTryAgainBtn();

    // If a limit card is visible and API reset timestamp is unknown, parse it from card text
    if (limitUI && !state.sessionResetTs) {
      const fallbackTs = parseFallbackResetTsFromText(limitUI.text);
      if (fallbackTs) {
        state.sessionResetTs = fallbackTs;
      }
    }

    const resetTs = state.sessionResetTs;

    if (resetTs) {
      const diffMs = resetTs - now;
      if (diffMs > 60000 && state.statusNote.includes('<1 min')) setNote('');

      // 1) Alert 1 minute (60s) before session reset
      if (diffMs > 0 && diffMs <= 60 * 1000 && lastPreResetSoundTs !== resetTs) {
        lastPreResetSoundTs = resetTs;
        localStorage.setItem('claude_overlay_pre_sound_ts', String(resetTs));
        claimOnce('pre-' + resetTs, 120000).then((ok) => { if (ok && cfg.soundPre) playPreResetBeep(); });
        setNote('🔔 Session resets in <1 min!');
      }

      // 2) Alert when session recovers (0..30s window after reset)
      if (diffMs <= 0 && diffMs > -30 * 1000 && lastResetSoundTs !== resetTs) {
        lastResetSoundTs = resetTs;
        localStorage.setItem('claude_overlay_reset_sound_ts', String(resetTs));
        claimOnce('reset-' + resetTs, 120000).then((ok) => { if (ok && cfg.soundReset) playSessionResetBeep(); });
        setNote('✅ Session recovered!');
        setTimeout(updateAll, 2000);
      }

      // 3) Auto-click "Try again" after reset (+1.5s buffer for server clock skew)
      if (state.autoTryAgain && limitUI && now >= resetTs + 1500) {
        if (lastClickedCycleTs !== resetTs) {
          lastClickedCycleTs = resetTs;
          tryAgainAttemptsForCycle = 0;
        }

        if (tryAgainAttemptsForCycle < 3 && now - lastTryAgainClickTime >= 5000) {
          lastTryAgainClickTime = now;
          tryAgainAttemptsForCycle++;
          console.log(`[Claude Usage Overlay] Auto-clicking "Try again" (attempt ${tryAgainAttemptsForCycle}/3)`);
          limitUI.btn.click();
          setNote(`🔄 Clicked "Try again" (${tryAgainAttemptsForCycle}/3)`);
        }
      }
    }

    renderOverlay();
  }

  // Session list: needing attention (❓, first), working (🔄) and finished unvisited (✅) with duration; clicking opens the session. Rest = idle counter.
  function sessionsHtml() {
    if (!cfg.sessList) return '';
    const rows = [...document.querySelectorAll('[data-row-key]')].filter((r) => /^code:/.test(r.getAttribute('data-row-key')));
    if (!rows.length) return '';
    const now = Date.now(), items = [];
    let idle = 0;
    rows.forEach((r) => {
      const key = r.getAttribute('data-row-key');
      const busy = !!r.querySelector(BUSY_SEL), done = rowDone.get(key);
      if (qMap.has(key)) items.push({ key, icon: '❓', title: rowLabel(r) || qMap.get(key).title, t: now - (qMap.get(key).alertAt || now), o: -1 }); // needs attention: first
      else if (busy) items.push({ key, icon: '🔄', title: rowLabel(r), t: now - ((rowBusy.get(key) || {}).since || now), o: 0 });
      else if (done) items.push({ key, icon: '✅', title: rowLabel(r) || done.title, t: now - done.at, o: 1 });
      else idle++;
    });
    items.sort((a, b) => a.o - b.o || a.t - b.t);
    const li = items.slice(0, 8).map((i) => `
      <div data-sess="${esc(i.key)}" id="cu-s-${i.key.replace(/\W/g, '_')}" role="button" tabindex="0" aria-label="Open session: ${esc(i.title)}" title="Open session" style="display:flex;gap:5px;align-items:center;font-size:11px;cursor:pointer;padding:1px 0;">
        <span>${i.icon}</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px">${esc(i.title)}</span><small style="color:#888">${fmtDur(i.t)}</small>
      </div>`).join('');
    return `<div style="border-top:1px solid #333;padding-top:5px;margin-top:4px;">
      <div style="font-size:10px;color:#888;margin-bottom:2px">Sessions: ${items.some((i) => i.o === -1) ? items.filter((i) => i.o === -1).length + ' need attention, ' : ''}${items.filter((i) => i.o === 0).length} working, ${items.filter((i) => i.o === 1).length} ready</div>
      ${li}${items.length > 8 ? `<div style="font-size:10px;color:#888">+${items.length - 8} more</div>` : ''}
      <div style="font-size:10px;color:#666">⚪ ${idle} idle</div></div>`;
  }

  function getColorForPct(pct) {
    const num = parseInt(pct, 10);
    if (isNaN(num)) return '#aaa';
    if (num >= cfg.threshold) return '#ff5252';
    if (num >= 60) return '#ffb74d';
    return '#4caf50';
  }

  function renderProgressBar(pct) {
    const num = Math.min(100, Math.max(0, parseInt(pct, 10) || 0));
    const color = getColorForPct(num);
    return `
      <div style="width:100%;height:5px;background:#333;border-radius:3px;overflow:hidden;margin:3px 0 5px 0;">
        <div style="width:${num}%;height:100%;background:${color};transition:width 0.3s ease;"></div>
      </div>
    `;
  }

  let overlayPointerDown = false, pendingRender = false, lastRenderHtml = '';
  function renderOverlay() {
    applyTitle();
    const el = document.getElementById('claude-usage-overlay');
    if (!el) return;

    const isCritical = (state.hasContextUI && state.contextPct >= cfg.threshold) ||
                       (parseInt(state.sessionPct, 10) >= 90);
    el.classList.toggle('claude-overlay-critical', isCritical);
    el.classList.toggle('claude-overlay-question', qActive);

    if (overlayPointerDown) { pendingRender = true; return; }

    el.style.minWidth = cfg.minimized ? 'auto' : '220px';
    el.style.padding = cfg.minimized ? '5px 10px' : '10px 14px';

    let html = '';
    if (cfg.minimized) {
      const sTxt = state.sessionPct === '?' ? '?' : `${state.sessionPct}%`;
      const wTxt = state.weeklyPct === '?' ? '?' : `${state.weeklyPct}%`;
      const pill = state.error
        ? `<span style="color:#ff6b6b;font-weight:bold;">⚠️ API Error</span>`
        : `<span>📊 Weekly: <b style="color:${getColorForPct(state.weeklyPct)}">${wTxt}</b> · 5h: <b style="color:${getColorForPct(state.sessionPct)}">${sTxt}</b>${isStale() ? ' <span title="Stale data" style="color:#ff8a80">⌛</span>' : ''}</span>`;
      html = `<div style="display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:11px;">
        ${pill}
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:auto;">
          <button type="button" id="claude-min-btn" title="Expand" aria-label="Expand" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:bold;padding:0 3px;color:#ccc;">+</button>
          <button type="button" id="claude-cfg-btn" title="Settings" aria-label="Settings" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:normal;">⚙</button>
        </span>
      </div>`;
    } else if (state.error) {
      html = `
        <div style="font-weight:bold;margin-bottom:4px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#ff6b6b">⚠️ Claude API Error</span>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <button type="button" id="claude-refresh-btn" title="Refresh now" aria-label="Refresh now" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;">⟳</button>
            <button type="button" id="claude-min-btn" title="Minimize" aria-label="Minimize" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:bold;padding:0 2px;">–</button>
            <button type="button" id="claude-cfg-btn" title="Settings" aria-label="Settings" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:normal;">⚙</button>
          </span>
        </div>
        <div style="font-size:10px;color:#aaa">Last attempt: ${esc(state.lastTry || 'now')}</div>
        <div style="font-size:9px;color:#666;margin-top:5px;border-top:1px solid #333;padding-top:4px;display:flex;justify-content:space-between;">
          <span>Auto: ${cfg.refreshSec}s · v${VERSION}</span>
          <span>Click panel to retry</span>
        </div>
      `;
    } else {
      const alertBanner = (state.hasContextUI && state.contextPct >= cfg.threshold)
        ? `<div style="background:#d32f2f;color:#fff;font-weight:bold;font-size:10px;padding:3px 6px;border-radius:4px;margin-bottom:6px;text-align:center;">
             🚨 WARNING: CONTEXT ${state.contextPct}% (>=${cfg.threshold}%)
           </div>`
        : '';

      const statusBanner = state.statusNote
        ? `<div style="background:#1b3a28;color:#81c784;border:1px solid #2e7d32;font-size:10px;padding:3px 6px;border-radius:4px;margin-bottom:6px;text-align:center;">
             ${esc(state.statusNote)}
           </div>`
        : '';

      const perm = 'Notification' in window ? Notification.permission : 'granted';
      const permBanner = (cfg.doneNotify && perm !== 'granted')
        ? `<div style="background:#3a2a1b;color:#ffb74d;border:1px solid #8d5a1e;font-size:10px;padding:3px 6px;border-radius:4px;margin-bottom:6px;text-align:center;">
             🔕 ${perm === 'denied' ? 'notifications blocked (🔒 near URL → Allow)' : 'click here to enable notifications'}
           </div>`
        : '';

      const contextSection = state.hasContextUI
        ? `
          <div style="margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #333;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span>🧠 <b>Context (1M):</b></span>
              <b style="color:${getColorForPct(state.contextPct)};font-size:13px;">${state.contextPct}%</b>
            </div>
            ${renderProgressBar(state.contextPct)}
            <div style="font-size:10px;color:#aaa;text-align:right;">
              <span>${esc(state.contextText)}</span>
            </div>
          </div>
        `
        : `
          <div style="margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid #333;font-size:11px;color:#888;">
            🧠 Context: <i>Open Context panel in Claude</i>
          </div>
        `;

      html = `
        ${alertBanner}
        ${statusBanner}
        ${permBanner}
        <div style="font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:4px;">
          <span>📊 Claude Monitor</span>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <button type="button" id="claude-refresh-btn" title="Refresh now" aria-label="Refresh now" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;">⟳</button>
            <button type="button" id="claude-min-btn" title="Minimize" aria-label="Minimize" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:bold;padding:0 2px;">–</button>
            <button type="button" id="claude-cfg-btn" title="Settings" aria-label="Settings" style="background:none;border:0;color:inherit;font-family:inherit;line-height:1;cursor:pointer;font-size:13px;font-weight:normal;">⚙</button>
          </span>
        </div>

        ${contextSection}

        <div style="display:flex;justify-content:space-between;">
          <span>🕐 Session (5h):</span>
          <b style="color:${getColorForPct(state.sessionPct)}">${state.sessionPct}%</b>
        </div>
        ${renderProgressBar(state.sessionPct)}
        <div style="font-size:10px;color:#aaa;margin-bottom:6px">${formatResetTime(state.sessionResetTs, true)}</div>
        ${fcHtml('session')}

        <div style="display:flex;justify-content:space-between;">
          <span>📅 Weekly (7d):</span>
          <b style="color:${getColorForPct(state.weeklyPct)}">${state.weeklyPct}%</b>
        </div>
        ${renderProgressBar(state.weeklyPct)}
        <div style="font-size:10px;color:#aaa;margin-bottom:6px">${formatResetTime(state.weeklyResetTs, false)}</div>
        ${fcHtml('weekly')}
        ${sessionsHtml()}

        <div style="border-top:1px solid #333;padding-top:5px;margin-top:4px;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;">
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;color:#ccc;" title="Automatically clicks 'Try again' after limit reset">
              <input id="claude-auto-try-again-cb" type="checkbox" ${state.autoTryAgain ? 'checked' : ''} style="cursor:pointer;margin:0;">
              <span>Auto-click "Try again"</span>
            </label>
            <button id="claude-test-sound-btn" type="button" title="Test reset sound" style="background:#2d2d2d;color:#bbb;border:1px solid #444;border-radius:4px;padding:1px 5px;font-size:9px;cursor:pointer;">
              🔊 Test
            </button>
          </div>
          <label style="display:flex;align-items:center;gap:5px;cursor:pointer;color:${cfg.autoAllow ? '#ffb74d' : '#ccc'};font-size:10px;margin-top:4px;" title="Automatically clicks 'Allow once' (or 'Always allow' when it is the only option) on command/tool permission prompts (use carefully!)">
            <input id="claude-auto-allow-cb" type="checkbox" ${cfg.autoAllow ? 'checked' : ''} style="cursor:pointer;margin:0;">
            <span>Auto-click "Allow once" / "Always allow"</span>
          </label>
        </div>

        <div style="font-size:9px;color:#666;margin-top:5px;border-top:1px solid #333;padding-top:4px;display:flex;justify-content:space-between;">
          <span>Auto: ${cfg.refreshSec}s · v${VERSION}</span>
          <span ${isStale() ? 'style="color:#ff8a80" title="Old data or last API request failed (attempt ' + esc(state.lastTry) + ')"' : ''}>Status: ${esc(state.lastUpdated) || '...'}${isStale() ? ' ⚠ stale' : ''}</span>
        </div>
      `;
    }

    if (html === lastRenderHtml) return;
    lastRenderHtml = html;
    const focusId = el.contains(document.activeElement) ? document.activeElement.id : ''; // rebuild must not drop keyboard focus
    el.innerHTML = html;
    if (focusId) { const fe = document.getElementById(focusId); if (fe) fe.focus(); }

    // Bind events for minimize, settings, checkbox, and sound test buttons
    const minBtn = document.getElementById('claude-min-btn');
    if (minBtn) {
      minBtn.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
      minBtn.onclick = (e) => {
        e.stopPropagation();
        cfg.minimized = !cfg.minimized;
        try { localStorage.setItem('claude_overlay_cfg_v1', JSON.stringify(cfg)); } catch (err) {}
        renderOverlay();
      };
    }

    const refBtn = document.getElementById('claude-refresh-btn');
    if (refBtn) {
      refBtn.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
      refBtn.onclick = (e) => { e.stopPropagation(); updateAll(true); };
    }

    const gearBtn = document.getElementById('claude-cfg-btn');
    if (gearBtn) {
      gearBtn.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); };
      gearBtn.onclick = (e) => { e.stopPropagation(); askNotifyPermission(); openSettings(); };
    }

    const cb = document.getElementById('claude-auto-try-again-cb');
    if (cb) {
      cb.onchange = (e) => {
        state.autoTryAgain = e.target.checked;
        localStorage.setItem('claude_overlay_auto_try_again', String(state.autoTryAgain));
      };
    }

    const allowCb = document.getElementById('claude-auto-allow-cb');
    if (allowCb) {
      allowCb.onchange = (e) => {
        cfg.autoAllow = e.target.checked;
        try { localStorage.setItem('claude_overlay_cfg_v1', JSON.stringify(cfg)); } catch (err) {}
        if (cfg.autoAllow) tryAutoAllow();
        renderOverlay();
      };
    }

    const testBtn = document.getElementById('claude-test-sound-btn');
    if (testBtn) {
      testBtn.onclick = (e) => {
        e.stopPropagation();
        playSessionResetBeep();
      };
    }
  }

  // Draggable overlay with saved position (opacity is managed by applyCfg)
  function makeMovable(el, key) {
    const st = document.createElement('style');
    st.textContent = `#${el.id}{touch-action:none}`;
    document.head.appendChild(st);

    const defPos = { left: el.style.left, top: el.style.top, right: el.style.right, bottom: el.style.bottom };
    el._resetPos = () => { try { localStorage.removeItem(key); } catch (e) {} Object.assign(el.style, defPos); };
    function place(x, y) {
      x = Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    }
    try {
      const p = JSON.parse(localStorage.getItem(key));
      if (p) place(p.x, p.y);
    } catch (e) {}

    let drag = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input,label,button,[data-sess],#claude-cfg-btn,#claude-min-btn,#claude-refresh-btn')) return; // pointer capture would swallow clicks
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
      moved = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return; // normal click
      moved = true;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    el.addEventListener('pointerup', () => {
      if (drag && moved) {
        try { localStorage.setItem(key, JSON.stringify({ x: el.offsetLeft, y: el.offsetTop })); } catch (e) {}
      }
      drag = null;
    });
    // Suppress refresh click after dragging
    el.addEventListener('click', (e) => {
      if (moved) { e.stopImmediatePropagation(); moved = false; }
    }, true);
    window.addEventListener('resize', () => { if (el.style.left) place(el.offsetLeft, el.offsetTop); });
  }

  let lastApiAt = 0, updating = false, backoffMs = 0, apiBlockedUntil = 0;
  // force = manual click on overlay bypasses 429/401 backoff.
  async function updateAll(force) {
    if (updating) return; // prevent concurrent API requests
    lastApiAt = Date.now();
    const contextData = scrapeContextFromDOM();
    Object.assign(state, contextData);
    let sharedBlock = 0; // backoff shared between tabs (another tab already got 429)
    try { sharedBlock = +localStorage.getItem(BLOCK_KEY) || 0; } catch (e) {}
    if (force !== true && Date.now() < Math.max(apiBlockedUntil, sharedBlock)) { renderOverlay(); return; }
    updating = true;

    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    try {
      const prevResetTs = state.sessionResetTs;
      const usageData = await fetchUsageFromApi();
      backoffMs = 0; apiBlockedUntil = 0;
      try { localStorage.removeItem(BLOCK_KEY); } catch (e) {}
      Object.assign(state, usageData, { error: false, stale: false, lastUpdated: t });
      const now = Date.now();
      lastSuccessTs = now;
      const rolledOver = (state.sessionResetTs && state.sessionResetTs > prevResetTs + 60000) ||
        (!state.sessionResetTs && now >= prevResetTs && state.sessionPct === 0);
      if (prevResetTs && Math.abs(now - prevResetTs) < 90000 && rolledOver && lastResetSoundTs !== prevResetTs) {
        lastResetSoundTs = prevResetTs;
        try { localStorage.setItem('claude_overlay_reset_sound_ts', String(prevResetTs)); } catch (e) {}
        claimOnce('reset-' + prevResetTs, 120000).then((ok) => { if (ok && cfg.soundReset) playSessionResetBeep(); });
        setNote('✅ Session recovered!');
      }
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify({
          sessionPct: state.sessionPct,
          sessionResetTs: state.sessionResetTs,
          weeklyPct: state.weeklyPct,
          weeklyResetTs: state.weeklyResetTs,
          extraEnabled: state.extraEnabled,
          extraPct: state.extraPct,
          extraUsed: state.extraUsed,
          extraLimit: state.extraLimit,
          lastUpdated: state.lastUpdated,
          orgId: cachedOrgId,
          fetchedAt: now
        }));
      } catch (e) {}
      recordHist('session', state.sessionPct); recordHist('weekly', state.weeklyPct);
      checkForecast();
    } catch (err) {
      console.error('[Claude Usage Overlay]', err);
      // keep existing values marked as stale; show full error only when nothing was loaded yet
      state.stale = true;
      state.lastTry = t;
      if (state.sessionPct === '?') state.error = true;
      if (err && err.backoff) { // 429/401: double interval (start at 2× refreshSec), max 10 min
        backoffMs = Math.min(600000, backoffMs ? backoffMs * 2 : Math.max(2, cfg.refreshSec) * 2000);
        backoffMs = Math.min(600000, Math.max(backoffMs, err.retryAfterMs || 0));
        apiBlockedUntil = Date.now() + backoffMs;
        try { localStorage.setItem(BLOCK_KEY, String(apiBlockedUntil)); } catch (e) {}
        diag('backoff', { s: Math.round(backoffMs / 1000) });
      }
    } finally { updating = false; }
    renderOverlay();
  }

  function initOverlay() {
    const prev = document.getElementById('claude-usage-overlay');
    if (prev) {
      if (prev.dataset.ver !== VERSION && !document.getElementById('claude-usage-dup-warn')) {
        const w = document.createElement('div');
        w.id = 'claude-usage-dup-warn';
        w.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483647;background:#3a1f1b;color:#ffd0c7;border:1px solid #ff6b6b;border-radius:6px;padding:6px 10px;font:11px/1.35 sans-serif;max-width:300px;box-shadow:0 4px 12px rgba(0,0,0,.6);cursor:pointer;';
        w.textContent = `⚠️ Duplicate Claude script in Tampermonkey (${prev.dataset.ver || '≤2.11'} blocks v${VERSION}). Remove the older copy in Tampermonkey Dashboard.`;
        w.title = 'Click to dismiss';
        w.onclick = () => w.remove();
        document.body.appendChild(w);
      }
      return;
    }
    injectStyles();

    const overlay = document.createElement('div');
    overlay.id = 'claude-usage-overlay';
    overlay.dataset.ver = VERSION;
    overlay.style.cssText = `
      position:fixed; bottom:80px; right:16px; z-index:999999;
      background:#1e1e1e; color:#e0e0e0; padding:10px 14px;
      border-radius:8px; font-size:12px; border:1px solid #444;
      min-width:220px; line-height:1.4; cursor:pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5); user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: background 0.3s ease, border-color 0.3s ease, opacity 0.2s ease;
    `;
    overlay.textContent = 'Loading monitor...';
    overlay.title = 'Click overlay background to refresh manually; drag to move';
    overlay.addEventListener('pointerdown', () => { overlayPointerDown = true; }, true);
    const clearPointerDown = () => {
      if (!overlayPointerDown) return;
      overlayPointerDown = false;
      if (pendingRender) {
        pendingRender = false;
        setTimeout(() => { if (!overlayPointerDown) renderOverlay(); }, 0);
      }
    };
    ['pointerup', 'pointercancel', 'mouseleave'].forEach((ev) => overlay.addEventListener(ev, clearPointerDown));
    ['pointerup', 'pointercancel'].forEach((ev) => window.addEventListener(ev, clearPointerDown));
    overlay.onclick = (e) => {
      if (e.target.closest('input, label, button, [data-sess], #claude-cfg-btn, #claude-min-btn')) return;
      askNotifyPermission();
      updateAll(true);
    };
    overlay.addEventListener('click', (e) => { // jump to session from list (delegated: list re-renders every second)
      const it = e.target.closest('[data-sess]');
      if (!it) return;
      e.stopImmediatePropagation();
      openSession(it.getAttribute('data-sess'));
      renderOverlay();
    }, true);
    overlay.addEventListener('keydown', (e) => { // R10: session rows are role=button — Enter/Space open the session
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const it = e.target.closest && e.target.closest('[data-sess]');
      if (!it) return;
      e.preventDefault();
      openSession(it.getAttribute('data-sess'));
      renderOverlay();
    });
    document.body.appendChild(overlay);
    makeMovable(overlay, 'claude_overlay_pos_v1');

    updateAll();
    applyCfg();
    // Background tab polls API at most once per minute (needed for % in title); refreshes immediately on return.
    (function loopApi() {
      setTimeout(() => {
        const hiddenThrottle = document.hidden && Date.now() - lastApiAt < 60000;
        const sharedFresh = Date.now() - lastSuccessTs < Math.max(0, cfg.refreshSec - 2) * 1000;
        if (!hiddenThrottle && !sharedFresh) updateAll();
        loopApi();
      }, Math.max(2, cfg.refreshSec) * 1000);
    })();
    document.addEventListener('visibilitychange', () => { diag('vis'); if (!document.hidden) { clearDone(); updateAll(); } });
    ['pointerdown', 'keydown', 'focus'].forEach((ev) => window.addEventListener(ev, clearDone, true));
    // Page itself updates <title> (SPA) — re-apply our prefix
    try { new MutationObserver(applyTitle).observe(document.head, { childList: true, subtree: true, characterData: true }); } catch (e) {}
    // Event-driven detection: MutationObserver is not throttled in background tabs (chained setInterval is after ~5 min),
    // and a one-shot setTimeout from its callback is not chained, so the ">=2s idle" confirmation fires on time.
    let detT = 0, mutHid = 0, mutHidAt = 0;
    const schedDet = (ms) => { if (!detT) detT = setTimeout(runDet, ms); };
    function runDet() {
      detT = 0;
      tryAutoAllow(); detectQuestions(); detectResponseDone(); detectRowsDone(); applyTitle();
      if (genIdleAt || [...rowBusy.values()].some((r) => r.idleAt)) schedDet(2100);
    }
    try {
      new MutationObserver((recs) => {
        if (!recs.some((m) => !overlay.contains(m.target))) return; // skip our own 1s renders
        if (document.hidden) { mutHid++; const n = Date.now(); if (n - mutHidAt > 30000) { diag('mut-hidden', { c: mutHid }); mutHidAt = n; mutHid = 0; } }
        schedDet(500);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-cds', 'data-is-streaming', 'aria-label', 'aria-current', 'data-testid', 'data-approval-allow'] });
    } catch (e) {}
    setInterval(handleTimersAndAutoClick, TICK_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOverlay);
  } else {
    initOverlay();
  }
})();
