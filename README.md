# ClipIt

Auto-clip live streams **when chat goes wild** — the moment chat erupts, the clip is already cut, framed vertical, captioned, covered, scored and ready to post. Free and unlimited (no licence, no plan tiers).

Built as an open re-implementation of the Marqee Clip feature set (behaviour studied from the public site and app), rebuilt from scratch. Not affiliated with Marqee, Twitch, Kick, YouTube or any game publisher.

## What it does

- **Live clipping** — paste a Twitch / Kick / YouTube channel or link. It records the stream into a rolling ~4 min buffer (2 s segments on disk) and reads chat anonymously.
- **Chat-spike detection** — messages/sec vs a rolling 180 s baseline (z-score), boosted by hype words ("kekw", "pog", "no way", all-caps, spam) and strong reactions. A clip cuts from just before the moment; small chats are protected from noise by a rate floor; 3-of-4-second sustain + cooldown so one moment = one clip.
- **"Clip that"** — saw the moment yourself? One button cuts it a beat later, no filters.
- **Vertical layouts** (1080×1920): facecam-on-top, 50/50 split, face slice, centre crop, blurred fit. Facecam box auto-detected (YuNet face detection) and editable per clip.
- **Word-by-word captions** — local Whisper (faster-whisper) with word timestamps; presets: pop (one word at a time with scale pop, karaoke highlight), karaoke, clean.
- **Viral-style edits** — punch-zoom beats on the strongest spoken words.
- **Covers** — generated per clip from the best frames with hook text; styles bold / yellow / glow / outline, shuffle for more.
- **Virality score (0–100)** — chat reaction, excitement in speech, hook speed, talk density, length; music detection lowers it.
- **Title, hook and posting caption** written locally from the transcript + hot chat words. No external AI, nothing sent anywhere.
- **Export bundle** — the MP4, cover images and a `post.txt` with title + caption.
- **File mode** — drop in a VOD/OBS recording URL: finds moments by loudness spikes, optionally with a chat log.
- **Unlimited streams** at once, each in its own session.

## Layout

```
app/
  src/
    platforms.ts   Twitch / Kick / YouTube: parse input, resolve stream (yt-dlp), anonymous chat, is-live
    detect.ts      spike detection, virality score, title/hook/caption writer
    live.ts        live session: rolling buffer, chat spike -> pending cuts -> clips, "Clip that"
    pipeline.ts    snapshot -> transcribe -> render (layout + captions + punch-zoom) -> covers -> export
    filemode.ts    VOD/recording analysis (loudness + optional chat log)
    transcribe.py  faster-whisper word-level transcription
    facecam.py     YuNet facecam auto-detection
  web/             the dashboard (vanilla HTML/CSS/JS)
```

Server glue (API routes, session manager, static media) lives in the agent's webserver; the dashboard is served at `/app`.

## API

| Method | Path | What |
| --- | --- | --- |
| GET | `/api/state` | sessions + clips + settings |
| POST | `/api/start` | `{channel, platform?, layout?, sensitivity?}` |
| POST | `/api/stop` | `{sessionId?}` (omit = all) |
| POST | `/api/clip-now` | manual clip |
| POST | `/api/settings` | sensitivity / cooldown / layout |
| GET | `/api/clip/:id` | full clip record incl. words |
| POST | `/api/clip/:id/render` | re-render with layout/cam/caption/trim |
| POST | `/api/clip/:id/cover` | new cover variant |
| POST | `/api/clip/:id/text` | persist title/hook/caption |
| POST | `/api/clip/:id/delete` | delete |
| GET | `/api/facecam/:id` | auto-detected facecam box |
| POST | `/api/file/analyse` | file mode |

## Requirements

Node 24+, ffmpeg, yt-dlp, Python 3 with `faster-whisper` and `opencv-python-headless` (YuNet model included), `@napi-rs/canvas`.

## Notes

- Clip your own streams or streams you have permission to clip (clipping campaigns). Respect each campaign's rules. No earnings guaranteed.
- YouTube Live from datacenter IPs needs signed-in cookies (YouTube bot-checks); Twitch and Kick work anonymously.
