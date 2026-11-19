// Live session: record the stream into a rolling ~4 minute buffer of 2 s segments,
// read chat anonymously, and cut a clip when chat spikes. Also "Clip that": a
// manual cut the user triggers a beat after the moment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SpikeDetector } from './detect.ts';
import { openChat, resolveStream, type Parsed } from './platforms.ts';

const KEEP_SEC = 240;
const PAD = 30; // extra seconds recorded around every cut, so the editor can lengthen or shorten it
const WORK = '/home/user/clipper';

export type Segment = { file: string; run: number; start: number; end: number; wStart: number; wEnd: number; size: number; seq: number; deleted?: boolean };

export type ClipRecord = {
  id: string; createdAt: string; status: 'queued' | 'processing' | 'done' | 'error';
  channel: string; platform: string; label: string; sessionId?: string;
  start: number; end: number; spikeAt: number; bounds?: { min: number; max: number };
  recWindow?: { w0: number; w1: number }; // the padded window actually recorded, clip start/end live inside it
  reason: { kind: string; score: number; mps: number; hype: number; text?: string };
  layout?: string; virality?: { score: number; parts: Record<string, number> };
  video?: string; covers?: string[]; title?: string; hook?: string; caption?: string;
  transcript?: string; chatSample?: string[]; error?: string; progress?: number;
  words?: Array<{ w: string; s: number; e: number }>;
};

export type Cut = { w0: number; w1: number; spikeW: number; score: number; threshold: number; mps: number; hype: number; manual?: boolean };

export class LiveSession {
  id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
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
  chatLines: Array<{ t: number; user: string; text: string }> = [];
  sensitivity: number;
  cooldown: number;
  layout: string;
  startedAt = Date.now();
  // streamer camera box (fractions of the frame). null until detected or set; the UI can set it.
  cam: { x: number; y: number; w: number; h: number } | null = null;

  private rec: any = null;
  private chat: any = null;
  private ticker: any = null;
  private poller: any = null;
  private listRead = 0;
  private runOffsets: number[] = [];
  private run = 0;
  private restarts = 0;
  private stopping = false;
  private pendingCuts: Cut[] = [];
  private listFile: string | null = null;
  private seq = 0;
  private onClip: (clip: ClipRecord) => void;

  constructor(src: Parsed, opts: { onClip: (c: ClipRecord) => void; sensitivity?: number; cooldown?: number; layout?: string; cam?: ClipSessionCam }) {
    this.src = src;
    this.onClip = opts.onClip;
    this.sensitivity = opts.sensitivity ?? 0.3;
    this.cooldown = opts.cooldown ?? 60;
    this.layout = opts.layout || 'facecam';
    if (opts.cam) this.cam = opts.cam;
    this.det = new SpikeDetector({ sensitivity: this.sensitivity, cooldown: this.cooldown });
    this.dir = path.join(WORK, 'live', this.id);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async start() {
    await this.startRecorder();
    this.chat = openChat(this.src,
      (m) => { this.messages++; this.det.add(m.t, m.text); this.chatLines.push(m); if (this.chatLines.length > 80) this.chatLines.shift(); },
      (st) => { this.chatStatus = st; });
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
    const rec = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'];
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning',
      ...inputs.flatMap((u, i) => (i ? [...rec, '-i', u] : [...rec, '-i', u])),
      ...(inputs.length > 1 ? ['-copyts', '-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0?', '-map', '0:a:0?']),
      '-c', 'copy', '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts',
      '-segment_list', list, '-segment_list_type', 'csv', '-reset_timestamps', '0', path.join(this.dir, `${prefix}%06d.ts`)];
    const p = spawn('ffmpeg', args);
    this.rec = p; this.recStatus = 'recording';
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    p.on('close', () => {
      if (this.stopping) return;
      this.lastRecError = err.split('\n').filter(Boolean).pop() || '';
      this.restartRecorder(3000);
    });
  }
  private lastRecError = '';

  private restartRecorder(delay: number) {
    this.recStatus = 'reconnecting';
    this.restarts++;
    if (this.restarts > 30) { this.error = 'The stream ended or keeps dropping.'; this.recStatus = 'stopped'; return; }
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
      // map stream time -> wall clock with a running median of (arrival - stream end)
      this.runOffsets.push(now - end); if (this.runOffsets.length > 30) this.runOffsets.shift();
      const off = [...this.runOffsets].sort((x, y) => x - y)[Math.floor(this.runOffsets.length / 2)];
      const full = path.join(this.dir, file);
      let size = 0; try { size = fs.statSync(full).size; } catch { /* ignore */ }
      this.seq++;
      this.segments.push({ file: full, run: this.run, start, end, wStart: start + off, wEnd: end + off, size, seq: this.seq });
    }
    this.listRead = lines.length;
    // fire any pending cut whose end is now on disk
    const endWall = this.endWall();
    for (const cut of [...this.pendingCuts]) {
      if (endWall != null && endWall >= cut.w1 - 1) {
        this.pendingCuts = this.pendingCuts.filter((c) => c !== cut);
        this.buildClip(cut).catch(() => { /* buffer gone */ });
      }
    }
    // drop old segments no pending cut needs
    const keepFrom = Math.min(now - KEEP_SEC, ...(this.pendingCuts.length ? this.pendingCuts.map((c) => c.w0 - 4) : [now - KEEP_SEC]));
    for (const s of this.segments) {
      if (!s.deleted && s.wEnd < keepFrom) { s.deleted = true; fs.rm(s.file, { force: true }, () => {}); }
    }
  }

  private endWall(): number | null {
    const segs = this.segments.filter((x) => !x.deleted && x.run === this.run);
    return segs.length ? segs[segs.length - 1].wEnd : null;
  }

  private tick() {
    const now = Date.now() / 1000 - 1; // the second that just finished
    const r = this.det.tick(now);
    this.history.push({ t: Math.floor(now), score: r.score, mps: r.mps });
    if (this.history.length > 600) this.history.shift();
    if (r.spike) {
      const before = 20, after = 10;
      const w0 = r.t - before - PAD, w1 = r.t + after + PAD;
      this.pendingCuts.push({ spikeW: r.t, w0, w1, score: Math.max(r.score, this.det.peak || r.score), threshold: r.threshold, mps: r.mps, hype: r.hype });
    }
  }

  // "Clip that": the user saw a moment and pressed a beat after it. Cut around it without filters.
  clipNow(): { ok: true; readyIn: number } {
    const at = Math.floor(Date.now() / 1000) - 3;
    const before = 20, after = 10;
    this.pendingCuts.push({ spikeW: at, w0: at - before - PAD, w1: at + 10 + PAD, score: 0, threshold: 0, mps: 0, hype: 0, manual: true });
    return { ok: true, readyIn: 25 };
  }

  updateSensitivity(sens: number, cooldown?: number) {
    if (Number.isFinite(sens)) { this.sensitivity = sens; this.det.sensitivity = sens; }
    if (cooldown && cooldown > 0) { this.cooldown = cooldown; this.det.cooldown = cooldown; }
  }

  private async buildClip(cut: Cut) {
    const segs = this.segments.filter((x) => !x.deleted && x.wEnd >= cut.w0 - 4 && x.wStart <= cut.w1 + 4).sort((a, b) => a.start - b.start);
    if (!segs.length) return;
    const id = `c${this.id}_${(cut.spikeW * 1000 | 0).toString(36)}`;
    const clip: ClipRecord = {
      id, createdAt: new Date().toISOString(), status: 'queued',
      channel: this.src.channel, platform: this.src.platform, label: this.src.label, sessionId: this.id,
      // window given to the pipeline: inside the padded recording window
      start: cut.spikeW - 20, end: cut.spikeW + 10, spikeAt: cut.spikeW,
      recWindow: { w0: cut.w0, w1: cut.w1 },
      reason: cut.manual
        ? { kind: 'manual', score: 0, mps: 0, hype: 0, text: 'Clipped by you' }
        : { kind: 'chat', score: cut.score, mps: cut.mps, hype: cut.hype, text: `Chat ${cut.mps.toFixed(1)} msg/s, ${cut.score.toFixed(1)}x above normal${cut.hype > 0.3 ? ', hype words' : ''}` },
      layout: this.layout,
      chatSample: this.chatLines.filter((m) => m.t >= cut.spikeW - 5 && m.t <= cut.spikeW + 12).map((m) => m.text).slice(0, 80),
    };
    this.clips.push(clip);
    this.onClip(clip);
  }

  // segments a clip window needs, for the pipeline snapshot
  segmentsFor(w0: number, w1: number): Segment[] {
    return this.segments.filter((x) => x.wEnd >= w0 - 4 && x.wStart <= w1 + 4 && fs.existsSync(x.file)).sort((a, b) => a.start - b.start);
  }

  state() {
    const segs = this.segments.filter((x) => !x.deleted);
    const buffered = segs.length ? segs[segs.length - 1].wEnd - segs[0].wStart : 0;
    return {
      id: this.id, recording: true, channel: this.src.channel, platform: this.src.platform, label: this.src.label,
      chat: this.chatStatus, rec: this.recStatus, messages: this.messages,
      history: this.history.slice(-300), bufferSec: Math.round(buffered),
      diskMB: Math.round(segs.reduce((a, x) => a + (x.size || 0), 0) / 1e6),
      error: this.error, layout: this.layout, sensitivity: this.sensitivity, cooldown: this.cooldown,
      cam: this.cam, startedAt: this.startedAt,
      chatLines: this.chatLines.slice(-18).map((m) => `${m.user}: ${m.text}`),
      clips: this.clips,
    };
  }

  stop() {
    this.stopping = true;
    clearInterval(this.ticker); clearInterval(this.poller);
    try { this.chat?.close(); } catch { /* gone */ }
    try { this.rec?.kill('SIGKILL'); } catch { /* gone */ }
    setTimeout(() => { try { fs.rm(this.dir, { recursive: true, force: true }, () => {}); } catch { /* gone */ } }, 2000);
  }
}

type ClipSessionCam = { x: number; y: number; w: number; h: number };
