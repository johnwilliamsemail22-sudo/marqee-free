// Live platforms: Twitch, Kick and YouTube Live. For each: read a channel from
// what the user pastes, find the stream to record, read chat (public, no account),
// and tell whether the channel is live.
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const H: Record<string, string> = { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US,en;q=0.9' };
const KH: Record<string, string> = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Parsed = { platform: string; channel: string; url: string; label: string; video?: string };

export function parse(platform: string | undefined, input: string): Parsed | null {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/twitch\.tv\//i.test(s)) platform = 'twitch';
  else if (/kick\.com\//i.test(s)) platform = 'kick';
  else if (/youtube\.com\/|youtu\.be\//i.test(s)) platform = 'youtube';
  platform = platform || 'twitch';
  if (platform === 'twitch') {
    const m = /twitch\.tv\/([A-Za-z0-9_]{2,25})/i.exec(s);
    const name = (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
    return /^[a-z0-9_]{2,25}$/.test(name) ? { platform, channel: name, url: `https://www.twitch.tv/${name}`, label: `twitch.tv/${name}` } : null;
  }
  if (platform === 'kick') {
    const m = /kick\.com\/([A-Za-z0-9_-]{2,30})/i.exec(s);
    const name = (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
    return /^[a-z0-9_-]{2,30}$/.test(name) ? { platform, channel: name, url: `https://kick.com/${name}`, label: `kick.com/${name}` } : null;
  }
  if (platform === 'youtube') {
    let m = /(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})(?![\w-])/.exec(s);
    if (m) return { platform, channel: m[1], video: m[1], url: `https://www.youtube.com/watch?v=${m[1]}`, label: `youtube.com/watch?v=${m[1]}` };
    m = /youtube\.com\/(@[\w.-]{3,30}|channel\/UC[\w-]{22}|c\/[\w.-]+|user\/[\w.-]+)/i.exec(s);
    const handle = m ? m[1] : (/^@?[\w.-]{3,30}$/.test(s) ? `@${s.replace(/^@/, '')}` : null);
    if (!handle) return null;
    return { platform, channel: handle.replace(/^channel\//, ''), url: `https://www.youtube.com/${handle}/live`, label: `youtube.com/${handle}` };
  }
  return null;
}

// yt-dlp with the sandbox TLS quirk handled; resolves to { inputs: [url] } or
// { inputs: [videoUrl, audioUrl] } (YouTube Live serves picture and sound apart).
function ytdlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('yt-dlp', ['--no-check-certificates', '--no-warnings', '--no-playlist', ...args], { windowsHide: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(err.split('\n').filter(Boolean).pop() || 'unknown error'), { stderr: err }))));
  });
}

async function kickChannel(name: string): Promise<any> {
  const r = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(name)}`, { headers: KH });
  if (r.status === 404) throw new Error(`${name} was not found on Kick.`);
  if (!r.ok) throw new Error(`Kick did not answer (${r.status}).`);
  return r.json();
}

export async function resolveStream(ch: Parsed): Promise<{ inputs: string[] }> {
  const offline = () => new Error(`${ch.channel} is not live right now.`);
  if (ch.platform === 'kick') {
    const j = await kickChannel(ch.channel);
    if (!j.livestream || !j.playback_url) throw offline();
    return { inputs: [j.playback_url] };
  }
  const fmt = 'bv*[height<=1080]+ba/b[height<=1080]/b';
  try {
    const out = await ytdlp(['-g', '-f', fmt, ch.url]);
    const urls = out.trim().split(/\r?\n/).filter((l) => l.startsWith('http'));
    if (!urls.length) throw offline();
    // Twitch and YouTube both serve picture and sound apart at source quality: two inputs
    // (video, audio) that the recorder merges with -copyts. One input = already muxed.
    return { inputs: urls.slice(0, 2) };
  } catch (e: any) {
    if (/not currently live|offline|does not exist|not live|will begin|Premieres|no video formats/i.test(`${e.message} ${e.stderr || ''}`)) throw offline();
    throw new Error(`Could not open the stream: ${e.message}`);
  }
}

export type ChatMsg = { t: number; user: string; text: string };
type OnMessage = (m: ChatMsg) => void;
type OnStatus = (s: string) => void;

export class TwitchChat {
  ws: any; closed = false; retry = 0;
  ch: Parsed; onMessage: OnMessage; onStatus: OnStatus;
  constructor(ch: Parsed, onMessage: OnMessage, onStatus: OnStatus) { this.ch = ch; this.onMessage = onMessage; this.onStatus = onStatus; this.connect(); }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443') as any;
    this.ws = ws;
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags');
      ws.send('PASS SCHMOOPIIE');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
      ws.send(`JOIN #${this.ch.channel}`);
    });
    ws.on('message', (data: any) => {
      for (const line of String(data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        if (/ 366 /.test(line) || / JOIN #/.test(line)) { this.retry = 0; this.onStatus('connected'); }
        const m = /(?:^@(\S+) )?:(\w+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(line);
        if (m) this.onMessage({ t: Date.now() / 1000, user: m[2], text: m[3] });
      }
    });
    ws.on('close', () => {
      if (this.closed) return;
      this.onStatus('reconnecting');
      setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** this.retry++));
    });
    ws.on('error', () => {});
  }
  close() { this.closed = true; try { this.ws?.close(); } catch { /* gone */ } }
}

// Polls a source of recent messages; each message is passed on once (by id).
class PollChat {
  closed = false; seen = new Set<string>(); order: string[] = []; fails = 0; primed = false;
  onMessage: OnMessage; onStatus: OnStatus;
  constructor(onMessage: OnMessage, onStatus: OnStatus) { this.onMessage = onMessage; this.onStatus = onStatus; }
  take(list: Array<{ id: string; t: number; user: string; text: string }>) {
    const fresh = list.filter((m) => m.id && !this.seen.has(m.id)).sort((a, b) => a.t - b.t);
    for (const m of fresh) {
      this.seen.add(m.id); this.order.push(m.id);
      if (this.order.length > 5000) this.seen.delete(this.order.shift());
      if (this.primed) this.onMessage({ t: Math.min(Date.now() / 1000, m.t), user: m.user, text: m.text });
    }
    this.primed = true;
  }
  async loop(fetchOnce: () => Promise<{ messages: Array<{ id: string; t: number; user: string; text: string }>; wait?: number }>, every: number) {
    while (!this.closed) {
      try { const r = await fetchOnce(); this.take(r.messages); this.fails = 0; this.onStatus('connected'); await wait(r.wait ?? every); }
      catch { this.fails++; this.onStatus('reconnecting'); await wait(Math.min(30000, 1000 * 2 ** this.fails)); }
    }
  }
  close() { this.closed = true; }
}

class KickChat extends PollChat {
  constructor(ch: Parsed, onMessage: OnMessage, onStatus: OnStatus) {
    super(onMessage, onStatus);
    (async () => {
      let room: string | null = null;
      while (!this.closed && !room) { try { room = (await kickChannel(ch.channel))?.chatroom?.id; } catch { await wait(5000); } }
      this.loop(async () => {
        const r = await fetch(`https://web.kick.com/api/v1/chat/${room}/history`, { headers: KH });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        return { messages: (j.data?.messages || []).map((m: any) => ({ id: String(m.id), t: Date.parse(m.created_at) / 1000 || Date.now() / 1000, user: m.sender?.username || '', text: String(m.content || '').replace(/\[emote:\d+:([^\]]+)\]/g, '$1') })) };
      }, 1200);
    })();
  }
}

class YouTubeChat extends PollChat {
  constructor(ch: Parsed, onMessage: OnMessage, onStatus: OnStatus) {
    super(onMessage, onStatus);
    (async () => {
      let video = ch.video; let key: string; let ver: string; let cont: string;
      while (!this.closed && !cont) {
        try {
          if (!video) video = await youtubeLiveVideo(ch);
          const page = await (await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${video}`, { headers: { ...H, accept: 'text/html' } })).text();
          key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(page) || [])[1];
          ver = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(page) || [])[1];
          cont = (/"continuation":"([^"]+)"/.exec(page) || [])[1];
          if (!cont) throw new Error('no chat');
        } catch { video = ch.video; this.onStatus('reconnecting'); await wait(10000); }
      }
      this.loop(async () => {
        const r = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`, {
          method: 'POST', headers: { ...H, 'content-type': 'application/json' },
          body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver } }, continuation: cont }),
        });
        if (!r.ok) throw new Error(String(r.status));
        const lc = (await r.json()).continuationContents?.liveChatContinuation;
        const c = lc?.continuations?.[0]; const next = c?.invalidationContinuationData || c?.timedContinuationData || c?.reloadContinuationData;
        if (next?.continuation) cont = next.continuation;
        const messages = (lc?.actions || []).map((a: any) => a.addChatItemAction?.item?.liveChatTextMessageRenderer).filter(Boolean).map((m: any) => ({
          id: m.id, t: Number(m.timestampUsec) / 1e6 || Date.now() / 1000, user: m.authorName?.simpleText || '',
          text: (m.message?.runs || []).map((x: any) => x.text || x.emoji?.shortcuts?.[0] || '').join(''),
        }));
        return { messages, wait: Math.max(1000, Math.min(next?.timeoutMs || 3000, 5000)) };
      }, 3000);
    })();
  }
}

export function openChat(ch: Parsed, onMessage: OnMessage, onStatus: OnStatus): { close: () => void } {
  if (ch.platform === 'kick') return new KickChat(ch, onMessage, onStatus);
  if (ch.platform === 'youtube') return new YouTubeChat(ch, onMessage, onStatus);
  return new TwitchChat(ch, onMessage, onStatus);
}

async function youtubeLiveVideo(ch: Parsed): Promise<string | null> {
  const html = await (await fetch(ch.url, { headers: { ...H, accept: 'text/html' } })).text();
  if (!/"isLiveNow":true|"isLive":true/.test(html)) return null;
  const canon = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html);
  return canon ? canon[1] : (/"videoId":"([\w-]{11})"/.exec(html) || [])[1] || null;
}

export async function isLive(ch: Parsed): Promise<boolean | null> {
  try {
    if (ch.platform === 'kick') return !!(await kickChannel(ch.channel)).livestream;
    if (ch.platform === 'youtube') return !!(await youtubeLiveVideo(ch));
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers: { 'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'content-type': 'application/json', 'user-agent': UA },
      body: JSON.stringify({ query: `query { user(login: ${JSON.stringify(ch.channel)}) { stream { id } } }` }),
    });
    const j = await r.json();
    return !!j.data?.user?.stream;
  } catch { return null; }
}

export const PLATFORMS = ['twitch', 'kick', 'youtube'];
