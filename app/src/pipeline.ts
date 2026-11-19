// Clip pipeline: cut -> transcribe -> render vertical with captions -> cover -> score -> title.
// One clip at a time. Everything runs locally in the sandbox, nothing paid.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { viralityScore, writeClipText, type Word } from './detect.ts';

const OW = 1080; const OH = 1920;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const WORK = '/home/user/clipper';
const CLIPS = path.join(WORK, 'clips');
export const MEDIA = path.join(WORK, 'media');
fs.mkdirSync(CLIPS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stdout: out, stderr: err }) : reject(Object.assign(new Error(`${path.basename(cmd)} failed (${code}): ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`), { stderr: err }))));
  });
}

async function probe(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = j.streams.find((s: any) => s.codec_type === 'video');
  const a = j.streams.find((s: any) => s.codec_type === 'audio');
  const [n, d] = (v?.avg_frame_rate || '30/1').split('/').map(Number);
  return { duration: Number(j.format.duration) || 0, width: v?.width || 0, height: v?.height || 0, fps: d ? n / d : 30, hasAudio: !!a };
}

// ---------------------------------------------------------------- layouts (ported)
const DEFAULT_CAM = { x: 0.72, y: 0.62, w: 0.26, h: 0.34 };
const MIN_CAM_W = 490; const MIN_CAM_H = 330;
const camCrop = (src: { width: number; height: number }, cam: { x: number; y: number; w: number; h: number }) => {
  const c = cam && cam.w > 0.02 ? cam : DEFAULT_CAM;
  let w = src.width * c.w; let h = src.height * c.h;
  const cx = src.width * (c.x + c.w / 2); const cy = src.height * (c.y + c.h / 2);
  const grow = Math.max(1, MIN_CAM_W / w, MIN_CAM_H / h);
  w = Math.min(src.width, w * grow); h = Math.min(src.height, h * grow);
  const x = Math.max(0, Math.min(src.width - w, cx - w / 2)); const y = Math.max(0, Math.min(src.height - h, cy - h * 0.45));
  return { w: even(w), h: even(h), x: Math.round(x), y: Math.round(y) };
};
const SHARPEN = 'unsharp=5:5:0.7:5:5:0';

function facecam(src: { width: number; height: number }, cam: { x: number; y: number; w: number; h: number }, split = 0.38): string {
  const topH = even(OH * split); const botH = OH - topH;
  const c = camCrop(src, cam);
  const gh = src.height; const gw = Math.min(src.width, even(gh * (OW / botH)));
  const gx = Math.round((src.width - gw) / 2);
  return '[0:v]split=2[c0][g0];'
    + `[c0]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${OW}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${topH},${SHARPEN}[cam];`
    + `[g0]crop=${gw}:${gh}:${gx}:0,scale=${OW}:${botH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${botH}[game];`
    + '[cam][game]vstack=inputs=2,setsar=1[v]';
}
function split50(src: { width: number; height: number }, cam: { x: number; y: number; w: number; h: number }): string { return facecam(src, cam, 0.5); }
function center(src: { width: number; height: number }): string {
  const cw = Math.min(src.width, even(src.height * (OW / OH)));
  return `[0:v]crop=${cw}:${src.height}:${Math.round((src.width - cw) / 2)}:0,scale=${OW}:${OH}:flags=lanczos,setsar=1[v]`;
}
function blur(src: { width: number; height: number }): string {
  return '[0:v]split=2[bg0][fg0];'
    + `[bg0]scale=${OW / 4}:${OH / 4}:force_original_aspect_ratio=increase,crop=${OW / 4}:${OH / 4},boxblur=12:2,scale=${OW}:${OH},eq=brightness=-0.08[bg];`
    + `[fg0]scale=${OW}:-2:flags=lanczos[fg];`
    + '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]';
}
export const LAYOUTS = ['facecam', 'split', 'face-center', 'center', 'blur'];
export const NEEDS_CAM = new Set(['facecam', 'split']);

function layoutFilter(name: string, src: { width: number; height: number }, cam: { x: number; y: number; w: number; h: number } | null): string {
  switch (name) {
    case 'split': return split50(src, cam || DEFAULT_CAM);
    case 'face-center': return center(src);
    case 'center': return center(src);
    case 'blur': return blur(src);
    default: return facecam(src, cam || DEFAULT_CAM);
  }
}

// ---------------------------------------------------------------- captions (word karaoke, ported)
function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '&H00FFFFFF';
  const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

export type CaptionStyle = Partial<{ preset: string; font: string; color: string; highlight: string; size: number; position: number; wordsPerLine: number; uppercase: boolean }>;

export function buildAss(words: Word[], style: CaptionStyle, dur: number, clipStart: number): string {
  const st = { preset: 'pop', font: 'DejaVu Sans', color: '#FFFFFF', highlight: '#FFD84D', size: 86, position: 0.72, wordsPerLine: 3, uppercase: true, ...style };
  const outline = Math.max(3, Math.round(st.size / 14));
  const primary = assColor(st.color);
  const back = '&H96000000';
  const fmt = (t: number) => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const lines: string[] = ['[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 2', '', '[V4+ Styles]',
    `Style: Cap,${st.font},${st.size},${primary},${assColor(st.highlight)},&H00000000,${back},-1,0,0,0,100,100,0,0,1,${outline},${st.preset === 'clean' ? 2 : 3},5,60,60,${Math.round(OH * st.position)},${Math.round(OH * st.position) * 2},0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const ws = words.filter((w) => w.s >= clipStart && w.e <= clipStart + dur);
  for (let i = 0; i < ws.length; i += st.wordsPerLine) {
    const line = ws.slice(i, i + st.wordsPerLine);
    const t0 = Math.max(0, line[0].s - clipStart);
    const t1 = Math.min(dur, (line[line.length - 1].e || line[line.length - 1].s + 0.3) - clipStart);
    const text = line.map((w) => (st.uppercase ? w.w.toUpperCase() : w.w).replace(/\{/g, '(')).join(' ');
    if (!text.trim()) continue;
    // karaoke highlight: \k per word (centiseconds)
    const ks = line.map((w, j) => {
      const prevEnd = j === 0 ? line[0].s : line[j].s;
      const gapCs = Math.max(0, Math.round((w.s - prevEnd) * 100));
      const durCs = Math.max(1, Math.round((w.e - w.s) * 100));
      return (j ? `{\\k${gapCs}}` : '') + `{\\k${durCs}}${st.uppercase ? w.w.toUpperCase() : w.w}`;
    }).join('');
    lines.push(`Dialogue: 0,${fmt(t0)},${fmt(t1)},Cap,,0,0,0,,{\\fad(60,60)}${ks}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- covers (canvas port)
type CoverStyle = 'bold' | 'yellow' | 'glow' | 'outline';
const ACCENT = '#FFD84D';

function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed: number) { let s = seed || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

async function grabFrame(src: string, at: number, out: string, w: number, h: number) {
  await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(at), '-i', src, '-frames:v', '1', '-vf', `scale=${w}:${h}`, out]);
}

export async function makeCover(clipDir: string, frameSrc: string, at: number, hook: string, style: CoverStyle, variant = 0): Promise<string> {
  const bg = path.join(clipDir, 'bg.png');
  await grabFrame(frameSrc, at, bg, OW, OH);
  const canvas = createCanvas(OW, OH);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageFromDataUrl ? null : null;
  void img;
  // draw background frame with a grade
  const grade = style === 'glow' ? 'saturate(1.3)' : 'saturate(1.05)';
  void grade;
  ctx.drawImage(await loadImage(bg), 0, 0, OW, OH);
  const r = rng(hash(`${style}:${variant}:${hook}`));
  const d = { accent: ACCENT, tilt: (r() * 4 - 2) };
  // top gradient for hook legibility
  const grad = ctx.createLinearGradient(0, 0, 0, OH * 0.5);
  grad.addColorStop(0, style === 'outline' ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, OW, OH * 0.5);
  // hook text, big, wrapped, top area
  ctx.save();
  ctx.translate(OW / 2, 190);
  ctx.rotate((d.tilt * Math.PI) / 180);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const maxW = OW - 120;
  let size = Math.round(150 * 1.0);
  const words = (hook || 'YOU WON\'T BELIEVE THIS').toUpperCase().split(/\s+/);
  let lines: string[] = [];
  ctx.font = `900 ${size}px "DejaVu Sans"`;
  for (let attempt = 0; attempt < 8; attempt++) {
    lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    if (lines.length <= 4) break;
    size = Math.round(size * 0.86); ctx.font = `900 ${size}px "DejaVu Sans"`;
  }
  const lh = size * 1.06;
  lines.forEach((ln, i) => {
    const y = i * lh;
    ctx.lineWidth = Math.max(6, size / 12);
    ctx.strokeStyle = style === 'yellow' ? '#ffffff' : 'rgba(0,0,0,0.9)';
    ctx.lineJoin = 'round';
    if (style !== 'outline') ctx.strokeText(ln, 0, y);
    ctx.fillStyle = style === 'yellow' ? ACCENT : style === 'glow' ? '#ffffff' : '#ffffff';
    if (style === 'glow') { ctx.shadowColor = ACCENT; ctx.shadowBlur = 40; }
    ctx.fillText(ln, 0, y);
    ctx.shadowBlur = 0;
  });
  ctx.restore();
  // accent bar
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, OH - 26, OW, 10);
  const out = path.join(clipDir, `cover_${style}${variant ? '_' + variant : ''}.png`);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

async function loadImage(file: string): Promise<any> {
  const { loadImage: load } = await import('@napi-rs/canvas');
  return load(file);
}

// ---------------------------------------------------------------- title heuristics
// (in detect.ts as writeClipText)

// ---------------------------------------------------------------- the pipeline
export class Pipeline {
  private running = false;
  queue: string[] = [];
  getClip: (id: string) => any;
  setClip: (id: string, patch: any) => void;
  getCam: (channel: string) => { x: number; y: number; w: number; h: number } | null;

  constructor(opts: { getClip: (id: string) => any; setClip: (id: string, patch: any) => void; getCam: (ch: string) => { x: number; y: number; w: number; h: number } | null }) {
    Object.assign(this, opts);
  }

  enqueue(id: string) { this.queue.push(id); setTimeout(() => this.next(), 300); }

  async next() {
    if (this.running || !this.queue.length) return;
    const id = this.queue.shift()!;
    const clip = this.getClip(id);
    if (!clip) { this.next(); return; }
    this.running = true;
    try { await this.process(clip); } catch (e: any) { this.setClip(id, { status: 'error', error: e.message }); }
    this.running = false;
    setTimeout(() => this.next(), 200);
  }

  private async process(clip: any) {
    const dir = path.join(CLIPS, clip.id);
    fs.mkdirSync(dir, { recursive: true });
    this.setClip(clip.id, { status: 'processing', progress: 0.05 });
    // 1. snapshot the buffer window into one raw file
    const snap = this.snapshot(clip);
    this.setClip(clip.id, { status: 'processing', progress: 0.2 });
    // 2. audio -> wav, whisper -> words
    const wav = path.join(dir, 'audio.wav');
    await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(snap.offset), '-i', snap.raw, '-t', String(snap.duration), '-vn', '-ac', '1', '-ar', '16000', wav]);
    const wordsFile = path.join(dir, 'words.json');
    try {
      await run('python3', [path.join(import.meta.dirname ?? '.', 'transcribe.py'), wav, wordsFile, 'base']);
      const j = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
      const words: Word[] = (j.words || []).map((w: any) => ({ w: w.w, s: w.s + clip.start, e: w.e + clip.start }));
      this.setClip(clip.id, { words, transcript: j.text || words.map((w) => w.w).join(' '), progress: 0.45 });
      // tighten the end to the last spoken word + a beat
      if (words.length) {
        const lastW = words[words.length - 1].e;
        const naturalEnd = Math.min(clip.end, lastW + 1.2);
        if (naturalEnd > clip.start + 6) { clip.end = naturalEnd; snap.duration = naturalEnd - clip.start; }
      }
    } catch { /* captions simply stay off if transcription fails */ }
    // 3. render vertical
    const rawCut = path.join(dir, 'cut.mp4');
    await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(snap.offset), '-i', snap.raw, '-t', String(snap.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', rawCut]);
    this.setClip(clip.id, { status: 'processing', progress: 0.55 });
    const info = await probe(rawCut);
    const vf: string[] = [layoutFilter(clip.layout || 'facecam', info, this.getCam(clip.channel) as any)];
    // captions
    let assFile: string | null = null;
    try {
      const words: Word[] = clip.words || [];
      if (words.length) {
        const ass = buildAss(words, { preset: 'pop' }, snap.duration, clip.start);
        assFile = path.join(dir, 'captions.ass');
        fs.writeFileSync(assFile, ass);
      }
    } catch { /* none */ }
    const finalV = path.join(dir, 'clip_vertical.mp4');
    const vfArgs: string[] = [];
    if (assFile) {
      const esc = assFile.replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
      vfArgs.push('-vf', `${vf[0]},ass='${assFile.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\\\:')}'`);
    } else vfArgs.push('-vf', vf[0]);
    await run('ffmpeg', ['-hide_banner', '-y', '-i', rawCut, ...vfArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-r', '30', finalV]);
    this.setClip(clip.id, { status: 'processing', progress: 0.8, video: `/media/clips/${clip.id}/clip_vertical.mp4`, start: clip.start, end: clip.end });
    // 4. covers (two variants)
    const words: Word[] = clip.words || [];
    const hook = writeClipText({ transcript: clip.transcript, chat: clip.chatSample, channel: clip.channel }).hook;
    try {
      const c1 = await makeCover(dir, rawCut, Math.min(2, snap.duration / 2), hook, 'bold', 0);
      const c2 = await makeCover(dir, rawCut, Math.min(2, snap.duration / 2), hook, 'glow', 0);
      this.setClip(clip.id, { covers: [`/media/clips/${clip.id}/${path.basename(c1)}`, `/media/clips/${clip.id}/${path.basename(c2)}`] });
    } catch { /* covers optional */ }
    // 5. score + title
    const v = viralityScore({ start: clip.start, end: clip.end, words, reason: clip.reason });
    const text = writeClipText({ transcript: clip.transcript, chat: clip.chatSample, channel: clip.channel });
    this.setClip(clip.id, { status: 'done', progress: 1, virality: v, title: text.title, hook: text.hook, caption: text.caption });
    try { fs.rm(snap.raw, { force: true }, () => {}); } catch { /* gone */ }
  }

  private snapshot(clip: any): { raw: string; offset: number; duration: number } {
    const raw = path.join(CLIPS, clip.id, 'raw.ts');
    const segs: any[] = (this as any)._segments(clip);
    if (!segs.length) throw new Error('the buffer window is gone');
    const list = path.join(CLIPS, clip.id, 'concat.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.file}'`).join('\n'));
    const first = segs[0];
    const off = Math.max(0, clip.start - first.wStart);
    const duration = Math.min(clip.end - clip.start + 0.5, 90);
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', raw], { timeout: 60000 });
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 1000) throw new Error('could not assemble the clip window from the buffer');
    return { raw, offset: off, duration };
  }
}

// concat helper used through Pipeline hooks
export function wireSnapshot(pipeline: Pipeline, liveSessions: { get: (id: string) => any | undefined }) {
  (pipeline as any)._segments = (clip: any) => {
    const s = liveSessions.get(clip.sessionId);
    if (!s) return [];
    return s.segments.filter((x: any) => !x.deleted && x.file && x.wEnd >= clip.start && x.wStart <= clip.end).sort((a: any, b: any) => a.start - b.start);
  };
}
