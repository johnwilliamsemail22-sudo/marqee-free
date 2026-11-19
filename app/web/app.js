/* ClipIt — vanilla JS app. Views: Live, Clips, Files, Settings. */
'use strict';

/* ---------------- tiny DOM helpers ---------------- */
function h(tag, props = {}, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.6 7.6 20 18M8.6 16.4 20 6"/>',
  clips: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="m10.5 9.5 4 2.5-4 2.5z"/>',
  live: '<circle cx="12" cy="12" r="2.5"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5"/>',
  files: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1-.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  play: '<path d="m7 4 13 8-13 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  download: '<path d="M12 4v12m0 0-5-5m5 5 5-5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  camera: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10.5 5-3v9l-5-3"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
};
function icon(name, extra = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  if (extra) s.setAttribute('class', extra);
  s.innerHTML = ICONS[name] || '';
  return s;
}

/* ---------------- formatting ---------------- */
const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtTime = (s) => { s = Math.max(0, s || 0); const hh = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const ss = Math.floor(s % 60); return `${hh ? hh + ':' : ''}${String(m).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`; };
const ago = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(d)) return '';
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function debounce(fn, ms = 350) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------- toast + api ---------------- */
function toast(text, kind = '') {
  const box = $('#toast'); if (!box) return;
  const el = h('div' + (kind ? '.' + kind : ''), {}, text);
  box.append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3800);
}

const KEYQ = new URLSearchParams(location.search).get('key') || '';
const authHeaders = () => (KEYQ ? { 'x-key': KEYQ } : {});
async function api(path, body, { quiet = false, method = null } = {}) {
  const opts = body !== undefined
    ? { method: method || 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }
    : (method || KEYQ ? { method: method || 'GET', headers: authHeaders() } : undefined);
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { if (!quiet) toast('Network error — the ClipIt server is not reachable.', 'err'); throw e; }
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    if (!quiet) toast(msg, 'err');
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return data;
}
// run an async action, swallowing errors after api() has toasted them
const guard = (fn) => Promise.resolve().then(fn).catch(() => {});

/* ---------------- app state + polling ---------------- */
const S = { state: null, view: 'live', cleanup: null, pollTimer: null, updating: false };
const BUSY_STATUSES = ['queued', 'processing', 'transcribing', 'rendering', 'covers'];
const isBusy = (c) => BUSY_STATUSES.includes(c.status);
const anyBusy = (s) => !!(s && (s.recording || (s.clips || []).some(isBusy)));
const streams = () => (S.state && S.state.streams) || [];
const clips = () => (S.state && S.state.clips) || [];

function onData() { paintLiveChip(); if (S.onData) guard(() => S.onData()); }

function schedulePoll() {
  clearTimeout(S.pollTimer);
  if (anyBusy(S.state)) S.pollTimer = setTimeout(() => guard(pollOnce), 2000);
}
async function pollOnce() {
  try { S.state = await api('/api/state', undefined, { quiet: true }); onData(); } catch { /* server not up yet */ }
  schedulePoll();
}
const kick = () => guard(pollOnce);

function paintLiveChip() {
  const chip = $('#liveChip');
  const st = streams()[0];
  if (st && st.recording !== false && (S.state && S.state.recording)) {
    chip.classList.remove('hidden');
    chip.innerHTML = '';
    chip.append(h('span.rec-dot'), h('span.txt', {}, st.label || st.channel || 'live'));
  } else chip.classList.add('hidden');
}

/* ---------------- router ---------------- */
const VIEWS = {
  live: { label: 'Live', render: null }, clips: { label: 'Clips', render: null },
  files: { label: 'Files', render: null }, settings: { label: 'Settings', render: null },
};
function go(name) {
  if (!VIEWS[name]) name = 'live';
  S.view = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.v === name));
  if (typeof S.cleanup === 'function') { try { S.cleanup(); } catch { /* ignore */ } S.cleanup = null; }
  S.onData = null;
  const root = $('#view');
  root.classList.remove('entering');
  root.innerHTML = '';
  S.cleanup = VIEWS[name].render(root) || null;
  requestAnimationFrame(() => root.classList.add('entering'));
}

/* ---------------- chart (smooth area + spike markers) ---------------- */
const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
function smoothPath(ctx, pts, floorY) {
  if (!pts.length) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const t = 0.18;
    const c1 = [p1[0] + (p2[0] - p0[0]) * t, Math.min(floorY, p1[1] + (p2[1] - p0[1]) * t)];
    const c2 = [p2[0] - (p3[0] - p1[0]) * t, Math.min(floorY, p2[1] - (p3[1] - p1[1]) * t)];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p2[0], p2[1]);
  }
}
function drawArea(canvas, values, { markers = [], labelFor = null } = {}) {
  const r = canvas.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, H = r.height;
  ctx.clearRect(0, 0, w, H);
  const pad = { l: 34, r: 10, t: 14, b: 22 };
  const iw = w - pad.l - pad.r, ih = H - pad.t - pad.b;
  const n = Math.max(2, values.length);
  const maxV = Math.max(1, ...values.map((v) => v || 0)) * 1.15;
  const x = (i) => pad.l + (i / (n - 1)) * iw;
  const y = (v) => pad.t + ih - (Math.max(0, v || 0) / maxV) * ih;

  // grid + y labels
  ctx.strokeStyle = cssVar('--line', 'rgba(255,255,255,.07)'); ctx.lineWidth = 1;
  ctx.fillStyle = cssVar('--faint', '#63636a'); ctx.font = '10.5px Inter, system-ui, sans-serif';
  for (let g = 0; g <= 4; g++) {
    const yy = pad.t + (ih * g) / 4;
    ctx.beginPath(); ctx.setLineDash([3, 5]); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); ctx.setLineDash([]);
    const val = maxV * (1 - g / 4);
    ctx.textAlign = 'right'; ctx.fillText(val >= 10 ? String(Math.round(val)) : val.toFixed(1), pad.l - 7, yy + 4);
  }
  if (labelFor) {
    ctx.textAlign = 'center';
    const ticks = Math.min(6, n);
    for (let k = 0; k < ticks; k++) {
      const i = Math.round((k / Math.max(1, ticks - 1)) * (n - 1));
      ctx.fillText(labelFor(i), Math.min(w - pad.r - 16, Math.max(pad.l + 16, x(i))), H - 6);
    }
  }
  const pts = values.map((v, i) => [x(i), y(v)]);
  if (pts.length >= 2) {
    // area fill
    ctx.beginPath(); smoothPath(ctx, pts, pad.t + ih);
    ctx.lineTo(pts[pts.length - 1][0], pad.t + ih); ctx.lineTo(pts[0][0], pad.t + ih); ctx.closePath();
    const fg = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
    fg.addColorStop(0, 'rgba(255,216,77,.30)'); fg.addColorStop(1, 'rgba(255,216,77,0)');
    ctx.fillStyle = fg; ctx.fill();
    // line
    ctx.beginPath(); smoothPath(ctx, pts, pad.t + ih);
    ctx.strokeStyle = cssVar('--accent', '#ffd84d'); ctx.lineWidth = 2; ctx.stroke();
  }
  // spike markers: drop line + dot
  for (const m of markers) {
    if (m.i < 0 || m.i >= n) continue;
    const mx = x(m.i), my = y(values[m.i] || 0);
    const g = ctx.createLinearGradient(0, my, 0, pad.t + ih);
    g.addColorStop(0, 'rgba(255,216,77,.5)'); g.addColorStop(1, 'rgba(255,216,77,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx, pad.t + ih); ctx.stroke();
    ctx.fillStyle = cssVar('--accent', '#ffd84d');
    ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cssVar('--bg', '#0b0b0d'); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI * 2); ctx.stroke();
    if (m.label) {
      ctx.font = '600 10.5px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(m.label).width + 14;
      const bx = Math.min(w - pad.r - tw, Math.max(pad.l, mx - tw / 2)), by = Math.max(2, my - 30);
      ctx.fillStyle = '#26262a';
      ctx.beginPath(); ctx.roundRect(bx, by, tw, 20, 10); ctx.fill();
      ctx.strokeStyle = cssVar('--line-2', 'rgba(255,255,255,.12)'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(bx, by, tw, 20, 10); ctx.stroke();
      ctx.fillStyle = cssVar('--text', '#f2f2f3'); ctx.textAlign = 'center';
      ctx.fillText(m.label, bx + tw / 2, by + 13.5);
    }
  }
}
// spike indices: clip spikeAt mapped onto history ticks
function spikeIndices(session) {
  const hist = session.history || [];
  if (!hist.length) return [];
  const times = hist.map((p) => p.t);
  const marks = new Set();
  for (const c of session.clips || []) {
    if (c.spikeAt == null) continue;
    let best = 0, bd = Infinity;
    times.forEach((t, i) => { const d = Math.abs(t - c.spikeAt); if (d < bd) { bd = d; best = i; } });
    if (bd < 30) marks.add(best);
  }
  return [...marks].map((i) => ({ i, label: hist[i] && hist[i].mps != null ? `${hist[i].mps.toFixed(1)}/s` : '' }));
}

/* ---------------- clip card ---------------- */
function scoreClass(score) {
  if (score >= 70) return 'top';
  if (score >= 40) return 'mid';
  return '';
}
function reasonText(c) {
  if (c.reason && c.reason.text) return c.reason.text;
  if (c.reason && c.reason.mps != null) return `Chat ${c.reason.mps.toFixed(1)} msg/s`;
  return c.channel || '';
}
function clipCard(c, onClick) {
  const thumb = (c.covers && c.covers[0]) || null;
  const busy = isBusy(c);
  const card = h('div.clipcard', { 'data-id': c.id, title: reasonText(c), onclick: () => onClick && onClick(c) },
    h('div.thumb', {},
      thumb ? h('img', { src: thumb, loading: 'lazy', alt: '' }) : h('div.ph-t', {}, icon('clips')),
      h('div.shade'),
      c.virality ? h('span.vscore', { class: scoreClass(c.virality.score) }, icon('trend'), String(c.virality.score)) : null,
      h('span.dur', {}, fmtDur((c.end || 0) - (c.start || 0))),
      busy || c.status === 'error' ? cardOverlay(c) : null),
    h('div.meta', {},
      h('div.t', {}, c.title || c.hook || c.channel || 'Clip'),
      h('div.w', {}, `${fmtTime(c.spikeAt != null ? c.spikeAt : c.start)} · ${reasonText(c)}`)));
  return card;
}
function cardOverlay(c) {
  if (c.status === 'error') {
    return h('div.cardprog', {}, h('div.in', {},
      h('div', { style: { color: 'var(--red)', fontWeight: 700 } }, 'Failed'),
      h('div.small', {}, (c.error || '').slice(0, 70))));
  }
  const label = { queued: 'Queued', processing: 'Processing', transcribing: 'Captions', rendering: 'Rendering', covers: 'Covers' }[c.status] || c.status;
  return h('div.cardprog', { 'data-prog': c.id }, h('div.in', {},
    h('span.spin', { style: { width: '18px', height: '18px' } }),
    h('div', {}, label),
    c.status !== 'queued' && c.progress != null ? h('div.progress', { style: { width: '70%' } }, h('i', { style: { width: `${Math.round((c.progress || 0) * 100)}%` } })) : null));
}

/* ================================================================
   LIVE view
================================================================ */
const LAYOUTS = [
  ['facecam', 'Facecam + game'], ['reaction', 'Game + facecam'], ['split', 'Split 50/50'], ['face', 'Face only'],
  ['center', 'Center crop'], ['blur', 'Blurred fit'],
];
function detectPlatform(v) {
  const s = (v || '').toLowerCase();
  if (/kick\.com/.test(s)) return 'kick';
  if (/youtube\.com|youtu\.be/.test(s)) return 'youtube';
  if (/twitch\.tv/.test(s)) return 'twitch';
  return null;
}
function paintRange(r) { r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`); }

function renderLive(root) {
  let builtFor = null; // 'idle' | 'rec'
  let ui = null;

  function buildIdle() {
    builtFor = 'idle';
    root.innerHTML = '';
    const chInput = h('input.input', { placeholder: 'Paste a Twitch, Kick or YouTube channel or link', spellcheck: 'false' });
    const platSel = h('select.input', { style: { maxWidth: '130px' } },
      h('option', { value: 'auto' }, 'Auto'),
      h('option', { value: 'twitch' }, 'Twitch'),
      h('option', { value: 'kick' }, 'Kick'),
      h('option', { value: 'youtube' }, 'YouTube'));
    const laySel = h('select.input', {},
      LAYOUTS.map(([v, l]) => h('option', { value: v }, l)));
    const sens = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 });
    paintRange(sens);
    const sensLbl = h('span.chip', {}, '50% · Medium');
    sens.addEventListener('input', () => {
      paintRange(sens);
      const v = Number(sens.value);
      sensLbl.textContent = `${Math.round(v * 100)}% · ${v < 0.35 ? 'Low' : v < 0.7 ? 'Medium' : 'High'}`;
    });
    chInput.addEventListener('input', () => { const p = detectPlatform(chInput.value); if (p) platSel.value = p; });
    const errBox = h('div');
    const btn = h('button.btn.primary.big', {}, icon('play'), 'Start recording');
    btn.addEventListener('click', () => guard(async () => {
      const channel = chInput.value.trim();
      if (!channel) { errBox.innerHTML = ''; errBox.append(h('div.msg.err', {}, 'Paste a channel or link first.')); return; }
      btn.disabled = true; btn.innerHTML = ''; btn.append(h('span.spin'), 'Connecting…');
      try {
        const body = { channel };
        if (platSel.value !== 'auto') body.platform = platSel.value;
        body.layout = laySel.value;
        body.sensitivity = Number(sens.value);
        S.state = await api('/api/start', body);
        toast(`Recording ${channel}`);
        build();
        onData();
      } catch { /* toasted */ }
      btn.disabled = false; btn.innerHTML = ''; btn.append(icon('play'), 'Start recording');
    }));
    chInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });

    const steps = h('div.steps', {},
      ['Paste a channel', 'Chat spikes', 'Post the Short'].map((t, i) => h('div.step', {},
        h('span.n', {}, String(i + 1)),
        h('div', {}, h('h3', {}, t), h('p', {}, [
          'Paste a Twitch, Kick or YouTube channel and press Start. ClipIt records into a short buffer and reads the chat.',
          'When chat suddenly speeds up, it cuts from just before the moment to a natural pause — one spike, one clip.',
          'The clip is framed, captioned and has a cover. Export it in one click and post it while the stream goes on.',
        ][i])))));

    root.append(
      h('div.panel', {},
        h('div.ph', {}, h('h2.grow', {}, 'Clip a live stream'), h('span.chip.gold', {}, 'Unlimited streams · Free')),
        h('div.field', {}, h('label', {}, 'Channel'), h('div.row', {}, chInput, platSel)),
        h('div.row', { style: { marginTop: '12px', flexWrap: 'wrap' } },
          h('div.field.grow', { style: { minWidth: '180px' } }, h('label', {}, 'Layout'), laySel),
          h('div.field.grow', { style: { minWidth: '220px' } },
            h('label', {}, 'Sensitivity'), h('div.row', {}, sens, sensLbl))),
        h('div', { style: { marginTop: '16px' } }, btn), errBox),
      autopilotPanel(),
      h('div', { style: { marginTop: '18px' } }, h('h3', { style: { margin: '0 0 10px', color: 'var(--muted)' } }, 'How it works'), steps));
  }

  // ---- auto-pilot: the watchlist. ClipIt watches these channels by itself,
  // starts recording the moment they go live, clips automatically, and stops
  // when the stream ends. You just come here and download the clips.
  function autopilotPanel() {
    const input = h('input.input', { placeholder: 'Add a channel to auto-pilot — paste a Twitch, Kick or YouTube link' });
    const platSel2 = h('select.input', { style: { maxWidth: '130px' } },
      h('option', { value: 'auto' }, 'Auto'),
      h('option', { value: 'twitch' }, 'Twitch'),
      h('option', { value: 'kick' }, 'Kick'),
      h('option', { value: 'youtube' }, 'YouTube'));
    input.addEventListener('input', () => { const p = detectPlatform(input.value); if (p) platSel2.value = p; });
    const addBtn = h('button.btn.primary', {}, icon('play'), 'Put on auto-pilot');
    const list = h('div.aplist', {});
    const err = h('div');
    addBtn.addEventListener('click', () => guard(async () => {
      const v = input.value.trim();
      if (!v) { err.innerHTML = ''; err.append(h('div.msg.err', {}, 'Paste a channel first.')); return; }
      addBtn.disabled = true;
      try {
        const body = { channel: v };
        if (platSel2.value !== 'auto') body.platform = platSel2.value;
        await api('/api/watchlist', body);
        input.value = ''; platSel2.value = 'auto';
        toast(`${v} is on auto-pilot — I'll clip it whenever it's live`);
        await pollOnce();
      } catch { /* toasted */ }
      addBtn.disabled = false;
    }));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
    const paintList = () => {
      list.innerHTML = '';
      const entries = (S.state && S.state.watchlist) || [];
      if (!entries.length) {
        list.append(h('div.hint', {}, 'Nobody on auto-pilot yet. Add channels and ClipIt keeps watch: records when they go live, clips the spikes, stops when they end — no buttons, ever.'));
        return;
      }
      for (const w of entries) {
        const chip = w.recording ? h('span.chip.green', {}, h('span.dot'), 'recording') : h('span.chip', {}, h('span.dot'), 'waiting for live');
        const rm = h('button.btn.sm.danger', {}, 'Remove');
        rm.addEventListener('click', () => guard(async () => {
          await api(`/api/watchlist/${encodeURIComponent(w.channel)}`, undefined, { method: 'DELETE' });
          await pollOnce();
        }));
        list.append(h('div.aprow', {},
          h('div.apmain', {}, h('b', {}, w.label), h('span.small.muted', {}, ` · ${w.clips || 0} clip${(w.clips || 0) === 1 ? '' : 's'} this session`)),
          chip, rm));
      }
    };
    const prev = () => { paintList(); };
    S.onData = () => { if (S.view === 'live' && builtFor === 'idle') prev(); };
    paintList();
    S.apTimer = setInterval(() => { if (builtFor === 'idle') guard(pollOnce); }, 6000);
    return h('div.panel', { style: { marginTop: '18px' } },
      h('div.ph', {}, h('h2.grow', {}, 'Auto-pilot'), h('span.chip.green', {}, 'runs by itself')),
      h('div.row', { style: { flexWrap: 'wrap' } }, h('div.field.grow', { style: { minWidth: '220px' } }, input), platSel2, addBtn),
      h('div', { style: { marginTop: '10px' } }, err),
      h('div', { style: { marginTop: '12px' } }, list));
  }

  function buildRec() {
    builtFor = 'rec';
    root.innerHTML = '';
    ui = {};
    const selSel = h('select.input', { style: { maxWidth: '220px' }, onchange: () => { ui.sel = selSel.value; paintRec(); } });
    ui.selSel = selSel;

    // stat cards
    const stat = (label, id) => {
      const value = h('div.value.num', {}, '–');
      ui[id] = value;
      return h('div.stat', {}, h('div.label', {}, label), value);
    };
    ui.statMps = stat('Chat now', 'vMps');
    ui.statMsgs = stat('Messages', 'vMsgs');
    ui.statBuf = stat('Buffer', 'vBuf');
    ui.statDisk = stat('Disk', 'vDisk');

    // chart
    ui.canvas = h('canvas');
    ui.chartBox = h('div.chart', { style: { height: '230px' } }, ui.canvas);
    ui.chartPanel = h('div.panel', { style: { marginTop: '16px' } },
      h('div.ph', {}, h('h2.grow', {}, 'Chat activity'),
        h('div.legend', {}, h('span', {}, h('i', { style: { background: 'var(--accent)' } }), 'msg/s'),
          h('span', {}, h('i', { style: { background: 'var(--faint)' } }), 'clip'))),
      ui.chartBox);

    // ticker
    ui.ticker = h('div.ticker');
    const tickerPanel = h('div.panel', { style: { marginTop: '16px' } },
      h('div.ph', {}, h('h2.grow', {}, 'Chat'), h('span.chip', {}, 'last 15')), ui.ticker);

    // session control panel
    ui.chatChip = h('span.chip.amber', {}, h('span.dot'), 'chat');
    ui.recChip = h('span.chip.amber', {}, h('span.dot'), 'rec');
    ui.sessionErr = h('div');
    ui.clipBtn = h('button.btn.primary.big', { style: { width: 'auto' } }, icon('scissors'), 'Clip that');
    ui.clipBtn.addEventListener('click', () => guard(async () => {
      const st = cur(); if (!st) return;
      ui.clipBtn.disabled = true;
      try { const r = await api('/api/clip-now', { sessionId: st.id }); toast(r.readyIn != null ? `Clip cutting — ready in ~${Math.round(r.readyIn)}s` : 'Clip cut'); }
      finally { ui.clipBtn.disabled = false; kick(); }
    }));
    ui.stopBtn = h('button.btn.danger.big', { style: { width: 'auto' } }, icon('stop'), 'Stop');
    ui.stopBtn.addEventListener('click', () => guard(async () => {
      const st = cur(); if (!st) return;
      ui.stopBtn.disabled = true;
      try { await api('/api/stop', { sessionId: st.id }); toast('Stopped'); }
      finally { ui.stopBtn.disabled = false; kick(); }
    }));
    ui.sens = h('input', { type: 'range', min: 0, max: 1, step: 0.01 });
    ui.sensLbl = h('span.chip', {}, '');
    ui.sensDirty = false;
    ui.sens.addEventListener('input', () => {
      paintRange(ui.sens); ui.sensDirty = true;
      const v = Number(ui.sens.value);
      ui.sensLbl.textContent = `${Math.round(v * 100)}% · ${v < 0.35 ? 'Low' : v < 0.7 ? 'Medium' : 'High'}`;
      liveSens();
    });
    const liveSens = debounce(() => guard(async () => {
      if (!ui.sensDirty) return;
      ui.sensDirty = false;
      S.state = await api('/api/settings', { sensitivity: Number(ui.sens.value) });
    }), 500);

    ui.statusRows = h('div.col', { style: { gap: '8px' } });
    ui.clipsRow = h('div.cliprow');
    ui.clipsPanel = h('div.panel', { style: { marginTop: '16px' } },
      h('div.ph', {}, h('h2.grow', {}, 'Clips this session'),
        h('button.btn.sm.ghost', { onclick: () => go('clips') }, 'All clips')), ui.clipsRow);

    const control = h('div.panel', {},
      h('div.ph', {}, h('h2.grow', {}, 'Session'), ui.chatChip, ui.recChip),
      ui.sessionErr,
      h('div.row', { style: { flexWrap: 'wrap', gap: '10px' } }, ui.clipBtn, ui.stopBtn),
      h('div.field', { style: { marginTop: '14px' } },
        h('label', {}, 'Sensitivity'), h('div.row', {}, ui.sens, ui.sensLbl)),
      h('div.field', { style: { marginTop: '14px' } }, h('label', {}, 'Record another stream (unlimited)'), selSel),
      ui.statusRows);

    root.append(h('div.stats', {}, ui.statMps, ui.statMsgs, ui.statBuf, ui.statDisk),
      control, ui.chartPanel, tickerPanel, ui.clipsPanel);
    paintRec();
  }

  const cur = () => {
    const list = streams();
    if (!list.length) return null;
    return list.find((x) => x.id === ui.sel) || list[0];
  };

  function paintRec() {
    const st = cur();
    if (!st) return;
    // session picker
    ui.selSel.innerHTML = '';
    for (const s of streams()) ui.selSel.append(h('option', { value: s.id, selected: s.id === (st && st.id) }, s.label || s.channel || s.id));
    // chips
    const setChip = (el, ok, txt) => { el.className = 'chip ' + (ok ? 'green' : 'amber'); el.innerHTML = ''; el.append(h('span.dot'), txt); };
    setChip(ui.chatChip, st.chat === 'connected', st.chat || 'connecting');
    setChip(ui.recChip, st.rec === 'recording', st.rec || 'idle');
    ui.sessionErr.innerHTML = '';
    if (st.error) ui.sessionErr.append(h('div.msg.warn', {}, st.error));
    // stats
    const hist = st.history || [];
    const last = hist[hist.length - 1] || {};
    ui.vMps.textContent = last.mps != null ? last.mps.toFixed(1) : '0.0';
    ui.vMps.append(h('small', {}, 'msg/s'));
    ui.vMsgs.textContent = (st.messages || 0).toLocaleString();
    ui.vBuf.innerHTML = '';
    ui.vBuf.append(fmtDur(st.bufferSec || 0), h('small', {}, '/ 4:00'));
    ui.vDisk.innerHTML = '';
    ui.vDisk.append(String(st.diskMB || 0), h('small', {}, 'MB'));
    if (!ui.sensDirty) { ui.sens.value = st.sensitivity != null ? st.sensitivity : 0.5; paintRange(ui.sens); ui.sensLbl.textContent = `${Math.round(Number(ui.sens.value) * 100)}%`; }
    // status rows
    ui.statusRows.innerHTML = '';
    const row = (k, v) => h('div.row', {}, h('span.lbl.grow', {}, k), h('span.num', {}, v));
    ui.statusRows.append(
      row('Channel', st.label || st.channel || '–'),
      row('Platform', st.platform || '–'),
      row('Buffer target', '240 s'),
      row('Layout', st.layout || 'default'));
    paintChart();
    paintTicker(st);
    paintSessionClips(st);
  }

  function paintChart() {
    const st = cur();
    const hist = st ? (st.history || []).slice(-300) : [];
    const vals = hist.map((p) => p.mps || 0);
    while (vals.length < 60) vals.unshift(0);
    const off = vals.length - hist.length;
    const markers = spikeIndices(st || {}).map((m) => ({ i: m.i + off, label: m.label }));
    const t0 = hist.length ? hist[hist.length - 1].t : 0;
    drawArea(ui.canvas, vals, {
      markers,
      labelFor: (i) => {
        const hi = i - off;
        if (hi < 0 || hi >= hist.length) return '';
        const back = Math.max(0, t0 - hist[hi].t);
        return back < 1 ? 'now' : `-${fmtDur(back)}`;
      },
    });
  }

  function paintTicker(st) {
    const lines = (st.chatLines || []).slice(-15);
    const atBottom = ui.ticker.scrollTop + ui.ticker.clientHeight >= ui.ticker.scrollHeight - 30;
    ui.ticker.innerHTML = '';
    for (const line of lines) {
      const sep = line.indexOf(':');
      const who = sep > 0 ? line.slice(0, sep) : '';
      const msg = sep > 0 ? line.slice(sep + 1).trim() : line;
      ui.ticker.append(h('div', {}, who ? h('b', {}, who) : null, h('span', {}, msg)));
    }
    if (atBottom) ui.ticker.scrollTop = ui.ticker.scrollHeight;
  }

  function paintSessionClips(st) {
    ui.clipsRow.innerHTML = '';
    const list = clips().filter((c) => !st || !c.sessionId || c.sessionId === st.id).slice(0, 12);
    if (!list.length) ui.clipsRow.append(h('div.empty', { style: { width: '100%' } }, icon('scissors'), h('div', {}, 'No clips yet — chat will trigger them, or press “Clip that”.')));
    for (const c of list) ui.clipsRow.append(clipCard(c, () => openEditor(c.id)));
  }

  function build() {
    const rec = !!(S.state && S.state.recording && streams().length);
    if (rec) { if (builtFor !== 'rec') buildRec(); else paintRec(); }
    else if (builtFor !== 'idle') buildIdle();
  }

  S.onData = () => {
    if (S.view !== 'live') return;
    build();
  };
  const ro = new ResizeObserver(() => { if (builtFor === 'rec') paintChart(); });
  ro.observe(root);
  build();
  return () => ro.disconnect();
}

/* ================================================================
   CLIPS view
================================================================ */
function renderClips(root) {
  let sort = 'new';
  const grid = h('div.clipgrid');
  const count = h('span.small.muted', {}, '');
  const segBtn = (btn) => { segSort.querySelectorAll('button').forEach((b) => b.classList.remove('active')); btn.classList.add('active'); };
  const segSort = h('div.seg', {},
    h('button', { class: 'active', onclick: (e) => { sort = 'new'; segBtn(e.currentTarget); paint(); } }, 'Newest'),
    h('button', { onclick: (e) => { sort = 'score'; segBtn(e.currentTarget); paint(); } }, 'Score'));

  function paint() {
    let list = clips();
    count.textContent = `${list.length} clip${list.length === 1 ? '' : 's'} · ${list.filter((c) => c.status === 'done').length} ready`;
    if (sort === 'score') list = [...list].sort((a, b) => ((b.virality && b.virality.score) || -1) - ((a.virality && a.virality.score) || -1));
    else list = [...list].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    grid.innerHTML = '';
    if (!list.length) {
      grid.append(h('div.empty', { style: { gridColumn: '1/-1' } }, icon('clips'),
        h('div', {}, 'No clips yet. Start a live session or drop a VOD in Files.')));
      return;
    }
    for (const c of list) grid.append(clipCard(c, () => openEditor(c.id)));
  }

  const bar = h('div.row', { style: { marginBottom: '16px', flexWrap: 'wrap' } }, segSort, count);
  root.append(bar, grid);
  let sig = '';
  S.onData = () => {
    if (S.view !== 'clips') return;
    const s = clips().map((c) => `${c.id}:${c.status}:${Math.round((c.progress || 0) * 20)}:${(c.covers || []).length}:${c.title || ''}`).join('|');
    if (s !== sig) { sig = s; paint(); }
  };
  paint();
}

/* ---------------- clip editor (modal) ---------------- */
const PART_LABEL = { spike: 'Chat spike', hook: 'Hook', excite: 'Energy', talk: 'Pace', motion: 'Motion', length: 'Length' };
async function openEditor(id) {
  let clip;
  try { clip = (await api(`/api/clip/${encodeURIComponent(id)}`)).clip; }
  catch { return; }

  const close = () => {
    clearInterval(pollT);
    m.classList.add('closing');
    setTimeout(() => m.remove(), 160);
    document.removeEventListener('keydown', esc);
  };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);

  const draft = {
    layout: clip.layout || 'facecam',
    start: clip.start, end: clip.end,
    caption: { on: true, preset: 'pop', position: 0.72, size: 70, wordsPerLine: 3, uppercase: true },
    template: clip.template || 'none',
    title: clip.title || '', hook: clip.hook || '', captionText: clip.caption || '',
  };

  // ---- phone preview
  const phone = h('div.phone');
  let video = null;
  const STAGE_LABEL = { queued: 'Queued…', processing: 'Processing…', transcribing: 'Writing captions…', rendering: 'Rendering…', covers: 'Making covers…' };
  function paintPhone() {
    phone.innerHTML = '';
    if (clip.video) {
      video = h('video', { src: clip.video, controls: true, loop: true, playsInline: true, preload: 'metadata' });
      phone.append(video);
    } else {
      phone.append(h('div.empty', { style: { height: '100%' } }, h('span.spin'), h('div.small', {}, STAGE_LABEL[clip.status] || clip.status)));
    }
    if (isBusy(clip)) {
      const p = Math.round((clip.progress || 0) * 100);
      phone.append(h('div.renderprog', {},
        h('span.spin', { style: { width: '22px', height: '22px' } }),
        h('div', { style: { fontWeight: 600 } }, STAGE_LABEL[clip.status] || clip.status),
        h('div.rp-bar', {}, h('i', { style: { width: p + '%' } })),
        h('div.small', {}, p + '%')));
    } else if (clip.status === 'error') {
      phone.append(h('div.renderprog', {}, h('div', { style: { color: 'var(--red)', fontWeight: 700 } }, 'Failed'), h('div.small', {}, (clip.error || '').slice(0, 100))));
    }
  }

  // ---- score panel
  function scorePanel() {
    if (!clip.virality) return null;
    const v = clip.virality;
    const parts = Object.entries(v.parts || {});
    const label = (k) => PART_LABEL[k] || k.charAt(0).toUpperCase() + k.slice(1);
    return h('div.panel', {},
      h('h3', {}, 'Virality score'),
      h('div.vbreak', {},
        h('div.vbig', {}, h('span.num', {}, String(v.score)), h('span.small.muted', {}, '/ 100')),
        h('div.vbars', {}, (parts.length ? parts : [['spike', 0]]).map(([k, val]) =>
          h('div.vbar', {}, h('span.small.muted', {}, label(k)),
            h('div.track', {}, h('i', { style: { width: `${Math.round(Math.max(0, Math.min(1, val)) * 100)}%` } })))))));
  }

  // ---- text panel
  function textPanel() {
    const title = h('input.input', { value: draft.title, placeholder: 'Title', oninput: (e) => { draft.title = e.target.value; saveText(); } });
    const hook = h('input.input', { value: draft.hook, placeholder: 'On-screen hook line', oninput: (e) => { draft.hook = e.target.value; saveText(); } });
    const cap = h('textarea.input', { placeholder: 'Posting caption', oninput: (e) => { draft.captionText = e.target.value; saveText(); } });
    cap.value = draft.captionText;
    let saveTimer = null;
    const saveText = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { api(`/api/clip/${encodeURIComponent(clip.id)}/text`, { title: draft.title, hook: draft.hook, caption: draft.captionText }, { quiet: true }).catch(() => {}); }, 600); };
    return h('div.panel', {},
      h('h3', {}, 'Text'),
      h('div.field', { style: { marginBottom: '10px' } }, h('label', {}, 'Title'), title),
      h('div.field', { style: { marginBottom: '10px' } }, h('label', {}, 'Hook'), hook),
      h('div.field', {}, h('label', {}, 'Posting caption'), cap),
      clip.transcript ? h('div.hint', { style: { marginTop: '10px', lineHeight: 1.6 } }, clip.transcript) : null);
  }

  // ---- edit-style templates (viral looks, one click)
  function templatesPanel() {
    const tpls = (S.state && S.state.templates) || [];
    const grid = h('div.tplgrid', {});
    const paint = () => {
      grid.innerHTML = '';
      for (const t of tpls) {
        const card = h('button.tplcard' + (draft.template === t.id ? '.active' : ''), { style: { '--tc': t.accent }, type: 'button' },
          h('span.tpldot'),
          h('span.tplname', {}, t.label),
          h('span.tpldesc', {}, t.desc));
        card.addEventListener('click', () => guard(async () => {
          if (draft.template === t.id) return;
          draft.template = t.id;
          paint();
          await api(`/api/clip/${encodeURIComponent(clip.id)}/render`, { template: t.id, layout: t.id === 'speed' ? 'reaction' : undefined });
          toast(`${t.label} edit — re-rendering`);
          pollClip();
        }));
        grid.append(card);
      }
    };
    paint();
    return h('div.panel', {}, h('h3', {}, 'Edit style'), grid);
  }

  // ---- layout + facecam box editor
  let cam = null; // {x,y,w,h} fractions
  const camStatus = h('span.small.muted', {}, '');
  async function loadCam() {
    try {
      const r = await api(`/api/facecam/${encodeURIComponent(clip.id)}`, undefined, { quiet: true });
      cam = (r && r.cam) ? { ...r.cam } : { x: 0.06, y: 0.06, w: 0.28, h: 0.28 };
    } catch { cam = { x: 0.06, y: 0.06, w: 0.28, h: 0.28 }; }
    if (camStage.isConnected) placeCam();
  }
  const camStage = h('div.facecam-stage', { style: { aspectRatio: '16 / 9', marginTop: '10px' } });
  const camBox = h('div.box', {},
    ...['nw', 'ne', 'sw', 'se'].map((c) => h('span.hd.' + c, { 'data-c': c })));
  function placeCam() {
    if (!cam) return;
    if (!camBox.isConnected) camStage.append(camBox);
    Object.assign(camBox.style, {
      left: cam.x * 100 + '%', top: cam.y * 100 + '%',
      width: cam.w * 100 + '%', height: cam.h * 100 + '%',
    });
  }
  camStage.addEventListener('pointerdown', (e) => {
    if (!cam) return;
    const r = camStage.getBoundingClientRect();
    const px = (ev) => ({ x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height });
    const p0 = px(e); const b0 = { ...cam };
    const corner = e.target.dataset && e.target.dataset.c;
    const inside = p0.x >= cam.x && p0.x <= cam.x + cam.w && p0.y >= cam.y && p0.y <= cam.y + cam.h;
    if (!corner && !inside) return; // click outside does nothing
    const clamp = (b) => ({
      x: Math.max(0, Math.min(1 - b.w, b.x)), y: Math.max(0, Math.min(1 - b.h, b.y)),
      w: Math.max(0.1, Math.min(1, b.w)), h: Math.max(0.06, Math.min(1, b.h)),
    });
    camStage.setPointerCapture(e.pointerId);
    camBox.classList.add('dragging');
    const move = (ev) => {
      const p = px(ev);
      if (!corner) { cam = clamp({ ...b0, x: b0.x + p.x - p0.x, y: b0.y + p.y - p0.y }); }
      else {
        const ax = corner.includes('w') ? b0.x + b0.w : b0.x;
        const ay = corner.includes('n') ? b0.y + b0.h : b0.y;
        cam = clamp({
          x: corner.includes('w') ? Math.min(ax, p.x) : ax,
          y: corner.includes('n') ? Math.min(ay, p.y) : ay,
          w: Math.abs(p.x - ax), h: Math.abs(p.y - ay),
        });
        if (corner.includes('w')) { cam.x = ax - cam.w; } if (corner.includes('n')) { cam.y = ay - cam.h; }
        cam = clamp(cam);
      }
      placeCam();
    };
    const up = () => { camStage.removeEventListener('pointermove', move); camStage.removeEventListener('pointerup', up); camBox.classList.remove('dragging'); };
    camStage.addEventListener('pointermove', move);
    camStage.addEventListener('pointerup', up);
  });
  function buildCamStage() {
    camStage.innerHTML = '';
    let frameSrc = clip.video || (clip.covers && clip.covers[0]);
    if (!frameSrc) { camStatus.textContent = 'No frame yet — wait for the clip to finish.'; return; }
    const isVideo = !!clip.video;
    const el = isVideo
      ? h('video', { src: clip.video, muted: true, preload: 'metadata', playsInline: true })
      : h('img', { src: frameSrc, draggable: 'false' });
    camStage.append(el);
    const ready = () => {
      const vw = isVideo ? el.videoWidth : el.naturalWidth;
      const vh = isVideo ? el.videoHeight : el.naturalHeight;
      if (vw && vh) camStage.style.aspectRatio = `${vw} / ${vh}`;
      if (isVideo) { try { el.currentTime = Math.max(0, (clip.spikeAt != null ? clip.spikeAt - clip.start : 0)); } catch { /* ignore */ } }
      placeCam();
    };
    if (isVideo) { el.addEventListener('loadedmetadata', ready, { once: true }); el.addEventListener('seeked', () => placeCam(), { once: true }); }
    else el.addEventListener('load', ready, { once: true });
  }
  function layoutPanel() {
    const laySel = h('select.input', { style: { maxWidth: '220px' }, onchange: (e) => { draft.layout = e.target.value; } },
      LAYOUTS.map(([v, l]) => h('option', { value: v, selected: v === draft.layout }, l)));
    const saveCam = h('button.btn.sm', {}, icon('camera'), 'Save camera');
    saveCam.addEventListener('click', () => guard(async () => {
      if (!cam) return;
      saveCam.disabled = true;
      try {
        await api(`/api/clip/${encodeURIComponent(clip.id)}/render`, { layout: draft.layout, cam });
        toast('Re-rendering with the new camera box');
        pollClip();
      } finally { saveCam.disabled = false; }
    }));
    const autoBtn = h('button.btn.sm.ghost', {}, icon('refresh'), 'Auto-detect');
    autoBtn.addEventListener('click', () => guard(async () => {
      autoBtn.disabled = true; camStatus.textContent = 'Detecting…';
      try {
        const r = await api(`/api/facecam/${encodeURIComponent(clip.id)}`, undefined, { quiet: true });
        if (r && r.cam) { cam = { ...r.cam }; placeCam(); camStatus.textContent = 'Found — drag to fine-tune, then Save camera.'; }
        else camStatus.textContent = 'No camera found — drag the box yourself.';
      } catch { camStatus.textContent = 'Auto-detect failed — drag the box yourself.'; }
      autoBtn.disabled = false;
    }));
    return h('div.panel', {},
      h('h3', {}, 'Layout'),
      laySel,
      h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } }, saveCam, autoBtn, camStatus),
      camStage);
  }

  // ---- captions panel
  function captionsPanel() {
    const c = draft.caption;
    const apply = h('button.btn.sm.primary', {}, icon('check'), 'Apply captions');
    apply.addEventListener('click', () => guard(async () => {
      apply.disabled = true;
      try {
        await api(`/api/clip/${encodeURIComponent(clip.id)}/render`, { layout: draft.layout, caption: c });
        toast('Re-rendering captions');
        pollClip();
      } finally { apply.disabled = false; }
    }));
    const pos = h('input', { type: 'range', min: 0.1, max: 0.95, step: 0.01, value: c.position, oninput: (e) => { c.position = Number(e.target.value); paintRange(e.target); posLbl.textContent = Math.round(c.position * 100) + '%'; } });
    paintRange(pos);
    const posLbl = h('span.small.muted.num', {}, Math.round(c.position * 100) + '%');
    const size = h('input', { type: 'range', min: 40, max: 140, step: 2, value: c.size, oninput: (e) => { c.size = Number(e.target.value); paintRange(e.target); sizeLbl.textContent = c.size; } });
    paintRange(size);
    const sizeLbl = h('span.small.muted.num', {}, String(c.size));
    const wpl = h('input', { type: 'range', min: 1, max: 6, step: 1, value: c.wordsPerLine, oninput: (e) => { c.wordsPerLine = Number(e.target.value); paintRange(e.target); wplLbl.textContent = c.wordsPerLine; } });
    paintRange(wpl);
    const wplLbl = h('span.small.muted.num', {}, String(c.wordsPerLine));
    const upTog = h('button.toggle', { class: c.uppercase ? 'on' : '', onclick: (e) => { c.uppercase = e.currentTarget.classList.toggle('on'); } });
    const onTog = h('button.toggle', { class: c.on ? 'on' : '', onclick: (e) => { c.on = e.currentTarget.classList.toggle('on'); } });
    const preset = h('select.input', { style: { maxWidth: '160px' }, onchange: (e) => { c.preset = e.target.value; } },
      h('option', { value: 'pop' }, 'Pop (word by word)'),
      h('option', { value: 'karaoke' }, 'Karaoke'),
      h('option', { value: 'clean' }, 'Clean'));
    return h('div.panel', {},
      h('div.ph', {}, h('h3.grow', { style: { margin: 0 } }, 'Captions'), onTog),
      preset,
      h('div.field', { style: { marginTop: '10px' } }, h('label', {}, 'Position'), h('div.row', {}, pos, posLbl)),
      h('div.field', {}, h('label', {}, 'Size'), h('div.row', {}, size, sizeLbl)),
      h('div.field', {}, h('label', {}, 'Words per line'), h('div.row', {}, wpl, wplLbl)),
      h('div.setrow', {}, h('div.k', {}, h('b', {}, 'UPPERCASE')), upTog),
      h('div', { style: { marginTop: '12px' } }, apply));
  }

  // ---- covers panel
  let coverStyle = 'bold';
  function coversPanel() {
    const grid = h('div.covers');
    const paint = () => {
      grid.innerHTML = '';
      const list = clip.covers || [];
      if (!list.length) grid.append(h('div.hint', {}, 'No covers yet.'));
      list.forEach((src, i) => grid.append(h('button', { class: i === 0 ? 'active' : '', title: 'Set as main cover', onclick: (e) => {
        grid.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        e.currentTarget.classList.add('active');
        guard(async () => { await api(`/api/clip/${encodeURIComponent(clip.id)}/cover`, { style: coverStyle, variant: i }); toast('Main cover set'); pollClip(); });
      } }, h('img', { src: src, loading: 'lazy', alt: 'cover ' + (i + 1) }))));
    };
    paint();
    const styleSel = h('select.input', { style: { maxWidth: '150px' }, onchange: (e) => { coverStyle = e.target.value; } },
      ['bold', 'yellow', 'glow', 'outline'].map((s) => h('option', { value: s }, s.charAt(0).toUpperCase() + s.slice(1))));
    const shuffle = h('button.btn.sm', {}, icon('refresh'), 'Shuffle style');
    shuffle.addEventListener('click', () => guard(async () => {
      shuffle.disabled = true;
      try { await api(`/api/clip/${encodeURIComponent(clip.id)}/cover`, { style: coverStyle, variant: Math.floor(Math.random() * 1000) }); pollClip(); }
      finally { shuffle.disabled = false; }
    }));
    return h('div.panel', {},
      h('h3', {}, 'Covers'),
      grid,
      h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } }, styleSel, shuffle));
  }

  // ---- trim panel
  function trimPanel() {
    const b = clip.bounds || { min: 0, max: (clip.end || 60) + 30 };
    const start = h('input.input', { type: 'number', step: '0.1', min: b.min, max: b.max, value: draft.start });
    const end = h('input.input', { type: 'number', step: '0.1', min: b.min, max: b.max, value: draft.end });
    const info = h('span.small.muted.num', {}, `${fmtTime(b.min)} – ${fmtTime(b.max)} available`);
    const save = h('button.btn.sm.primary', {}, icon('check'), 'Save trim');
    save.addEventListener('click', () => guard(async () => {
      const s = Math.max(b.min, Math.min(Number(end.value) - 2, Number(start.value)));
      const e2 = Math.min(b.max, Math.max(s + 2, Number(end.value)));
      start.value = s; end.value = e2;
      draft.start = s; draft.end = e2;
      save.disabled = true;
      try { await api(`/api/clip/${encodeURIComponent(clip.id)}/render`, { start: s, end: e2, layout: draft.layout }); toast('Re-rendering with the new trim'); pollClip(); }
      finally { save.disabled = false; }
    }));
    return h('div.panel', {},
      h('h3', {}, 'Trim'),
      h('div.row', { style: { flexWrap: 'wrap' } },
        h('div.field.grow', { style: { minWidth: '110px' } }, h('label', {}, 'Start (s)'), start),
        h('div.field.grow', { style: { minWidth: '110px' } }, h('label', {}, 'End (s)'), end),
        save),
      info);
  }

  // ---- export + delete
  function exportPanel() {
    const links = h('div.row', { style: { flexWrap: 'wrap' } });
    const addLink = (label, href, download) => links.append(h('a.btn.sm', { href, download: download || '', target: '_blank', rel: 'noopener' }, icon('download'), label));
    if (clip.video) addLink('Video', clip.video, 'clip.mp4');
    if (clip.covers && clip.covers[0]) addLink('Cover', clip.covers[0], 'cover.jpg');
    const capBtn = h('button.btn.sm', {}, icon('download'), 'Caption txt');
    capBtn.addEventListener('click', () => {
      const txt = [draft.title || clip.title || '', '', draft.hook || clip.hook || '', '', draft.captionText || clip.caption || ''].join('\n').trim() + '\n';
      const url = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
      const a = h('a', { href: url, download: `clip-${clip.id}-caption.txt` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    links.append(capBtn);
    if (!clip.video) links.append(h('span.small.muted', {}, 'Video link appears when the clip is done.'));
    const del = h('button.btn.sm.danger', {}, icon('trash'), 'Delete clip');
    del.addEventListener('click', () => guard(async () => {
      if (!confirm('Delete this clip?')) return;
      await api(`/api/clip/${encodeURIComponent(clip.id)}/delete`);
      close();
      toast('Clip deleted');
      kick();
    }));
    return h('div.panel', {}, h('h3', {}, 'Export'), links,
      h('div.row', { style: { marginTop: '12px' } }, del,
        h('button.btn.sm.ghost', { onclick: () => guard(async () => { await api(`/api/clip/${encodeURIComponent(clip.id)}/render`, {}); toast('Re-rendering…'); pollClip(); }) }, icon('refresh'), 'Re-render')));
  }

  // ---- header
  const scoreChip = () => clip.virality
    ? h('span.chip', { class: clip.virality.score >= 70 ? 'gold' : '' }, icon('trend'), `Score ${clip.virality.score}`) : null;
  const headTitle = h('div', { style: { fontWeight: 700, fontSize: '16px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
    clip.title || clip.hook || `${clip.channel || 'Clip'} · ${fmtTime(clip.spikeAt || 0)}`);
  const scoreSlot = h('span', { style: { display: 'contents' } });
  const statusSlot = h('span', { style: { display: 'contents' } });
  const paintHeadChips = () => {
    scoreSlot.innerHTML = '';
    if (clip.virality) scoreSlot.append(h('span.chip', { class: clip.virality.score >= 70 ? 'gold' : '' }, icon('trend'), `Score ${clip.virality.score}`));
    statusSlot.innerHTML = '';
    statusSlot.append(h('span.chip', { class: clip.status === 'done' ? 'green' : clip.status === 'error' ? 'red' : 'amber' },
      isBusy(clip) ? h('span.spin', { style: { width: '10px', height: '10px' } }) : h('span.dot'),
      clip.status === 'done' ? 'Ready' : clip.status === 'error' ? 'Failed' : clip.status));
  };
  const head = h('div.row', { style: { flexWrap: 'wrap' } },
    h('div.grow', { style: { minWidth: 0 } }, headTitle,
      h('div.small.muted', {}, `${clip.channel || ''}${clip.createdAt ? ' · ' + ago(clip.createdAt) : ''}`)),
    scoreSlot, statusSlot,
    h('button.btn.sm.ghost', { onclick: close }, icon('x'), 'Close'));

  const pane = h('div.edpane');
  const buildPane = () => {
    pane.innerHTML = '';
    pane.append(scorePanel(), textPanel(), templatesPanel(), layoutPanel(), captionsPanel(), coversPanel(), trimPanel(), exportPanel());
  };
  buildPane();
  const m = h('div.modal', { onclick: (e) => { if (e.target === m) close(); } },
    h('div.panel.modal-card', {}, head, h('div.editor', {}, phone, pane)));
  $('#modalRoot').append(m);
  paintHeadChips();
  paintPhone();
  buildCamStage();
  loadCam();

  // poll this clip while it is busy
  const pollClip = () => guard(async () => {
    const r = await api(`/api/clip/${encodeURIComponent(clip.id)}`, undefined, { quiet: true });
    if (!r || !r.clip) return;
    const prevStatus = clip.status, prevVideo = clip.video, prevCovers = (clip.covers || []).length;
    clip = r.clip;
    paintHeadChips();
    if (clip.status !== prevStatus || clip.video !== prevVideo || !isBusy(clip)) paintPhone();
    else if (isBusy(clip)) { // just refresh the progress overlay
      const bar = phone.querySelector('.renderprog .rp-bar i');
      if (bar) bar.style.width = `${Math.round((clip.progress || 0) * 100)}%`;
    }
    if ((clip.covers || []).length !== prevCovers || clip.video !== prevVideo) {
      buildPane();
      if (!camStage.querySelector('img,video')) buildCamStage();
    }
  });
  const pollT = setInterval(() => { if (isBusy(clip)) pollClip(); }, 2000);
}

/* ================================================================
   FILES view
================================================================ */
function renderFiles(root) {
  const url = h('input.input', { placeholder: 'Paste a VOD or recording URL', spellcheck: 'false' });
  const chat = h('input.input', { placeholder: 'Chat log URL (optional)', spellcheck: 'false' });
  const chan = h('input.input', { placeholder: 'Channel name (optional)' });
  const btn = h('button.btn.primary.big', {}, icon('scissors'), 'Find the moments');
  const progBox = h('div');
  const done = h('div');
  btn.addEventListener('click', () => guard(async () => {
    const v = url.value.trim();
    if (!v) { progBox.innerHTML = ''; progBox.append(h('div.msg.err', {}, 'Paste a video URL first.')); return; }
    btn.disabled = true; btn.innerHTML = ''; btn.append(h('span.spin'), 'Analysing…');
    progBox.innerHTML = '';
    done.innerHTML = '';
    try {
      const body = { url: v };
      if (chat.value.trim()) body.chatLogUrl = chat.value.trim();
      if (chan.value.trim()) body.channel = chan.value.trim();
      await api('/api/file/analyse', body);
      watchFile();
    } catch { btn.disabled = false; btn.innerHTML = ''; btn.append(icon('scissors'), 'Find the moments'); }
  }));
  let fileTimer = null;
  const resetBtn = () => { btn.disabled = false; btn.innerHTML = ''; btn.append(icon('scissors'), 'Find the moments'); };
  function watchFile() {
    clearInterval(fileTimer);
    fileTimer = setInterval(() => guard(async () => {
      let st;
      try { st = await api('/api/file/state', undefined, { quiet: true }); } catch { clearInterval(fileTimer); resetBtn(); return; }
      if (!st) return;
      progBox.innerHTML = '';
      if (st.error) {
        progBox.append(h('div.msg.err', {}, st.error));
        clearInterval(fileTimer);
        resetBtn();
      } else if (st.busy) {
        progBox.append(
          h('div.row', {}, h('div.grow.small.muted', {}, st.stage || 'Analysing…'), h('span.small.num.muted', {}, `${Math.round((st.p || 0) * 100)}%`)),
          h('div.progress', {}, h('i', { style: { width: `${Math.round((st.p || 0) * 100)}%` } })));
      } else {
        clearInterval(fileTimer);
        progBox.innerHTML = '';
        progBox.append(h('div.msg.ok', {}, 'Done — the clips are in the Clips view.'));
        resetBtn();
        kick();
      }
    }), 1500);
  }
  root.append(h('div.panel', {},
    h('div.ph', {}, h('h2.grow', {}, 'Find the moments in a VOD'), h('span.chip.gold', {}, 'Free · Unlimited')),
    h('div.field', { style: { marginBottom: '10px' } }, h('label', {}, 'Video or VOD URL'), url),
    h('div.field', { style: { marginBottom: '10px' } }, h('label', {}, 'Chat log URL (optional)'), chat),
    h('div.field', {}, h('label', {}, 'Channel name (optional)'), chan),
    h('div', { style: { marginTop: '16px' } }, btn),
    h('div', { style: { marginTop: '14px' } }, progBox, done),
    h('div.hint', { style: { marginTop: '8px' } }, 'ClipIt scans the recording the same way it watches a live stream: it looks for the moments where the action (and the chat) spike, and cuts vertical clips from them.')));
  S.onData = () => {};
  return () => clearInterval(fileTimer);
}

/* ================================================================
   SETTINGS view
================================================================ */
function renderSettings(root) {
  const s = (S.state && S.state.settings) || {};
  const d = s.caption || {};
  const sens = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: s.sensitivity != null ? s.sensitivity : 0.5 });
  paintRange(sens);
  const sensLbl = h('span.small.muted.num', { style: { width: '90px', textAlign: 'right' } }, '');
  const lbl = (v) => `${Math.round(v * 100)}% · ${v < 0.35 ? 'Low' : v < 0.7 ? 'Medium' : 'High'}`;
  sensLbl.textContent = lbl(Number(sens.value));
  sens.addEventListener('input', () => { paintRange(sens); sensLbl.textContent = lbl(Number(sens.value)); });
  const cool = h('input.input', { type: 'number', min: 0, max: 600, step: 5, style: { width: '110px' }, value: s.cooldown != null ? s.cooldown : 60 });
  const lay = h('select.input', { style: { width: '200px' } }, LAYOUTS.map(([v, l]) => h('option', { value: v, selected: v === (s.layout || 'facecam') }, l)));
  const capPreset = h('select.input', { style: { width: '180px' } },
    h('option', { value: 'pop', selected: d.preset === 'pop' || !d.preset }, 'Pop'),
    h('option', { value: 'karaoke', selected: d.preset === 'karaoke' }, 'Karaoke'),
    h('option', { value: 'clean', selected: d.preset === 'clean' }, 'Clean'));
  const capPos = h('input', { type: 'range', min: 0.1, max: 0.95, step: 0.01, value: d.position != null ? d.position : 0.72 });
  paintRange(capPos);
  const capPosLbl = h('span.small.muted.num', { style: { width: '40px', textAlign: 'right' } }, Math.round(Number(capPos.value) * 100) + '%');
  capPos.addEventListener('input', () => { paintRange(capPos); capPosLbl.textContent = Math.round(Number(capPos.value) * 100) + '%'; });
  const capSize = h('input', { type: 'range', min: 40, max: 140, step: 2, value: d.size != null ? d.size : 70 });
  paintRange(capSize);
  const capSizeLbl = h('span.small.muted.num', { style: { width: '40px', textAlign: 'right' } }, String(capSize.value));
  capSize.addEventListener('input', () => { paintRange(capSize); capSizeLbl.textContent = capSize.value; });
  const capUp = h('button.toggle', { class: d.uppercase === false ? '' : 'on' });
  capUp.addEventListener('click', () => capUp.classList.toggle('on'));
  const maxPerHour = h('input.input', { type: 'number', min: 1, max: 999, style: { width: '110px' }, value: s.maxClipsPerHour != null ? s.maxClipsPerHour : 30 });
  const saveMsg = h('span.small.muted', {}, '');

  const row = (title, sub, control) => h('div.setrow', {}, h('div.k', {}, h('b', {}, title), sub ? h('span', {}, sub) : null), control);
  const saveBtn = h('button.btn.primary', {}, icon('check'), 'Save settings');
  saveBtn.addEventListener('click', () => guard(async () => {
    saveBtn.disabled = true; saveMsg.textContent = '';
    try {
      S.state = await api('/api/settings', {
        sensitivity: Number(sens.value),
        cooldown: Number(cool.value),
        layout: lay.value,
        maxClipsPerHour: Number(maxPerHour.value),
        caption: { preset: capPreset.value, position: Number(capPos.value), size: Number(capSize.value), uppercase: capUp.classList.contains('on') },
      });
      saveMsg.textContent = 'Saved';
      setTimeout(() => { saveMsg.textContent = ''; }, 2500);
    } finally { saveBtn.disabled = false; }
  }));

  root.append(h('div.panel', {},
    h('div.ph', {}, h('h2.grow', {}, 'Settings'), h('span.chip.gold', {}, 'Free — no licence needed')),
    row('Sensitivity', 'How easily a chat spike triggers a clip', h('div.row', { style: { width: '300px' } }, sens, sensLbl)),
    row('Cooldown', 'Seconds between two clips from the same stream', cool),
    row('Default layout', lay),
    row('Max clips per hour', 'A safety net — clip as much as you like, this just caps the flood', maxPerHour),
    h('h3', { style: { margin: '18px 0 2px' } }, 'Caption defaults'),
    row('Preset', capPreset),
    row('Position', h('div.row', { style: { width: '300px' } }, capPos, capPosLbl)),
    row('Size', h('div.row', { style: { width: '300px' } }, capSize, capSizeLbl)),
    row('UPPERCASE', capUp),
    h('div.row', { style: { marginTop: '16px' } }, saveBtn, saveMsg)));
  S.onData = () => {};
}

/* ---------------- boot ---------------- */
VIEWS.live.render = (root) => {
  const inner = renderLive(root);
  return () => { if (S.apTimer) { clearInterval(S.apTimer); S.apTimer = null; } if (typeof inner === 'function') inner(); };
};
VIEWS.clips.render = renderClips;
VIEWS.files.render = renderFiles;
VIEWS.settings.render = renderSettings;

function buildTabs() {
  const tabs = $('#tabs');
  for (const [id, v] of Object.entries(VIEWS)) {
    const b = h('button', { 'data-v': id, onclick: () => { if (S.view !== id) go(id); } }, v.label);
    tabs.append(b);
  }
  const chip = $('#liveChip');
  chip.addEventListener('click', () => go('live'));
}

try {
  buildTabs();
  const qp = new URLSearchParams(location.search);
  const v0 = qp.get('view');
  go(v0 && VIEWS[v0] ? v0 : 'live');
  pollOnce().catch(() => {}).then(() => {
    const id = qp.get('clip');
    if (id && clips().some((c) => c.id === id)) openEditor(id);
  });
} catch (e) {
  if (window.console && console.error) console.error(e);
}
