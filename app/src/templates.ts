// Edit templates: one-click viral edit styles applied on top of the layout.
// Each template = extra ffmpeg filter stages + caption defaults, tuned after
// studying viral clip edits (hook-title story clips, reaction duo clips with
// colored keyword captions, shake/zoom beat hits, glitch flickers, cinematic
// letterbox grades).
export type TemplateId = 'none' | 'hook' | 'speed' | 'punch' | 'shake' | 'glitch' | 'cine';

export type TemplateDef = {
  id: TemplateId;
  label: string;
  desc: string;
  accent: string;
  caption?: Partial<{ preset: string; size: number; position: number; uppercase: boolean; wordsPerLine: number; highlight: string }>;
};

export const TEMPLATES: TemplateDef[] = [
  { id: 'none', label: 'Clean', desc: 'No extra edit', accent: '#9a9aa0' },
  { id: 'hook', label: 'Hook Story', desc: 'Title burned on top + CTA bar', accent: '#ffd84d', caption: { preset: 'pop', position: 0.82, size: 78 } },
  { id: 'speed', label: 'Reaction', desc: 'Game on top, you below, keyword captions', accent: '#38bdf8', caption: { preset: 'karaoke', position: 0.3, size: 96, highlight: '#38bdf8' } },
  { id: 'punch', label: 'Punch Zoom', desc: 'Quick zoom-in on the loud words', accent: '#f97316', caption: { preset: 'pop' } },
  { id: 'shake', label: 'Shake', desc: 'Camera shake on the big beats', accent: '#ef4444', caption: { preset: 'pop' } },
  { id: 'glitch', label: 'Glitch', desc: 'RGB glitch flicker on the beats', accent: '#a78bfa', caption: { preset: 'pop' } },
  { id: 'cine', label: 'Cinematic', desc: 'Letterbox bars + film grade', accent: '#94a3b8', caption: { preset: 'clean', uppercase: false } },
];

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\\\\\'").replace(/:/g, '\\\\:').replace(/%/g, '\\%');

// Beats: times (seconds into the clip) where something strong happens — used by
// shake/glitch/punch. From word timestamps; the caller passes them in.
export type TplCtx = {
  dur: number;
  beats: number[]; // seconds into clip
  hook: string; // short punchy line for the hook template
  accent: string; // hex like #ffd84d
  channel: string;
};

const hexToFf = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  return m ? `0x${m[1].slice(4, 6)}${m[1].slice(2, 4)}${m[1].slice(0, 2)}` : '0xffffd8';
};

// gate expression: 1 during any beat (+pad seconds), else 0
function beatGate(beats: number[], pad = 0.4): string {
  if (!beats.length) return '0';
  return beats.map((t) => `between(t,${Math.max(0, t - 0.05).toFixed(2)},${(t + pad).toFixed(2)})`).join('+');
}

// wrap hook text into lines of at most ~20 chars for the top title
function wrapHook(text: string, maxChars = 20): string[] {
  const words = String(text || '').toUpperCase().replace(/[—-]\s*$/, '').split(/\s+/).filter(Boolean).slice(0, 10);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 2);
}

// Returns extra filter_complex stages, chained from [in] to [out].
export function templateStages(id: TemplateId, ctx: TplCtx): Array<[string, string, string]> {
  const stages: Array<[string, string, string]> = []; // [filter, inLabel, outLabel]
  const accent = hexToFf(ctx.accent);
  const gate = beatGate(ctx.beats);

  if (id === 'hook') {
    // Title burned across the top, one emphasised word in the accent colour is
    // too fiddly in drawtext; whole title in bold white with a heavy shadow reads right.
    const lines = wrapHook(ctx.hook);
    const startY = 60; const size = 58;
    lines.forEach((ln, i) => {
      stages.push([
        `drawtext=fontfile='${esc(FONT)}':text='${esc(ln)}':fontsize=${size}:fontcolor=white:borderw=5:bordercolor=black:shadowx=0:shadowy=6:shadowcolor=black@0.7:x=(w-text_w)/2:y=${startY + i * (size + 14)}`,
        'in', `h${i}`,
      ]);
    });
    let last = lines.length ? `h${lines.length - 1}` : 'in';
    // bottom CTA bar: "FOLLOW ${channel}" with an accent underline
    const cta = `FOLLOW ${ctx.channel}`.slice(0, 24).toUpperCase();
    stages.push([
      `drawtext=fontfile='${esc(FONT)}':text='${esc(cta)}':fontsize=44:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-220`,
      last, 'c1',
    ]);
    stages.push([
      `drawbox=x=(iw-(tw*3))/2:y=h-160:w=tw*3:h=8:color=${accent}@0.95:t=fill`,
      'c1', 'out',
    ]);
    // drawbox tw isn't per-drawtext; use a fixed-width bar under the CTA instead
    stages.pop();
    stages.push([
      `drawbox=x=290:y=h-168:w=${1080 - 580}:h=8:color=${accent}@0.95:t=fill`,
      'c1', 'out',
    ]);
    return stages;
  }

  if (id === 'speed') {
    // progress bar growing across the bottom + slight permanent zoom (Ken Burns feel comes from the layout crop)
    stages.push([
      `drawbox=x=0:y=ih-10:w='iw*min(1,t/${Math.max(1, ctx.dur)})':h=10:color=${accent}@0.9:t=fill`,
      'in', 'out',
    ]);
    return stages;
  }

  if (id === 'shake') {
    // zoom in a touch, jitter x/y during beats
    const sx = `iw/1.06`; const sy = `ih/1.06`;
    const jx = `(iw-(${sx}))/2 + 14*sin(t*47)*(${gate})`;
    const jy = `(ih-(${sy}))/2 + 10*sin(t*61+2)*(${gate})`;
    stages.push([
      `crop=${sx}:${sy}:${jx}:${jy}`,
      'in', 'out',
    ]);
    return stages;
  }

  if (id === 'glitch') {
    // rgb channel split flicker + slight hue strobe during beats
    stages.push([
      `rgbashift=rh='8*(${gate})':gh='-6*(${gate})':bh='8*(${gate})':rv='3*(${gate})':bv='-3*(${gate})'`,
      'in', 'g1',
    ]);
    stages.push([
      `hue=s='1+0.7*(${gate})'`,
      'g1', 'out',
    ]);
    return stages;
  }

  if (id === 'cine') {
    const barH = Math.round(1920 * 0.07);
    stages.push([
      `drawbox=x=0:y=0:w=iw:h=${barH}:color=black:t=fill,drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:color=black:t=fill`,
      'in', 'c1',
    ]);
    stages.push([
      `eq=contrast=1.08:saturation=0.88,vignette=PI/5`,
      'c1', 'out',
    ]);
    return stages;
  }

  return stages;
}

// caption defaults a template wants (the editor can still override)
export function templateCaptions(id: TemplateId): TemplateDef['caption'] {
  return TEMPLATES.find((t) => t.id === id)?.caption || undefined;
}

// the accent colour a template uses for captions
export function templateAccent(id: TemplateId): string {
  return TEMPLATES.find((t) => t.id === id)?.accent || '#ffd84d';
}
