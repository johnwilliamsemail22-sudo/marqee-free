// The ClipIt web app UI. Dark, single page: paste a channel, watch chat, get clips.
export function renderApp(key: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClipIt - free live clipper</title>
<style>
  :root { --bg:#0b0d10; --panel:#14171c; --line:#232830; --txt:#e8eaed; --dim:#8b93a1; --acc:#FFD84D; --good:#39d98a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:15px/1.5 system-ui, sans-serif; }
  a { color:var(--acc); }
  header { padding:18px 22px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:19px; margin:0; letter-spacing:.5px; }
  header .free { background:var(--good); color:#06281a; font-weight:700; font-size:11px; padding:2px 8px; border-radius:99px; }
  main { max-width:1080px; margin:0 auto; padding:20px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:16px; }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  input[type=text] { flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); color:var(--txt); padding:10px 12px; border-radius:10px; font-size:15px; }
  select, button { background:#1d232c; color:var(--txt); border:1px solid var(--line); padding:10px 14px; border-radius:10px; cursor:pointer; font-size:14px; }
  button.primary { background:var(--acc); color:#201a02; font-weight:700; border:none; }
  button.danger { background:#3a1d1d; color:#ff9a9a; border:1px solid #5a2a2a; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:14px; }
  .clip video, .clip img { width:100%; border-radius:10px; background:#000; }
  .clip .meta { display:flex; justify-content:space-between; align-items:center; margin:8px 0 4px; }
  .score { font-weight:800; color:#0b0d10; background:var(--acc); border-radius:99px; padding:2px 10px; font-size:13px; }
  .score.mid { background:#c9cdd4; } .score.low { background:#56606e; color:#dfe3e8; }
  .small { color:var(--dim); font-size:12px; }
  .stat { display:inline-block; margin-right:14px; }
  .stat b { font-size:15px; }
  canvas.chart { width:100%; height:64px; display:block; margin-top:8px; }
  .status { font-size:12px; padding:2px 8px; border-radius:99px; background:#1d232c; }
  .status.ok { color:var(--good); } .status.warn { color:#ffb14d; } .status.bad { color:#ff8a8a; }
  .btnrow { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
  .titleline { font-weight:700; margin-top:6px; }
  .hook { color:var(--dim); font-size:13px; }
  dialog { background:var(--panel); color:var(--txt); border:1px solid var(--line); border-radius:14px; max-width:560px; width:92%; }
  dialog::backdrop { background:rgba(0,0,0,.6); }
  #camframe { max-width:100%; border-radius:10px; cursor:crosshair; }
  .empty { color:var(--dim); text-align:center; padding:28px; }
</style>
</head>
<body>
<header><h1>ClipIt</h1><span class="free">FREE</span><span class="small">auto-clips live streams when chat goes wild</span></header>
<main>
  <div class="card">
    <div class="row">
      <input id="ch" type="text" placeholder="twitch.tv/lacy · youtube.com/@channel · kick.com/name · youtube watch link">
      <select id="layout"><option value="facecam">Facecam top + gameplay</option><option value="split">50/50 split</option><option value="center">Center crop</option><option value="blur">Blurred fit</option></select>
      <button class="primary" onclick="start()">Start watching</button>
    </div>
    <div class="small" style="margin-top:8px">Learns the channel's chat speed, then cuts a vertical clip (with facecam, captions and a cover) the moment chat erupts. Only clip streamers who allow it.</div>
  </div>
  <div id="sessions"></div>
  <h3 style="margin:18px 0 10px">Clips</h3>
  <div id="clips" class="grid"></div>
  <div id="emptyclips" class="empty">No clips yet. Start a channel and wait for chat to explode.</div>
</main>
<dialog id="camdlg"><div style="padding:14px">
  <b>Set the facecam box</b>
  <div class="small" style="margin:4px 0 8px">Click two corners of the streamer's face cam on this frame from the live buffer.</div>
  <img id="camframe" onclick="pickCorner(event)">
  <div class="btnrow"><button onclick="saveCam()">Save box</button><button onclick="dlg.close()">Cancel</button><span id="pickstate" class="small"></span></div>
</div></dialog>
<script>
const KEY = ${JSON.stringify(key)};
const $ = (id) => document.getElementById(id);
const state = { sessions: [], clips: [] };
const H = { 'content-type': 'application/json', 'x-key': KEY };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) { const e = await r.json().catch(() => ({ error: r.statusText })); throw new Error(e.error || r.status); }
  return r.json();
}

async function start() {
  try {
    await api('/api/monitor/start', { method: 'POST', body: JSON.stringify({ input: $('ch').value, layout: $('layout').value }) });
    $('ch').value = ''; refresh();
  } catch (e) { alert(e.message); }
}
async function stop(id) { await api('/api/monitor/stop', { method: 'POST', body: JSON.stringify({ id }) }); refresh(); }

let pick = { pts: [], sessionId: null };
function openCam(sessionId) {
  pick = { pts: [], sessionId };
  $('camframe').src = '/api/frame?id=' + sessionId + '&t=' + Date.now();
  $('pickstate').textContent = '';
  $('camdlg').showModal();
}
function pickCorner(ev) {
  const img = $('camframe');
  const r = img.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  pick.pts.push({ x, y });
  $('pickstate').textContent = pick.pts.length === 1 ? 'now click the opposite corner' : '';
  if (pick.pts.length === 2) {
    const [a, b] = pick.pts;
    pick.box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    $('pickstate').textContent = 'box set - save it';
  }
}
async function saveCam() {
  if (!pick.box) return;
  await api('/api/cam', { method: 'POST', body: JSON.stringify({ sessionId: pick.sessionId, box: pick.box }) });
  $('camdlg').close();
}

function drawChart(cv, history) {
  const ctx = cv.getContext('2d');
  const W = cv.width = cv.clientWidth * 2, Hh = cv.height = 128;
  ctx.clearRect(0, 0, W, Hh);
  if (!history.length) return;
  const maxMps = Math.max(2, ...history.map((h) => h.mps));
  const maxS = Math.max(4, ...history.map((h) => h.score));
  const n = history.length;
  ctx.globalAlpha = .35; ctx.strokeStyle = '#39d98a'; ctx.lineWidth = 2; ctx.beginPath();
  history.forEach((h, i) => { const x = i / (n - 1) * W, y = Hh - 8 - (h.mps / maxMps) * (Hh - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  ctx.globalAlpha = 1; ctx.strokeStyle = '#FFD84D'; ctx.beginPath();
  history.forEach((h, i) => { const x = i / (n - 1) * W, y = Hh - 8 - (h.score / maxS) * (Hh - 16); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  cv.title = 'yellow: spike score · green: msgs/sec';
}

function sessionCard(s) {
  const st = s.error ? 'bad' : (s.rec === 'recording' && s.chat === 'connected' ? 'ok' : 'warn');
  const label = { recording: 'recording', connected: 'chat connected', reconnecting: 'reconnecting', starting: 'starting', connecting: 'connecting', stopped: 'stopped' };
  return \`<div class="card" data-s="\${s.id}">
    <div class="row" style="justify-content:space-between">
      <div><b>\${s.label}</b> <span class="status \${st}">\${label[s.rec] || s.rec} · \${label[s.chat] || s.chat}</span></div>
      <button class="danger" onclick="stop('\${s.id}')">Stop</button>
    </div>
    <div style="margin-top:8px">
      <span class="stat"><b>\${s.messages}</b> <span class="small">msgs</span></span>
      <span class="stat"><b>\${s.clips.length}</b> <span class="small">clips</span></span>
      <span class="stat"><b>\${s.bufferSec}s</b> <span class="small">buffer</span></span>
      <span class="stat"><b>\${s.diskMB}MB</b> <span class="small">disk</span></span>
      <button onclick="openCam('\${s.id}')" style="padding:4px 10px;font-size:12px">Set facecam box</button>
    </div>
    <canvas class="chart"></canvas>
    <div class="small">yellow = spike score (cuts when it crosses the line, sustained) · green = msgs/sec</div>
    \${s.error ? \`<div class="small" style="color:#ff8a8a">\${s.error}</div>\` : ''}
  </div>\`;
}

function scoreClass(v) { return v >= 70 ? '' : v >= 45 ? 'mid' : 'low'; }

function clipCard(c) {
  return \`<div class="card clip" data-c="\${c.id}">
    \${c.status === 'done' && c.video ? \`<video src="\${c.video}" controls preload="metadata"></video>\` : \`<div class="empty">\${c.status === 'error' ? 'error: ' + (c.error || '') : c.status + ' ' + Math.round((c.progress || 0) * 100) + '%'}</div>\`}
    <div class="meta"><div class="small">\${c.label || c.channel}</div>\${c.virality ? \`<span class="score \${scoreClass(c.virality.score)}">\${c.virality.score}</span>\` : ''}</div>
    \${c.title ? \`<div class="titleline">\${c.title}</div>\` : ''}
    \${c.hook ? \`<div class="hook">\${c.hook}</div>\` : ''}
    \${c.reason ? \`<div class="small">chat \${c.reason.mps}/s · spike \${c.reason.score} · hype \${Math.round((c.reason.hype || 0) * 100)}%</div>\` : ''}
    <div class="btnrow">
      \${c.video ? \`<a href="\${c.video}" download="clip.mp4"><button>Video</button></a>\` : ''}
      \${(c.covers || []).map((u, i) => \`<a href="\${u}" download="cover\${i}.png"><button>Cover \${i + 1}</button></a>\`).join('')}
      \${c.covers && c.covers.length ? \`<img src="\${c.covers[0]}" style="width:72px;border-radius:6px">\` : ''}
    </div>
  </div>\`;
}

function render() {
  $('sessions').innerHTML = state.sessions.map(sessionCard).join('');
  document.querySelectorAll('.card[data-s] canvas.chart').forEach((cv) => {
    const s = state.sessions.find((x) => x.id === cv.closest('[data-s]').dataset.s);
    if (s) drawChart(cv, s.history.slice(-120));
  });
  $('clips').innerHTML = state.clips.slice().reverse().map(clipCard).join('');
  $('emptyclips').style.display = state.clips.length ? 'none' : 'block';
}

async function refresh() {
  try {
    const j = await api('/api/state');
    state.sessions = j.sessions; state.clips = j.clips;
    render();
  } catch (e) { console.error(e); }
}
refresh();
setInterval(refresh, 2500);
</script>
</body></html>`;
}
