// Clip pipeline: snapshot the buffer window -> transcribe (word timestamps) ->
// render vertical 1080x1920 with layout + captions (+ optional punch-zoom beats) ->
// covers -> virality score -> title/hook/caption -> export bundle.
// Everything runs locally in the sandbox. Nothing paid, no licence.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { viralityScore, writeClipText, isHype, type Word } from './detect.ts';
import { templateStages, templateCaptions, templateAccent, TEMPLATES, type TemplateId, type TplCtx } from './templates.ts';

const OW = 1080; const OH = 1920;
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const WORK = '/home/user/clipper';
const CLIPS = path.join(WORK, 'clips');
const ARCHIVE = '/home/user/Documents/ClipIt/clips'; // durable copies of finished clips
fs.mkdirSync(CLIPS, { recursive: true });
fs.mkdirSync(ARCHIVE, { recursive: true });

export type Cam = { x: number; y: number; w: number; h: number };
export type CaptionStyle = Partial<{ on: boolean; preset: string; color: string; highlight: string; size: number; position: number; wordsPerLine: number; uppercase: boolean }>;

function run(cmd: string, args: string[], timeoutMs = 600000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-20000); });
    p.on('error', reject);
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } reject(new Error(`${path.basename(cmd)} timed out`)); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(t); (code === 0 ? resolve({ stdout: out, stderr: err }) : reject(Object.assign(new Error(`${path.basename(cmd)} failed (${code}): ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`), { stderr: err }))); });
  });
}

async function probe(file: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams || []).find((s: any) => s.codec_type === 'audio');
  const [n, d] = (v?.avg_frame_rate || '30/1').split('/').map(Number);
  return { duration: Number(j.format.duration) || 0, width: v?.width || 0, height: v?.height || 0, fps: d ? n / d : 30, hasAudio: !!a };
}

// ---------------------------------------------------------------- layouts
const DEFAULT_CAM: Cam = { x: 0.72, y: 0.62, w: 0.26, h: 0.34 };
const MIN_CAM_W = 490; const MIN_CAM_H = 330;
const camCrop = (src: { width: number; height: number }, cam: Cam | null) => {
  const c = cam && cam.w > 0.02 && cam.h > 0.02 ? cam : DEFAULT_CAM;
  let w = src.width * c.w; let h = src.height * c.h;
  const cx = src.width * (c.x + c.w / 2); const cy = src.height * (c.y + c.h / 2);
  const grow = Math.max(1, MIN_CAM_W / w, MIN_CAM_H / h);
  w = Math.min(src.width, w * grow); h = Math.min(src.height, h * grow);
  const x = Math.max(0, Math.min(src.width - w, cx - w / 2)); const y = Math.max(0, Math.min(src.height - h, cy - h * 0.45));
  return { w: even(w), h: even(h), x: Math.round(x), y: Math.round(y) };
};
const SHARPEN = 'unsharp=5:5:0.7:5:5:0';

function facecam(src: { width: number; height: number }, cam: Cam | null, split = 0.38): string {
  const topH = even(OH * split); const botH = OH - topH;
  const c = camCrop(src, cam);
  const gh = src.height; const gw = Math.min(src.width, even(gh * (OW / botH)));
  const gx = Math.round((src.width - gw) / 2);
  return '[0:v]split=2[c0][g0];'
    + `[c0]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${OW}:${topH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${topH},${SHARPEN}[cam];`
    + `[g0]crop=${gw}:${gh}:${gx}:0,scale=${OW}:${botH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${botH}[game];`
    + '[cam][game]vstack=inputs=2,setsar=1[v]';
}
// gameplay on top, camera below (the reaction-clip layout)
function reaction(src: { width: number; height: number }, cam: Cam | null): string {
  const gameH = even(OH * 0.58); const camH = OH - gameH;
  const gw = Math.min(src.width, even(src.height * (OW / gameH)));
  const gx = Math.round((src.width - gw) / 2);
  const c = camCrop(src, cam);
  return '[0:v]split=2[c0][g0];'
    + `[g0]crop=${gw}:${src.height}:${gx}:0,scale=${OW}:${gameH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${gameH}[game];`
    + `[c0]crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${OW}:${camH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OW}:${camH},${SHARPEN}[cam];`
    + '[game][cam]vstack=inputs=2,setsar=1[v]';
}
function face(src: { width: number; height: number }, cam: Cam | null): string {
  const c = cam || DEFAULT_CAM;
  const cw = Math.min(src.width, even(src.height * (OW / OH)));
  const cx = Math.max(0, Math.min(src.width - cw, Math.round((c.x + c.w / 2) * src.width - cw / 2)));
  return `[0:v]crop=${cw}:${src.height}:${cx}:0,scale=${OW}:${OH}:flags=lanczos,setsar=1[v]`;
}
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
export const LAYOUTS = ['facecam', 'split', 'face', 'center', 'blur', 'reaction'];
const NEEDS_CAM = new Set(['facecam', 'split', 'reaction']);

function layoutFilter(name: string, src: { width: number; height: number }, cam: Cam | null): string {
  switch (name) {
    case 'split': return facecam(src, cam, 0.5);
    case 'face': return face(src, cam);
    case 'center': return center(src);
    case 'blur': return blur(src);
    case 'reaction': return reaction(src, cam);
    default: return facecam(src, cam, 0.38);
  }
}

// ---------------------------------------------------------------- captions (ASS, word-synced)
function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '&H00FFFFFF';
  const r = m[1].slice(0, 2), g = m[1].slice(2, 4), b = m[1].slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}
function ts(t: number) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, ' ');

function assHeader(style: { font: string; size: number; color: string; outline: number; borderStyle: number }) {
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${style.font},${style.size},${assColor(style.color)},${assColor(style.color)},&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,${style.outline},${style.borderStyle},5,60,60,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');
}

// pop: one word (or two said together) at a time, big, quick scale pop, highlight on punch
function popEvents(words: Array<{ w: string; s: number; e: number }>, style: Required<Pick<CaptionStyle, 'color' | 'highlight' | 'position' | 'uppercase'>>, dur: number, y: number): string[] {
  const beats: Array<{ s: number; e: number; words: Word[] }> = [];
  for (const w of words) {
    const last = beats[beats.length - 1];
    if (last && w.s - last.s < 0.18 && last.words.length < 2) { last.words.push(w); last.e = w.e; } else beats.push({ s: w.s, e: w.e, words: [w] });
  }
  const ev: string[] = [];
  beats.forEach((b, i) => {
    const next = beats[i + 1];
    const end = next ? next.s - 0.01 : Math.min(dur, b.e + 0.4);
    if (end - b.s < 0.03) return;
    const tags = `{\\an5\\pos(${OW / 2},${y})\\fscx80\\fscy80\\t(0,70,\\fscx106\\fscy106)\\t(70,130,\\fscx100\\fscy100)}`;
    const word = b.words.map((w) => w.w).join(' ');
    const colour = /[!?]$/.test(word) ? `{\\c${assColor(style.highlight)}}` : '';
    ev.push(`Dialogue: 0,${ts(b.s)},${ts(Math.min(end, b.e + 0.6))},Cap,,0,0,0,,${tags}${colour}${esc(style.uppercase ? word.toUpperCase() : word)}`);
  });
  return ev;
}

// karaoke: the whole line, the word being said in the highlight colour
function karaokeEvents(words: Array<{ w: string; s: number; e: number }>, style: any, perLine: number, dur: number, y: number): string[] {
  const lines: Word[][] = [];
  let cur: Word[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    if (cur.length >= perLine || (next && next.s - w.e > 0.6) || /[.!?…]$/.test(w.w) || !next) { lines.push(cur); cur = []; }
  });
  const ev: string[] = [];
  lines.forEach((line, li) => {
    const nextStart = lines[li + 1] ? lines[li + 1][0].s : dur;
    const ls = line[0].s; const le = Math.max(ls + 0.2, Math.min(line[line.length - 1].e + 0.25, nextStart - 0.01));
    line.forEach((w, i) => {
      const s = i === 0 ? ls : Math.min(w.s, le - 0.05);
      const e = i === line.length - 1 ? le : Math.min(line[i + 1].s, le);
      if (e - s < 0.02) return;
      const body = line.map((x, j) => (j === i ? `{\\c${assColor(style.highlight)}}${esc(style.uppercase ? x.w.toUpperCase() : x.w)}{\\c${assColor(style.color)}}` : esc(style.uppercase ? x.w.toUpperCase() : x.w))).join(' ');
      ev.push(`Dialogue: 0,${ts(s)},${ts(e)},Cap,,0,0,0,,{\\an5\\pos(${OW / 2},${y})}${body}`);
    });
  });
  return ev;
}

export function buildAss(words: Word[], style: CaptionStyle, dur: number, clipStart: number): string {
  const st = { preset: 'pop', font: 'DejaVu Sans', color: '#FFFFFF', highlight: '#FFD84D', size: 86, position: 0.7, wordsPerLine: 3, uppercase: true, ...(style || {}) };
  const y = Math.round(OH * st.position);
  const clean = (words || []).filter((w) => w.e > clipStart && w.s < clipStart + dur && w.w?.trim())
    .map((w) => ({ ...w, s: Math.max(0, w.s - clipStart), e: Math.min(dur, w.e - clipStart) }));
  const header = assHeader({ font: st.font, size: st.size, color: st.color, outline: Math.max(3, Math.round(st.size / 14)), borderStyle: st.preset === 'clean' ? 2 : 3 });
  let ev: string[] = [];
  if (st.preset === 'pop') ev = popEvents(clean, st as any, dur, y);
  else if (st.preset === 'karaoke') ev = karaokeEvents(clean, st, st.wordsPerLine, dur, y);
  else { // clean
    ev = karaokeEvents(clean, { ...st, uppercase: false, highlight: st.color }, st.wordsPerLine, dur, y);
  }
  return `${header}\n${ev.join('\n')}\n`;
}

// ---------------------------------------------------------------- viral punch-zoom beats
// the strongest spoken moments get a quick 12% punch-in, like viral clip edits
function zoomBeats(words: Word[], clipStart: number, dur: number): number[] {
  const scored = (words || [])
    .filter((w) => w.s >= clipStart && w.s <= clipStart + dur)
    .map((w) => ({ t: w.s - clipStart, s: (/[!?]$/.test(w.w) ? 2 : 0) + (isHype(w.w) ? 2 : 0) + (/^[A-Z0-9 !?]{4,}$/.test(w.w.trim()) ? 2 : 0) }))
    .filter((b) => b.s >= 2)
    .sort((a, b) => a.t - b.t);
  const picked: number[] = [];
  for (const b of scored) {
    if (picked.length >= 4) break;
    if (picked.every((t) => Math.abs(t - b.t) >= 2)) picked.push(+b.t.toFixed(2));
  }
  return picked;
}
function punchZoomFilter(beats: number[]): string {
  if (!beats.length) return '';
  const sig = beats.map((t) => `between(it,${t},${(t + 0.55).toFixed(2)})`).join('+');
  return `,zoompan=z='min(1.12,1+0.12*min(1,${sig}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${OH}:fps=30`;
}

// ---------------------------------------------------------------- covers
type CoverStyle = 'bold' | 'yellow' | 'glow' | 'outline';
const ACCENT = '#FFD84D';
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function rng(seed: number) { let s = seed || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export async function makeCover(clipDir: string, frameSrc: string, at: number, hook: string, style: CoverStyle, variant = 0): Promise<string> {
  const bg = path.join(clipDir, `bg_${style}${variant}.png`);
  await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(Math.max(0, at)), '-i', frameSrc, '-frames:v', '1', '-vf', `scale=${OW}:${OW * 16 / 9 | 0}:force_original_aspect_ratio=increase,crop=${OW}:${OW * 16 / 9 | 0}`, bg], 120000);
  const canvas = createCanvas(OW, OH);
  const ctx = canvas.getContext('2d');
  // cover the full 9:16: draw the wide grab scaled to fill, centre crop
  const img = await loadImage(bg);
  const scale = Math.max(OW / img.width, OH / img.height);
  const dw = img.width * scale, dh = img.height * scale;
  ctx.drawImage(img, (OW - dw) / 2, (OH - dh) / 2, dw, dh);
  const r = rng(hash(`${style}:${variant}:${hook}`));
  const tilt = r() * 4 - 2;
  const grad = ctx.createLinearGradient(0, 0, 0, OH * 0.5);
  grad.addColorStop(0, style === 'outline' ? 'rgba(0,0,0,0.78)' : 'rgba(0,0,0,0.58)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, OW, OH * 0.5);
  ctx.save();
  ctx.translate(OW / 2, 190);
  ctx.rotate((tilt * Math.PI) / 180);
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const maxW = OW - 120;
  let size = 150;
  const words = (hook || "YOU WON'T BELIEVE THIS").toUpperCase().split(/\s+/);
  let lines: string[] = [];
  const setFont = () => { ctx.font = `900 ${size}px "DejaVu Sans"`; };
  setFont();
  for (let attempt = 0; attempt < 8; attempt++) {
    lines = []; let cur = '';
    for (const w of words) {
      const t = cur ? cur + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    if (cur) lines.push(cur);
    if (lines.length <= 4) break;
    size = Math.round(size * 0.86); setFont();
  }
  const lh = size * 1.06;
  lines.forEach((ln, i) => {
    const yPos = i * lh;
    ctx.lineWidth = Math.max(6, size / 12);
    ctx.strokeStyle = style === 'yellow' ? '#ffffff' : 'rgba(0,0,0,0.9)';
    ctx.lineJoin = 'round';
    if (style !== 'outline') ctx.strokeText(ln, 0, yPos);
    ctx.fillStyle = style === 'yellow' ? ACCENT : '#ffffff';
    if (style === 'glow') { ctx.shadowColor = ACCENT; ctx.shadowBlur = 40; }
    ctx.fillText(ln, 0, yPos);
    ctx.shadowBlur = 0;
  });
  ctx.restore();
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, OH - 26, OW, 10);
  const out = path.join(clipDir, `cover_${style}${variant ? '_' + variant : ''}.png`);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  return out;
}

// ---------------------------------------------------------------- the pipeline
export type RenderOpts = { layout?: string; cam?: Cam | null; caption?: CaptionStyle; punchZoom?: boolean; template?: TemplateId; start?: number; end?: number };

export class Pipeline {
  private running = false;
  queue: string[] = [];
  getClip: (id: string) => any;
  setClip: (id: string, patch: any) => void;
  getSegments: (clip: any) => Array<{ file: string; wStart: number; wEnd: number }>;
  getCam: (channel: string) => Cam | null;

  constructor(opts: { getClip: (id: string) => any; setClip: (id: string, patch: any) => void; getSegments: (clip: any) => Array<{ file: string; wStart: number; wEnd: number }>; getCam: (ch: string) => Cam | null }) {
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

  private async snapshot(clip: any): Promise<{ raw: string; offset: number; duration: number; rawStart: number }> {
    const dir = path.join(CLIPS, clip.id);
    const win = clip.recWindow || { w0: clip.start, w1: clip.end };
    const segs = this.getSegments(clip);
    if (!segs.length) throw new Error('the buffer window is gone (clip cut too late)');
    const raw = path.join(dir, 'raw.mp4');
    const list = path.join(dir, 'concat.txt');
    fs.writeFileSync(list, segs.map((s) => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n'));
    spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', raw], { timeout: 120000 });
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 10000) throw new Error('could not assemble the clip window from the buffer');
    const first = segs[0];
    const off = Math.max(0, clip.start - first.wStart);
    this.setClip(clip.id, { rawStart: first.wStart });
    return { raw, offset: off, duration: Math.max(3, clip.end - clip.start), rawStart: first.wStart };
  }

  private async process(clip: any) {
    const dir = path.join(CLIPS, clip.id);
    fs.mkdirSync(dir, { recursive: true });
    this.setClip(clip.id, { status: 'processing', progress: 0.05 });
    const snap = await this.snapshot(clip);
    this.setClip(clip.id, { status: 'processing', progress: 0.2 });

    // 1. transcribe -> word timestamps (offset: times relative to clip.start)
    const wav = path.join(dir, 'audio.wav');
    let words: Word[] = [];
    let transcript = '';
    try {
      await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(snap.offset), '-i', snap.raw, '-t', String(snap.duration), '-vn', '-ac', '1', '-ar', '16000', '-af', 'highpass=f=90,lowpass=f=7600,dynaudnorm=f=150:g=15', wav], 120000);
      const wordsFile = path.join(dir, 'words.json');
      await run('python3', [path.join(import.meta.dirname ?? '.', 'transcribe.py'), wav, wordsFile, 'small'], 300000);
      const j = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
      words = (j.words || []).map((w: any) => ({ w: w.w, s: w.s + clip.start, e: w.e + clip.start }));
      transcript = j.text || words.map((w) => w.w).join(' ');
      this.setClip(clip.id, { words, transcript, progress: 0.45 });
      // tighten the end to the last spoken word + a beat
      if (words.length) {
        const naturalEnd = Math.min(clip.recWindow?.w1 ?? clip.end, words[words.length - 1].e + 1.2);
        if (naturalEnd > clip.start + 8 && naturalEnd > clip.end) { clip.end = naturalEnd; snap.duration = clip.end - clip.start; }
      }
    } catch { /* captions stay off if transcription fails */ }

    // 2. render vertical
    await this.renderClip(clip, dir, snap, words, this.renderOptsFor(clip));
    this.setClip(clip.id, { status: 'processing', progress: 0.85, video: `/media/clips/${clip.id}/clip_vertical.mp4` });

    // 3. covers: two initial variants
    const hook0 = writeClipText({ transcript, chat: clip.chatSample, channel: clip.channel }).hook;
    const covers: string[] = [];
    try {
      const c1 = await makeCover(dir, snap.raw, snap.offset + Math.min(2, snap.duration / 2), hook0, 'bold', 0);
      const c2 = await makeCover(dir, snap.raw, snap.offset + Math.min(3, snap.duration / 2), hook0, 'glow', 0);
      covers.push(`/media/clips/${clip.id}/${path.basename(c1)}`, `/media/clips/${clip.id}/${path.basename(c2)}`);
    } catch { /* covers optional */ }

    // 4. score + text + export bundle
    const v = viralityScore({ start: clip.start, end: clip.end, words, reason: clip.reason });
    const text = writeClipText({ transcript, chat: clip.chatSample, channel: clip.channel });
    const patch: any = { status: 'done', progress: 1, virality: v, title: text.title, hook: text.hook, caption: text.caption, covers };
    this.setClip(clip.id, patch);
    this.exportBundle(clip);
    try { fs.rm(snap.raw, { force: true }, () => {}); fs.rm(wav, { force: true }, () => {}); } catch { /* gone */ }
  }

  private renderOptsFor(clip: any): RenderOpts {
    return { layout: clip.layout || 'facecam', cam: clip.cam ?? undefined, caption: clip.captionStyle ?? { on: true }, template: clip.template || 'none' };
  }

  // re-render with editor options (used by the pipeline and by /api/clip/:id/render)
  async rerender(clip: any, opts: RenderOpts) {
    const dir = path.join(CLIPS, clip.id);
    const raw = path.join(dir, 'raw.mp4');
    if (fs.existsSync(raw)) {
      const rawStart = clip.rawStart ?? clip.start - 30;
      await this.renderClip(clip, dir, { raw, offset: 0, duration: 1, rawStart }, clip.words || [], opts);
    } else {
      const snap = await this.snapshot({ ...clip, recWindow: clip.recWindow || { w0: clip.start, w1: clip.end } });
      await this.renderClip(clip, dir, snap, clip.words || [], opts);
    }
    this.exportBundle(clip);
  }

  private async renderClip(clip: any, dir: string, snap: { raw: string; offset: number; duration: number; rawStart?: number }, words: Word[], opts: RenderOpts) {
    const rawStart = snap.rawStart ?? (clip.rawStart ?? clip.start - snap.offset);
    const start = opts.start ?? clip.start;
    const end = opts.end ?? clip.end;
    const dur = Math.max(2, end - start);
    const ssIn = Math.max(0, start - rawStart); // seconds into the raw snapshot where the clip begins
    const info = await probe(snap.raw);
    const tpl: TemplateId = (opts.template && opts.template !== 'none') ? opts.template : (opts.punchZoom === true ? 'punch' : 'none');
    // templates imply a layout until the user picked one deliberately
    let layout = opts.layout || 'facecam';
    if (tpl === 'speed' && !opts.layout) layout = 'reaction';
    // caption style: template defaults, then the user's overrides
    const cap = { on: true, preset: 'pop', ...(templateCaptions(tpl) || {}), ...((opts.caption || {}) as any) } as any;
    if (cap.highlight && cap.highlight === '#FFD84D' && tpl !== 'none') cap.highlight = templateAccent(tpl);
    let assFile: string | null = null;
    if (cap.on !== false && words?.length) {
      assFile = path.join(dir, 'captions.ass');
      fs.writeFileSync(assFile, buildAss(words, cap as CaptionStyle, dur, start));
    }
    // build one -filter_complex: layout -> template stages -> zoom -> subtitles
    const stages: string[] = [];
    const escPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    let chain = layoutFilter(layout, info, opts.cam ?? this.getCam(clip.channel));
    chain = chain.replace(/\[v\]$/, '[L]');
    stages.push(chain);
    let cur = '[L]';
    if (tpl !== 'none') {
      const beats = zoomBeats(words || [], start, dur);
      const ctx: TplCtx = { dur, beats, hook: clip.hook || writeClipText({ transcript: clip.transcript, chat: clip.chatSample, channel: clip.channel }).hook, accent: templateAccent(tpl), channel: String(clip.channel || 'us') };
      let idx = 0;
      for (const [filter, , outTag] of templateStages(tpl, ctx)) {
        stages.push(`${cur}${filter}[${outTag}${idx}]`);
        cur = `[${outTag}${idx}]`;
        idx++;
      }
    }
    if (tpl === 'punch' && words?.length) {
      const beats = zoomBeats(words, start, dur);
      if (beats.length) {
        const sig = beats.map((t) => `between(it,${t},${(t + 0.55).toFixed(2)})`).join('+');
        stages.push(`${cur}zoompan=z='min(1.12,1+0.12*min(1,${sig}))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${OW}x${OH}:fps=30[Z]`);
        cur = '[Z]';
      }
    }
    if (assFile) {
      stages.push(`${cur}subtitles='${escPath(assFile)}'[S]`);
      cur = '[S]';
    }
    stages.push(`${cur}fps=30,format=yuv420p[vo]`);
    const out = path.join(dir, 'clip_vertical.mp4');
    await run('ffmpeg', ['-hide_banner', '-y', '-ss', String(ssIn), '-i', snap.raw, '-t', String(dur),
      '-filter_complex', stages.join(';'), '-map', '[vo]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-af', 'dynaudnorm=f=150:g=15', '-movflags', '+faststart', out], 900000);
    this.setClip(clip.id, { video: `/media/clips/${clip.id}/clip_vertical.mp4`, start, end });
  }

  // export bundle: copy to durable storage + write the .txt with title and caption
  exportBundle(clip: any) {
    try {
      const dir = path.join(CLIPS, clip.id);
      const dest = path.join(ARCHIVE, clip.id);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of ['clip_vertical.mp4', ...fs.readdirSync(dir).filter((x) => x.startsWith('cover_'))]) {
        const src = path.join(dir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
      }
      // an archived copy of the recording itself, trimmed to the clip window, so the
      // clip can always be re-rendered with a different layout or captions later
      const raw = path.join(dir, 'raw.mp4');
      if (fs.existsSync(raw) && !fs.existsSync(path.join(dest, 'raw_cut.mp4'))) {
        const rawStart = clip.rawStart ?? clip.start - 30;
        spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(Math.max(0, clip.start - rawStart - 1)), '-i', raw,
          '-t', String((clip.end - clip.start) + 3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
          path.join(dest, 'raw_cut.mp4')], { timeout: 300000 });
      }
      const txt = [
        `TITLE: ${clip.title || ''}`,
        `HOOK: ${clip.hook || ''}`,
        '',
        'POSTING CAPTION:',
        clip.caption || '',
        '',
        `Channel: ${clip.label || clip.channel}`,
        `Score: ${clip.virality?.score ?? '?'}/100`,
        `Exported: ${new Date().toISOString()}`,
      ].join('\n');
      fs.writeFileSync(path.join(dest, 'post.txt'), txt);
    } catch { /* archive is best-effort */ }
  }

  // a new cover variant on demand ("shuffle the style")
  async newCover(clip: any, style: CoverStyle, variant: number): Promise<string> {
    const dir = path.join(CLIPS, clip.id);
    const raw = path.join(dir, 'raw.mp4');
    if (!fs.existsSync(raw)) throw new Error('the raw recording for this clip is gone; covers need it');
    const hook = clip.hook || writeClipText({ transcript: clip.transcript, chat: clip.chatSample, channel: clip.channel }).hook;
    const at = rawStart + ((start + end) / 2 - rawStart);
    const c = await makeCover(dir, raw, Math.max(0, Math.min(at, rawStart + 60)), hook, style, variant);
    return `/media/clips/${clip.id}/${path.basename(c)}`;
  }
}
