// Live session: record the stream into a rolling ~4 minute buffer of 2 s segments,
// read chat, and cut a clip when chat spikes. Runs the same recipe as the
// reference app, but as a plain Node child of the webserver.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SpikeDetector } from './detect.ts';
import { openChat, resolveStream, type Parsed } from './platforms.ts';

const KEEP_SEC = 240;
const PAD = 30;
const WORK = '/home/user/clipper';

export type Segment = { file: string; run: number; start: number; end: number; wStart: number; wEnd: number; size: number; seq: number; deleted?: boolean };
export type ClipRecord = {
  id: string; createdAt: string; status: 'queued' | 'processing' | 'done' | 'error';
  channel: string; platform: string; label: string; sessionId?: string;
  start: number; end: number; spikeAt: number; reason: { kind: string; score: number; mps: number; hype: number };
  layout?: string; virality?: { score: number; parts: Record<string, number> };
  video?: string; cover?: string; title?: string; hook?: string; caption?: string;
  transcript?: string; chatSample?: string[]; error?: string; progress?: number;
};

export type SessionState = ReturnType<LiveSession['state']>;

export class LiveSession {
  id = String(Date.now().toString(36));
  src: Parsed;
  dir: string;
  segments: Segment[] = [];
  messages = 0;
  clips: ClipRecord[] = [];
  history: Array<{ t: number; score: number; mps: number }> = [];
  chatStatus = 'connecting';
  recStatus = 'starting';
  error: string | null = null;
  det: SpikeDetector;
  chatLines: string[] = [];
  camBoxes: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
  sensitivity = 0.3;
  cooldown = 60;
  layout = 'facecam';

  private rec: any = null;
  private chat: any = null;
  private ticker: any = null;
  private poller: any = null;
  private listRead = 0;
  private runOffsets: number[] = [];
  private run = 0;
  private restarts = 0;
  private stopping = false;
  private pendingCuts: Array<{ w0: number; w1: number }> = [];
  private listFile: string | null = null;
  private seq = 0;
  private onClip: (clip: ClipRecord) => void;
  private updateClip: (id: string, patch: Partial<ClipRecord>) => void;

  constructor(src: Parsed, opts: { onClip: (c: ClipRecord) => void; updateClip: (id: string, patch: Partial<ClipRecord>) => void; sensitivity?: number; cooldown?: number; layout?: string }) {
    this.src = src;
    this.onClip = opts.onClip;
    this.updateClip = opts.updateClip;
    this.det = new SpikeDetector({ sensitivity: opts.sensitivity ?? 0.3, cooldown: opts.cooldown ?? 60 });
    if (opts.layout) this.layout = opts.layout;
    this.dir = path.join(WORK, 'live', this.id);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async start() {
    await this.startRecorder();
    this.chat = openChat(this.src, (m) => { this.messages++; this.det.add(m.t, m.text); this.chatLines.push(m.text); if (this.chatLines.length > 60) this.chatLines.shift(); }, (st) => { this.chatStatus = st; });
    this.ticker = setInterval(() => this.tick(), 1000);
    this.poller = setInterval(() => this.pollSegments(), 500);
  }

  private async startRecorder() {
    this.recStatus = 'connecting';
    const { inputs } = await resolveStream(this.src);
    this.run++;
    const prefix = `r${this.run}_`;
    const list = path.join(this.dir, `${prefix}list.csv`);
    this.listFile = list; this.listRead = 0;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning',
      ...inputs.flatMap((u, i) => (i ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-i', u] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-i', u])),
      ...(inputs.length > 1 ? ['-copyts', '-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0?', '-map', '0:a:0?']),
      '-c', 'copy', '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts',
      '-segment_list', list, '-segment_list_type', 'csv', '-reset_timestamps', '0', path.join(this.dir, `${prefix}%06d.ts`)];
    const p = spawn('ffmpeg', args);
    this.rec = p; this.recStatus = 'recording';
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err = (err + d).slice(-2000); });
    p.on('close', () => {
      if (this.stopping) return;
      this.restartRecorder(3000);
    });
  }

  private restartRecorder(delay: number) {
    this.recStatus = 'reconnecting';
    this.restarts++;
    if (this.restarts > 20) { this.error = 'The stream ended or keeps dropping.'; this.recStatus = 'stopped'; return; }
    setTimeout(() => {
      if (this.stopping) return;
      this.startRecorder().catch((e) => { this.error = e.message; this.restartRecorder(15000); });
    }, delay);
  }

  private pollSegments() {
    if (!this.listFile) return;
    let text: string; try { text = fs.readFileSync(this.listFile, 'utf8'); } catch { return; }
    const now = Date.now() / 1000;
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(this.listRead)) {
      const [file, a, b] = line.split(',');
      const start = parseFloat(a); const end = parseFloat(b);
      if (!file || Number.isNaN(end)) continue;
      this.runOffsets.push(now - end); if (this.runOffsets.length > 30) this.runOffsets.shift();
      const off = [...this.runOffsets].sort((x, y) => x - y)[Math.floor(this.runOffsets.length / 2)];
      const full = path.join(this.dir, file);
      let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ }
      this.seq++;
      this.segments.push({ file: full, run: this.run, start, end, wStart: start + off, wEnd: end + off, size, seq: this.seq });
    }
    this.listRead = lines.length;
    const keepFrom = Math.min(now - KEEP_SEC, ...(this.pendingCuts.length ? this.pendingCuts.map((c) => c.w0 - 4) : [now - KEEP_SEC]));
    for (const seg of this.segments) {
      if (!seg.deleted && seg.wEnd < keepFrom) { seg.deleted = true; fs.rm(seg.file, { force: true }, () => {}); }
    }
  }

  private tick() {
    const now = Date.now() / 1000;
    const r = this.det.tick(now);
    this.history.push({ t: now, score: r.score, mps: r.mps });
    if (this.history.length > 600) this.history.shift();
    if (r.spike) this.cut(r);
  }

  private cut(r: { t: number; score: number; mps: number; hype: number }) {
    const segs = this.segments.filter((x) => !x.deleted);
    if (!segs.length) return;
    const endWall = Math.max(...segs.map((s) => s.wEnd));
    const pre = 12, post = 24;
    let w0 = r.t - pre;
    let w1 = Math.min(endWall, r.t + post);
    if (w1 - w0 < 15) w0 = w1 - 15;
    const id = `c${this.id}_${Date.now().toString(36)}`;
    const clip: ClipRecord = {
      id, createdAt: new Date().toISOString(), status: 'queued',
      channel: this.src.channel, platform: this.src.platform, label: this.src.label, sessionId: this.id,
      start: w0, end: w1, spikeAt: r.t,
      reason: { kind: 'chat', score: r.score, mps: r.mps, hype: r.hype },
      layout: this.layout,
      chatSample: [...this.chatLines],
    };
    this.clips.push(clip);
    this.pendingCuts.push({ w0, w1 });
    // mark segments the cut needs so the buffer does not delete them
    for (const s of this.segments) if (!s.deleted && s.wEnd >= w0 - 4) s.deleted = false;
    this.onClip(clip);
  }

  state() {
    const segs = this.segments.filter((x) => !x.deleted);
    const buffered = segs.length ? segs[segs.length - 1].wEnd - segs[0].wStart : 0;
    return {
      id: this.id, recording: true, channel: this.src.channel, platform: this.src.platform, label: this.src.label,
      chat: this.chatStatus, rec: this.recStatus, messages: this.messages, clips: this.clips,
      history: this.history.slice(-300), bufferSec: Math.round(buffered),
      diskMB: Math.round(segs.reduce((a, x) => a + (x.size || 0), 0) / 1e6),
      error: this.error, layout: this.layout, sensitivity: this.sensitivity, chatLines: this.chatLines.slice(-20),
    };
  }

  stop() {
    this.stopping = true;
    clearInterval(this.ticker); clearInterval(this.poller);
    try { this.chat?.close(); } catch { /* gone */ }
    try { this.rec?.kill('SIGKILL'); } catch { /* gone */ }
  }
}
