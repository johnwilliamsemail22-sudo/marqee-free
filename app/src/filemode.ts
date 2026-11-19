// File mode: a VOD / OBS recording (URL or uploaded file) through the same
// pipeline. Moments come from loudness spikes (and chat-log spikes when a log
// is given). One analysis at a time.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { seriesPeaks, detectChatSpikes, type SpikeDetector } from './detect.ts';
import type { ClipRecord } from './live.ts';

const WORK = '/home/user/clipper';

type LoudSeries = { step: number; values: number[] };

// Loudness (dB RMS) per step seconds, audio only, fast: decode to 8 kHz PCM and average.
async function loudnessSeries(file: string, { step = 0.5, onProgress, duration }: { step?: number; onProgress?: (p: number) => void; duration?: number } = {}): Promise<LoudSeries> {
  const rate = 8000; const per = Math.round(rate * step);
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-']);
    const out: number[] = []; let acc = 0; let n = 0; let leftover = Buffer.alloc(0);
    p.stdout.on('data', (chunk: Buffer) => {
      const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = buf.length - (buf.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768; acc += v * v; n++;
        if (n === per) { out.push(10 * Math.log10(acc / n + 1e-10)); acc = 0; n = 0; if (duration && onProgress) onProgress(Math.min(1, (out.length * step) / duration)); }
      }
      leftover = buf.subarray(usable);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ step, values: out }) : reject(new Error('loudness scan failed'))));
  });
}

export class FileMode {
  busy = false;
  stage = 'idle';
  p = 0;
  error: string | null = null;
  private abort = false;
  onClip: (clip: ClipRecord) => void;
  updateClip: (id: string, patch: Partial<ClipRecord>) => void;
  enqueue: (id: string) => void;

  constructor(opts: { onClip: (c: ClipRecord) => void; updateClip: (id: string, patch: Partial<ClipRecord>) => void; enqueue: (id: string) => void }) {
    Object.assign(this, opts);
  }

  state() { return { busy: this.busy, stage: this.stage, p: this.p, error: this.error }; }

  async analyse({ url, file, channel, chatLogUrl, sensitivity = 0.55, cooldownSec = 40, beforeSec = 20, afterSec = 10, maxClips = 5 }: any) {
    if (this.busy) throw new Error('Already working on a file.');
    this.busy = true; this.error = null; this.abort = false;
    const id = `f${Date.now().toString(36)}`;
    const dir = path.join(WORK, 'file', id);
    fs.mkdirSync(dir, { recursive: true });
    const local = file || path.join(dir, 'input.mp4');
    try {
      if (url) {
        this.stage = 'downloading'; this.p = 0;
        await new Promise<void>((resolve, reject) => {
          const p = spawn('yt-dlp', ['--no-check-certificates', '--no-warnings', '--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '-o', local.replace(/\.mp4$/, '') + '.%(ext)s', url]);
          let err = '';
          p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); const m = /\[download\]\s+([\d.]+)%/.exec(d.toString()); if (m) { this.p = Number(m[1]) / 100 * 0.5; } });
          p.on('error', reject);
          p.on('close', (code) => {
            const got = fs.readdirSync(dir).find((f) => f.startsWith('input.') && !f.endsWith('.part'));
            if (code === 0 && got) { resolve(); } else reject(new Error(err.split('\n').filter(Boolean).pop() || 'download failed'));
          });
        });
      }
      this.stage = 'probe'; this.p = 0.55;
      const info = await new Promise<any>((resolve, reject) => {
        const p = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', local]);
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', reject);
        p.on('close', (code) => {
          try {
            const j = JSON.parse(out);
            const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
            const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
            if (!v || !Number(j.format.duration)) return reject(new Error('This file has no video we can read.'));
            resolve({ duration: Number(j.format.duration), width: v.width, height: v.height, hasAudio: !!a });
          } catch (e) { reject(e); }
        });
      });
      this.stage = 'loudness'; this.p = 0.6;
      const loud = info.hasAudio ? await loudnessSeries(local, { duration: info.duration, onProgress: (p2) => { this.p = 0.6 + p2 * 0.3; } }) : { step: 0.5, values: [] };
      const peaks = seriesPeaks(loud.values, loud.step, { sensitivity, cooldown: cooldownSec, max: maxClips * 2 });
      let moments: Array<{ t: number; score: number; kind: string; why: string }> = peaks.peaks.map((pk: any) => ({ t: pk.t, score: pk.score, kind: 'loud', why: `Loud moment, ${pk.score.toFixed(1)}x above the usual level` }));
      // chat log support: fetch if a URL was given, parse timestamped lines "mm:ss user: text" or "[hh:mm:ss]"
      if (chatLogUrl) {
        this.stage = 'chat'; this.p = 0.9;
        try {
          const res = await fetch(chatLogUrl);
          const text = await res.text();
          const msgs: Array<{ t: number; text: string }> = [];
          for (const line of text.split(/\r?\n/)) {
            const m = /^(?:\[)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\])?\s*(?:<|\|)?\s*[\w ]*?:?\s*(.*)$/.exec(line);
            if (!m) continue;
            const t = m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
            if (t >= 0 && t <= info.duration && m[4]) msgs.push({ t, text: m[4] });
          }
          if (msgs.length) {
            const chat = detectChatSpikes(msgs, { sensitivity, cooldown: cooldownSec });
            for (const sp of chat.spikes) {
              if (moments.some((m) => Math.abs(m.t - sp.t) < cooldownSec)) continue;
              moments.push({ t: sp.t, score: sp.score, kind: 'chat', why: `Chat ${sp.mps.toFixed(1)} msg/s` });
            }
          }
        } catch { /* chat optional */ }
      }
      moments = moments.sort((a, b) => b.score - a.score).slice(0, maxClips).sort((a, b) => a.t - b.t);
      this.stage = 'queue'; this.p = 0.95;
      for (const m of moments) {
        const before = m.kind === 'chat' ? beforeSec : Math.max(10, beforeSec - 6);
        const clip: ClipRecord = {
          id: `c${id}_${Math.round(m.t).toString(36)}`, createdAt: new Date().toISOString(), status: 'queued',
          channel: channel || 'file', platform: 'file', label: channel || path.basename(local), sessionId: id,
          start: Math.max(0, m.t - before), end: Math.min(info.duration, m.t + afterSec), spikeAt: m.t,
          bounds: { min: 0, max: info.duration },
          reason: { kind: m.kind, score: m.score, mps: 0, hype: 0, text: m.why },
          recWindow: { w0: Math.max(0, m.t - before), w1: Math.min(info.duration, m.t + afterSec) },
        };
        this.onClip(clip);
        this.enqueue(clip.id);
      }
      this.stage = 'done'; this.p = 1;
      return { sessionId: id, clips: moments.length, duration: info.duration };
    } catch (e: any) {
      this.error = e.message; this.stage = 'error';
      throw e;
    } finally {
      this.busy = false;
      setTimeout(() => { if (!this.busy) { this.stage = 'idle'; this.p = 0; } }, 5000);
    }
  }
}
