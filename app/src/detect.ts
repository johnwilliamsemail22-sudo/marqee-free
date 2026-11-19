// Chat spike detection: messages per second against a rolling baseline (z-score),
// boosted by hype words and emotes, with a sensitivity slider and a cooldown.
// Ported from the reference implementation analysis.

const HYPE = [
  'lul', 'lol', 'lmao', 'lmfao', 'kekw', 'omegalul', 'pog', 'pogchamp', 'poggers', 'pogu', 'w', 'ww', 'www', 'l',
  'clip', 'clip it', 'clipit', 'no way', 'nah', 'bro', 'wtf', 'omg', 'holy', 'insane', 'crazy', 'monkas', 'pepega',
  'icant', 'sadge', 'kappa', 'ez', 'gg', 'letsgo', "let's go", 'lets go', 'xd', 'aware', 'pause', 'sheesh', '😂', '💀', '🔥',
];
const HYPE_RE = new RegExp(`(^|[^a-z])(${HYPE.map((h) => h.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')).join('|')})(?=$|[^a-z])`, 'i');

const STRONG_RE = /(clip ?it|no ?way|kekw|omegalul|lmfao|holy|wtf|what\?!|!!!|\?\?\?)/i;

export function isStrong(text: string): boolean {
  const t = String(text || '');
  return STRONG_RE.test(t) || /^[A-Z0-9 !?]{6,}$/.test(t.trim()) || /(.)\1{6,}/.test(t);
}

export function isHype(text: string): boolean {
  const t = String(text || '').toLowerCase();
  if (HYPE_RE.test(t)) return true;
  if (/(.)\1{4,}/.test(t)) return true;
  return /^[A-Z0-9 !?]{4,}$/.test(String(text || '').trim());
}

export const thresholdFor = (sens: number) => 8.5 - 4.5 * Math.max(0, Math.min(1, sens));

export type Tick = { t: number; score: number; mps: number; hype: number; spike: boolean; threshold: number };

export class SpikeDetector {
  sensitivity: number; cooldown: number; baseline: number; warmup: number; minRate: number; sustain: number;
  recent: boolean[] = [];
  busy = false;
  peak = 0;
  counts = new Map<number, { n: number; hype: number; strong: number }>();
  lastSpike = -Infinity;
  inBurst = false;
  first: number | null = null;

  constructor(opts: { sensitivity?: number; cooldown?: number; baseline?: number; warmup?: number; minRate?: number; sustain?: number } = {}) {
    const { sensitivity = 0.3, cooldown = 60, baseline = 180, warmup = 30, minRate = 1.5, sustain = 3 } = opts;
    Object.assign(this, { sensitivity, cooldown, baseline, warmup, minRate, sustain });
  }

  add(t: number, text: string) {
    const s = Math.floor(t);
    if (this.first == null) this.first = s;
    const b = this.counts.get(s) || { n: 0, hype: 0, strong: 0 };
    b.n++; if (isHype(text)) b.hype++; if (isStrong(text)) b.strong++;
    this.counts.set(s, b);
  }

  tick(now: number): Tick {
    now = Math.floor(now);
    const get = (s: number) => this.counts.get(s) || { n: 0, hype: 0, strong: 0 };
    let n3 = 0, h3 = 0, st3 = 0;
    for (let s = now - 2; s <= now; s++) { n3 += get(s).n; h3 += get(s).hype; st3 += get(s).strong; }
    const mps = n3 / 3;
    const from = Math.max(this.first ?? now, now - this.baseline); const to = now - 6;
    const vals: number[] = [];
    for (let s = from; s <= to; s++) vals.push(get(s).n);
    for (const k of this.counts.keys()) if (k < now - this.baseline - 10) this.counts.delete(k);
    let score = 0;
    if (vals.length >= this.warmup) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      const z = (mps - mean) / Math.max(sd, Math.sqrt(mean) * 0.8, 0.5);
      const hypeFrac = n3 ? h3 / n3 : 0; const strongFrac = n3 ? st3 / n3 : 0;
      score = z * (1 + 0.8 * hypeFrac + 1.2 * strongFrac);
      const floor = Math.max(this.minRate, mean * 2.5);
      if (mps < floor) score = Math.min(score, 0);
      this.busy = get(now).n >= floor;
    }
    const thr = thresholdFor(this.sensitivity);
    this.recent.push(score >= thr && this.busy); if (this.recent.length > this.sustain + 1) this.recent.shift();
    const held = this.recent.filter(Boolean).length >= this.sustain;
    let spike = false;
    if (held) {
      if (!this.inBurst && now - this.lastSpike >= this.cooldown) { spike = true; this.lastSpike = now; this.peak = 0; }
      this.inBurst = true;
    } else if (score < thr * 0.5) this.inBurst = false;
    if (this.inBurst) this.peak = Math.max(this.peak, score);
    return { t: spike ? now - (this.sustain - 1) : now, score: +score.toFixed(2), mps: +mps.toFixed(2), hype: n3 ? +(h3 / n3).toFixed(2) : 0, spike, threshold: +thr.toFixed(2) };
  }
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const EXCITED = /^(what|no|wait|bro|dude|yo|oh|omg|wow|holy|insane|crazy|run|go|yes|nah|stop|help|dead|lets|let's|fuck|shit|damn)$/i;

export type Word = { w: string; s: number; e: number };

// Virality score (0-100) for a finished clip.
export function viralityScore(clip: { start: number; end: number; words?: Word[]; reason?: any; motionPeak?: number }): { score: number; parts: Record<string, number> } {
  const dur = Math.max(1, (clip.end || 0) - (clip.start || 0));
  const words = (clip.words || []).filter((w) => w.s >= clip.start && w.s <= clip.end);
  const r = clip.reason || {};
  const spike = r.kind === 'chat' ? clamp((Number(r.score) - 1.5) / 6) : clamp((Number(r.score) - 1) / 4) * 0.8;
  const hype = r.hype != null ? clamp(r.hype / 0.5) : 0.3;
  let ex = 0;
  for (const w of words) {
    const bare = w.w.replace(/[^\w']/g, '');
    if (/[!?]$/.test(w.w)) ex += 1;
    if (EXCITED.test(bare)) ex += 0.6;
    if (bare.length > 2 && bare === bare.toUpperCase() && /[A-Z]/.test(bare)) ex += 0.5;
    if (isHype(bare)) ex += 0.4;
  }
  const excite = clamp(ex / (dur * 0.35));
  const first = words.find((w) => w.s >= clip.start);
  const firstAt = first ? first.s - clip.start : dur;
  const early = words.filter((w) => w.s - clip.start < 5);
  const hook = clamp(1 - firstAt / 4) * 0.6 + clamp(early.filter((w) => /[!?]$/.test(w.w) || EXCITED.test(w.w.replace(/[^\w']/g, ''))).length / 2) * 0.4;
  const talk = clamp((words.length / dur) / 2.2);
  const motion = clip.motionPeak != null ? clamp(clip.motionPeak / 22) : 0.5;
  const length = dur < 10 ? dur / 10 : dur <= 35 ? 1 : clamp(1 - (dur - 35) / 30);
  const parts = { spike, hype, excite, hook, talk, motion, length };
  const W = { spike: 0.3, hype: 0.08, excite: 0.17, hook: 0.15, talk: 0.1, motion: 0.1, length: 0.1 } as Record<string, number>;
  let score = Object.entries(W).reduce((a, [k, w]) => a + w * parts[k], 0) * 100;
  score = Math.round(Math.max(1, Math.min(99, 12 + score * 0.95)));
  return { score, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, +v.toFixed(2)])) };
}

// Local (free) title writer: punchy title, hook line and posting caption from the
// transcript + the loudest chat words, without any paid API.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for', 'is', 'it', 'that', 'this', 'was', 'be', 'are', 'you', 'i']);

export function writeClipText({ transcript, chat, channel }: { transcript?: string; chat?: string[]; channel?: string }): { title: string; hook: string; caption: string } {
  const words = String(transcript || '').split(/\s+/).filter(Boolean);
  // take the punchiest 8-12 word span: score each word by excitement, window by sum
  let best = words.slice(0, 10).join(' ');
  if (words.length) {
    let bi = 0, bs = -1;
    for (let i = 0; i < Math.max(1, words.length - 8); i++) {
      let s = 0;
      for (let j = i; j < Math.min(words.length, i + 10); j++) {
        const b = words[j].replace(/[^\w']/g, '');
        if (EXCITED.test(b)) s += 3;
        if (/[!?]/.test(words[j])) s += 2;
        if (isHype(b)) s += 2;
      }
      if (s > bs) { bs = s; bi = i; }
    }
    best = words.slice(bi, bi + 10).join(' ').replace(/[^\w'!? ]/g, '').trim() || best;
  }
  const top = new Map<string, number>();
  for (const m of chat || []) {
    for (const w of String(m).toLowerCase().split(/\s+/)) {
      const b = w.replace(/[^\w]/g, '');
      if (b.length < 3 || STOP.has(b) || /^\d+$/.test(b)) continue;
      top.set(b, (top.get(b) || 0) + 1);
    }
  }
  const hot = [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  const hypeTag = hot.length ? ` (${hot.join(' ')})` : '';
  const title = (best.split(/\s+/).slice(0, 9).join(' ') + hypeTag).toUpperCase().slice(0, 80) || 'THIS MOMENT WENT OFF';
  const hook = hot.length ? `Chat said ${hot.join(', ')} — watch this.` : 'Chat lost it at this moment.';
  const caption = `${title.toLowerCase()} ${hypeTag.trim() || ''}\n\n#${(channel || 'stream').replace(/[^a-z0-9]/gi, '')} #clips #shorts`.trim();
  return { title, hook, caption };
}
