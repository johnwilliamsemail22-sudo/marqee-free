// Your public webserver. Runs on port 3001; the platform routes external
// traffic from your public skydive URL to this port. This instance serves the
// ClipIt app (a free, unpaywalled live-stream clipper) plus a liveness probe.
import http from 'node:http';
import { DEFAULT_PAGE_HEADER, renderLandingPage } from './landing.ts';
import { LiveSession, type ClipRecord } from './clipper/live.ts';
import { Pipeline, MEDIA as CLIP_MEDIA } from './clipper/pipeline.ts';
import { parse as parseChannel } from './clipper/platforms.ts';
import { renderApp } from './clipper/ui.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// oxlint-disable-next-line eslint-plugin-node/no-process-env -- startup config; no env loader in this workspace
const PORT = Number(process.env.WEBSERVER_PORT ?? 3001);

// ---------------------------------------------------------------- ClipIt app state
const WORK = '/home/user/clipper';
fs.mkdirSync(WORK, { recursive: true });
const KEY_FILE = path.join(WORK, 'access-key');
const ACCESS_KEY = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : crypto.randomBytes(9).toString('base64url');
fs.writeFileSync(KEY_FILE, ACCESS_KEY);

const sessions = new Map<string, LiveSession>();
const clips = new Map<string, ClipRecord>();
const camBoxes = new Map<string, { x: number; y: number; w: number; h: number } | null>();

const pipeline = new Pipeline({
  getClip: (id) => clips.get(id),
  setClip: (id, patch) => { const c = clips.get(id); if (c) Object.assign(c, patch); },
  getCam: (channel) => camBoxes.get(channel) ?? null,
});
// the pipeline finds buffer segments through the live sessions
(pipeline as any)._segments = (clip: ClipRecord) => {
  const s = clip.sessionId ? sessions.get(clip.sessionId) : undefined;
  if (!s) return [];
  return s.segments.filter((x) => !x.deleted && x.file && x.wEnd >= clip.start && x.wStart <= clip.end).sort((a, b) => a.start - b.start);
};

function checkKey(req: http.IncomingMessage): boolean {
  const url = new URL(req.url || '/', 'http://x');
  return (req.headers['x-key'] === ACCESS_KEY) || url.searchParams.get('key') === ACCESS_KEY;
}
function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void | Promise<void>;
  /** Shown next to the path on the default page. */
  label?: string;
  /** GET routes appear on the default page unless this is false. */
  listed?: boolean;
};

const routes: Route[] = [
  // Liveness probe. Keep this so supervisor's :3001 listener is verifiable
  // (`curl -s localhost:3001/health`) even before you add real routes.
  {
    method: 'GET',
    path: '/health',
    listed: false,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    },
  },
];

routes.push(
  // ---- ClipIt: free live clipper ----
  {
    method: 'GET',
    path: '/',
    listed: false,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderApp(ACCESS_KEY));
    },
  },
  {
    method: 'POST',
    path: '/api/monitor/start',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      let body = ''; for await (const c of req) body += c;
      const { input, layout } = JSON.parse(body || '{}');
      const src = parseChannel(undefined, input);
      if (!src) return json(res, 400, { error: 'That does not look like a channel link.' });
      if (sessions.size >= 4) return json(res, 400, { error: 'Already watching 4 streams. Stop one first.' });
      const live = new LiveSession(src, {
        onClip: (clip) => { clips.set(clip.id, clip); pipeline.enqueue(clip.id); },
        layout,
      });
      sessions.set(live.id, live);
      try { await live.start(); } catch (e: any) { sessions.delete(live.id); live.stop(); return json(res, 400, { error: e.message }); }
      json(res, 200, { ok: true, id: live.id });
    },
  },
  {
    method: 'POST',
    path: '/api/monitor/stop',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      let body = ''; for await (const c of req) body += c;
      const { id } = JSON.parse(body || '{}');
      const s = sessions.get(id);
      if (s) { s.stop(); sessions.delete(id); }
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/state',
    handler: (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      json(res, 200, {
        sessions: [...sessions.values()].map((s) => s.state()),
        clips: [...clips.values()].map((c) => ({ ...c, words: undefined, sessionId: undefined })),
      });
    },
  },
  {
    method: 'POST',
    path: '/api/cam',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      let body = ''; for await (const c of req) body += c;
      const { sessionId, box } = JSON.parse(body || '{}');
      const s = sessions.get(sessionId);
      if (!s) return json(res, 404, { error: 'no such session' });
      camBoxes.set(s.src.channel, box);
      json(res, 200, { ok: true });
    },
  },
  {
    method: 'GET',
    path: '/api/frame',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const url = new URL(req.url || '/', 'http://x');
      const s = sessions.get(url.searchParams.get('id') || '');
      if (!s) return json(res, 404, { error: 'no such session' });
      const segs = s.segments.filter((x) => !x.deleted).sort((a, b) => a.start - b.start);
      const last = segs[Math.max(0, segs.length - 3)] || segs[segs.length - 1];
      if (!last) return json(res, 404, { error: 'buffer empty' });
      const out = path.join(WORK, 'frame.png');
      await new Promise<void>((resolve) => {
        const p = spawn('ffmpeg', ['-hide_banner', '-y', '-i', last.file, '-frames:v', '1', out]);
        p.on('close', () => resolve());
        p.on('error', () => resolve());
      });
      if (!fs.existsSync(out)) return json(res, 500, { error: 'frame grab failed' });
      res.writeHead(200, { 'content-type': 'image/png' });
      fs.createReadStream(out).pipe(res);
    },
  },
  {
    method: 'POST',
    path: '/api/debug/cut',
    handler: async (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      let body = ''; for await (const c of req) body += c;
      const { id } = JSON.parse(body || '{}');
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'no such session' });
      const now = Date.now() / 1000;
      const segs = s.segments.filter((x) => !x.deleted);
      if (!segs.length) return json(res, 400, { error: 'buffer empty' });
      const endWall = Math.max(...segs.map((x) => x.wEnd));
      const w0 = now - 16, w1 = endWall - 2;
      const cid = `c${s.id}_${Date.now().toString(36)}`;
      const clip: ClipRecord = {
        id: cid, createdAt: new Date().toISOString(), status: 'queued',
        channel: s.src.channel, platform: s.src.platform, label: s.src.label, sessionId: s.id,
        start: w0, end: w1, spikeAt: now - 5, reason: { kind: 'chat', score: 9, mps: 30, hype: 0.4 },
        layout: s.layout, chatSample: [...s.chatLines],
      };
      clips.set(cid, clip);
      pipeline.enqueue(cid);
      json(res, 200, { ok: true, clip: cid });
    },
  },
  {
    method: 'GET',
    path: '/media/',
    listed: false,
    handler: (req, res) => {
      if (!checkKey(req)) return json(res, 401, { error: 'no key' });
      const rel = decodeURIComponent((req.url || '').replace(/^\/media\//, '')).replace(/\.\./g, '');
      const file = path.join(CLIP_MEDIA, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file);
      const mime = ext === '.mp4' ? 'video/mp4' : ext === '.png' ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime });
      fs.createReadStream(file).pipe(res);
    },
  },
);

const server = http.createServer(async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const path = (req.url || '/').split('?')[0];
    const route = routes.find((r) => r.method === method && (r.path === path || (r.path.endsWith('/') && path.startsWith(r.path))));
    if (route) {
      await route.handler(req, res);
      return;
    }

    if (method === 'GET') {
      const links = routes
        .filter((r) => r.method === 'GET' && r.path !== '/' && r.listed !== false)
        .map((r) => ({ path: r.path, label: r.label }));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        [DEFAULT_PAGE_HEADER]: '1',
      });
      res.end(await renderLandingPage(links));
      return;
    }

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
