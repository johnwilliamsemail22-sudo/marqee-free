// Your public webserver. Runs on port 3001; the platform routes external
// traffic from your public skydive URL to this port. This instance serves the
// ClipIt app (a free, unpaywalled live-stream clipper): the web UI in
// clipper/web plus its JSON API. A shared access key gates every mutating and
// data route; the UI gets it baked in when it is served.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { LiveSession, type ClipRecord } from './clipper/live.ts';
import { Pipeline } from './clipper/pipeline.ts';
import { parse as parseChannel } from './clipper/platforms.ts';
import { FileMode } from './clipper/filemode.ts';
import { TEMPLATES } from './clipper/templates.ts';

const PORT = Number(process.env.WEBSERVER_PORT ?? 3001);

// ---------------------------------------------------------------- app state
const WORK = '/home/user/clipper';
fs.mkdirSync(WORK, { recursive: true });
const KEY_FILE = path.join(WORK, 'access-key');
const ACCESS_KEY = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : crypto.randomBytes(9).toString('base64url');
fs.writeFileSync(KEY_FILE, ACCESS_KEY);

const SETTINGS_FILE = path.join(WORK, 'settings.json');
const WATCHLIST_FILE = path.join(WORK, 'watchlist.json');

type Settings = {
  sensitivity: number; cooldown: number; layout: string; maxClipsPerHour: number;
  caption: { preset?: string; position?: number; size?: number; uppercase?: boolean };
};
const readJson = <T>(file: string, fallback: T): T => {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return fallback; }
};
const settings: Settings = readJson<Settings>(SETTINGS_FILE, {
  sensitivity: 0.55, cooldown: 60, layout: 'facecam', maxClipsPerHour: 30, caption: {},
});
const saveSettings = () => { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch { /* best effort */ } };

type WatchEntry = { channel: string; platform: string; label: string; sessionId?: string; clips?: number };
let watchlist: WatchEntry[] = [];
try { watchlist = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); } catch { /* empty */ }
const saveWatchlist = () => { try { fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlist, null, 2)); } catch { /* best effort */ } };

const sessions = new Map<string, LiveSession>();
const clips = new Map<string, ClipRecord>();
const camBoxes = new Map<string, { x: number; y: number; w: number; h: number } | null>();
const fileMeta = new Map<string, { file: string; duration: number }>(); // filemode sessions

const pipeline = new Pipeline({
  getClip: (id) => clips.get(id),
  setClip: (id, patch) => { const c = clips.get(id); if (c) Object.assign(c, patch); },
  getSegments: (clip) => {
    const s = clip.sessionId ? sessions.get(clip.sessionId) : undefined;
    if (s) return s.segments.filter((x: any) => !x.deleted && x.file && x.wEnd >= (clip.recWindow?.w0 ?? clip.start) - 4 && x.wStart <= (clip.recWindow?.w1 ?? clip.end) + 4).sort((a: any, b: any) => a.start - b.start);
    const fm = clip.sessionId ? fileMeta.get(clip.sessionId) : undefined;
    if (fm) return [{ file: fm.file, wStart: 0, wEnd: fm.duration }];
    return [];
  },
  getCam: (channel) => camBoxes.get(channel) ?? null,
});

const fileMode = new FileMode({
  onClip: (clip) => { clips.set(clip.id, clip); pipeline.enqueue(clip.id); },
  updateClip: (id, patch) => { const c = clips.get(id); if (c) Object.assign(c, patch); },
  enqueue: (id) => pipeline.enqueue(id),
});

function onNewClip(clip: ClipRecord) {
  clips.set(clip.id, clip);
  pipeline.enqueue(clip.id);
  const w = watchlist.find((x) => x.channel === clip.channel);
  if (w) w.clips = (w.clips || 0) + 1;
}

async function startSession(body: { channel: string; platform?: string; layout?: string; sensitivity?: number; cooldown?: number }) {
  const src = parseChannel(body.platform, body.channel);
  if (!src) throw new Error('That does not look like a channel link.');
  if (sessions.size >= 4) throw new Error('Already watching 4 streams. Stop one first.');
  const existing = [...sessions.values()].find((s) => s.src.channel === src.channel);
  if (existing) return existing;
  const live = new LiveSession(src, {
    onClip: onNewClip,
    sensitivity: body.sensitivity ?? settings.sensitivity,
    cooldown: body.cooldown ?? settings.cooldown,
    layout: body.layout || settings.layout,
    cam: camBoxes.get(src.channel) ?? undefined,
  });
  sessions.set(live.id, live);
  try { await live.start(); } catch (e: any) { sessions.delete(live.id); live.stop(); throw e; }
  const w = watchlist.find((x) => x.channel === src.channel);
  if (w) { w.sessionId = live.id; saveWatchlist(); }
  return live;
}

// auto-pilot: watch the watchlist channels, start recording when they go live,
// drop the session when the stream ends
setInterval(async () => {
  for (const w of watchlist) {
    const s = w.sessionId ? sessions.get(w.sessionId) : undefined;
    if (s && (s.recStatus === 'stopped')) { sessions.delete(s.id); w.sessionId = undefined; saveWatchlist(); continue; }
    if (s || sessions.size >= 4) continue;
    try {
      const src = parseChannel(w.platform, w.channel);
      if (!src) continue;
      const { isLive } = await import('./clipper/platforms.ts');
      if (await isLive(src)) await startSession({ channel: w.channel, platform: w.platform });
    } catch { /* try again next sweep */ }
  }
}, 60_000);

function stateJson() {
  const live = [...sessions.values()].map((s) => s.state());
  return {
    recording: live.length > 0,
    streams: live,
    clips: [...clips.values()].map((c) => ({ ...c, words: undefined })),
    templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, desc: t.desc, accent: t.accent })),
    settings,
    watchlist: watchlist.map((w) => ({
      channel: w.channel, platform: w.platform, label: w.label,
      recording: !!(w.sessionId && sessions.get(w.sessionId)),
      clips: w.clips || 0,
    })),
    file: fileMode.state(),
  };
}

// ---------------------------------------------------------------- helpers
function checkKey(req: http.IncomingMessage): boolean {
  const url = new URL(req.url || '/', 'http://x');
  return (req.headers['x-key'] === ACCESS_KEY) || url.searchParams.get('key') === ACCESS_KEY;
}
function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  let body = ''; for await (const c of req) body += c;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.mp4': 'video/mp4', '.json': 'application/json', '.txt': 'text/plain',
};
function serveFile(res: http.ServerResponse, file: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- routes
type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string; // may contain :param segments
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => void | Promise<void>;
  label?: string;
  listed?: boolean;
};

const routes: Route[] = [
  { method: 'GET', path: '/health', listed: false, handler: (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); } },

  // static web app
  { method: 'GET', path: '/', listed: false, handler: (_q, res) => serveFile(res, path.join(import.meta.dirname ?? '.', 'clipper/web/index.html')) },
  { method: 'GET', path: '/app/', listed: false, handler: (_q, res, p) => serveFile(res, path.join(import.meta.dirname ?? '.', 'clipper/web', p.rest)) },

  { method: 'GET', path: '/api/state', handler: (_q, res) => json(res, 200, stateJson()) },

  {
    method: 'POST', path: '/api/start',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      try { await startSession(await readBody(req)); json(res, 200, stateJson()); }
      catch (e: any) { json(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'POST', path: '/api/stop',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const { sessionId } = await readBody(req);
      const s = sessions.get(sessionId);
      if (s) { s.stop(); sessions.delete(sessionId); }
      const w = watchlist.find((x) => x.sessionId === sessionId);
      if (w) { w.sessionId = undefined; saveWatchlist(); }
      json(res, 200, stateJson());
    },
  },
  {
    method: 'POST', path: '/api/clip-now',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const { sessionId } = await readBody(req);
      const s = sessions.get(sessionId);
      if (!s) return json(res, 404, { error: 'no such session' });
      try { json(res, 200, s.clipNow()); } catch (e: any) { json(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'POST', path: '/api/settings',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const body = await readBody(req);
      if (Number.isFinite(body.sensitivity)) settings.sensitivity = Math.max(0, Math.min(1, Number(body.sensitivity)));
      if (Number.isFinite(body.cooldown) && body.cooldown > 0) settings.cooldown = Number(body.cooldown);
      if (body.layout) settings.layout = String(body.layout);
      if (Number.isFinite(body.maxClipsPerHour)) settings.maxClipsPerHour = Number(body.maxClipsPerHour);
      if (body.caption && typeof body.caption === 'object') settings.caption = { ...settings.caption, ...body.caption };
      saveSettings();
      for (const s of sessions.values()) s.updateSensitivity(settings.sensitivity, settings.cooldown);
      json(res, 200, stateJson());
    },
  },

  // watchlist (auto-pilot)
  {
    method: 'GET', path: '/api/watchlist',
    handler: (_q, res) => json(res, 200, { watchlist }),
  },
  {
    method: 'POST', path: '/api/watchlist',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const body = await readBody(req);
      const src = parseChannel(body.platform, body.channel);
      if (!src) return json(res, 400, { error: 'That does not look like a channel link.' });
      if (!watchlist.find((w) => w.channel === src.channel)) {
        watchlist.push({ channel: src.channel, platform: src.platform, label: src.label });
        saveWatchlist();
      }
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'DELETE', path: '/api/watchlist/:channel',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const channel = decodeURIComponent(p.channel);
      const w = watchlist.find((x) => x.channel === channel);
      if (w?.sessionId) { const s = sessions.get(w.sessionId); if (s) { s.stop(); sessions.delete(w.sessionId); } }
      watchlist = watchlist.filter((x) => x.channel !== channel);
      saveWatchlist();
      json(res, 200, { ok: true });
    },
  },

  // clips
  {
    method: 'GET', path: '/api/clip/:id',
    handler: (_q, res, p) => {
      if (!checkKey(_q)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 404, { error: 'no such clip' });
      json(res, 200, { clip: c });
    },
  },
  {
    method: 'POST', path: '/api/clip/:id/text',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 404, { error: 'no such clip' });
      const { title, hook, caption } = await readBody(req);
      const patch: any = {};
      if (typeof title === 'string') patch.title = title;
      if (typeof hook === 'string') patch.hook = hook;
      if (typeof caption === 'string') patch.caption = caption;
      Object.assign(c, patch);
      pipeline.exportBundle(c);
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'POST', path: '/api/clip/:id/render',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 404, { error: 'no such clip' });
      const body = await readBody(req);
      if (body.template !== undefined) c.template = body.template;
      if (body.layout) c.layout = body.layout;
      if (body.caption) c.captionStyle = body.caption;
      if (body.cam) { c.cam = body.cam; camBoxes.set(c.channel, body.cam); }
      if (Number.isFinite(body.start)) c.start = Number(body.start);
      if (Number.isFinite(body.end)) c.end = Number(body.end);
      c.status = 'queued'; c.progress = 0.4;
      pipeline.rerenderSoon(c.id);
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'POST', path: '/api/clip/:id/cover',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 404, { error: 'no such clip' });
      const { style, variant } = await readBody(req);
      try {
        const cover = await pipeline.newCover(c, style || 'bold', Number(variant) || 0);
        c.covers = [...(c.covers || []), cover];
        json(res, 200, { ok: true, cover });
      } catch (e: any) { json(res, 400, { error: e.message }); }
    },
  },
  {
    method: 'POST', path: '/api/clip/:id/delete',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 200, { ok: true });
      clips.delete(p.id);
      const s = c.sessionId ? sessions.get(c.sessionId) : undefined;
      if (s) s.clips = s.clips.filter((x) => x.id !== p.id);
      try { fs.rmSync(path.join('/home/user/clipper/clips', p.id), { recursive: true, force: true }); } catch { /* gone */ }
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'GET', path: '/api/facecam/:id',
    handler: async (req, res, p) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const c = clips.get(p.id);
      if (!c) return json(res, 404, { error: 'no such clip' });
      const dir = path.join('/home/user/clipper/clips', p.id);
      // prefer the archived original-aspect copy; fall back to the rendered clip
      const candidates = [
        path.join('/home/user/Documents/ClipIt/clips', p.id, 'raw_cut.mp4'),
        path.join(dir, 'raw.mp4'),
        path.join(dir, 'clip_vertical.mp4'),
      ];
      const video = candidates.find((f) => fs.existsSync(f));
      if (!video) return json(res, 404, { error: 'no video for this clip yet' });
      const proc = spawn('python3', [path.join(import.meta.dirname ?? '.', 'clipper/facecam.py'), video, '2', '8', '14']);
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-500); });
      proc.on('close', () => {
        try { json(res, 200, JSON.parse(out.split('\n').filter(Boolean).pop() || '{}')); }
        catch { json(res, 500, { error: 'face detection failed', detail: stderr.split('\n').pop() }); }
      });
      proc.on('error', () => json(res, 500, { error: 'face detection failed to start' }));
    },
  },

  // file mode (VOD / recording URL)
  {
    method: 'POST', path: '/api/file/analyse',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const body = await readBody(req);
      fileMode.analyse(body).then((r: any) => { if (r?.sessionId) fileMeta.set(r.sessionId, { file: path.join(WORK, 'file', r.sessionId, 'input.mp4'), duration: r.duration || 0 }); }).catch(() => { /* state carries the error */ });
      json(res, 200, { ok: true });
    },
  },
  { method: 'GET', path: '/api/file/state', handler: (_q, res) => json(res, 200, fileMode.state()) },

  // media files (clips + covers)
  { method: 'GET', path: '/media/', listed: false, handler: (req, res, p) => {
    if (!checkKey(req)) return json(res, 401, { error: 'no key' });
    const rel = decodeURIComponent(p.rest).replace(/\.\./g, '');
    serveFile(res, path.join(WORK, rel));
  } },
];

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const pathname = (req.url || '/').split('?')[0];
    let matched: { route: Route; params: Record<string, string> } | null = null;
    const pSegs = pathname.split('/').filter(Boolean);
    // exact segment matches first, prefix routes (/app/, /media/) only as fallback
    for (const r of routes) {
      if (r.method !== method || r.path.endsWith('/')) continue;
      const rSegs = r.path.split('/').filter(Boolean);
      if (rSegs.length !== pSegs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < rSegs.length; i++) {
        if (rSegs[i].startsWith(':')) params[rSegs[i].slice(1)] = pSegs[i];
        else if (rSegs[i] !== pSegs[i]) { ok = false; break; }
      }
      if (ok) { matched = { route: r, params }; break; }
    }
    if (!matched) {
      for (const r of routes) {
        if (r.method !== method || !r.path.endsWith('/')) continue;
        if (pathname.startsWith(r.path)) { matched = { route: r, params: { rest: pathname.slice(r.path.length) } }; break; }
      }
    }
    if (matched) { await matched.route.handler(req, res, matched.params); return; }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (error) {
    console.error('[webserver] request failed', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, () => {
  console.log(`[webserver] listening on :${PORT}`);
});
