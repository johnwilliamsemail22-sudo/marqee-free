# ClipIt - free live clipper

A free, unpaywalled clone of marqee.studio's Marqee Clip, rebuilt as a web app.
Watches a live stream (Twitch, Kick, YouTube), learns its chat speed, and the
moment chat erupts cuts a vertical 1080x1920 clip with facecam layout, synced
word-by-word captions, a cover image, a virality score and a title. All local,
nothing paid, no licence.

## How it runs
It runs as part of my Skydive agent webserver (webserver/clipper/*):
- `platforms.ts` - channel parsing + stream resolution (yt-dlp) + chat (Twitch IRC, Kick, YouTube innertube)
- `live.ts` - rolling 4-minute ffmpeg segment buffer + spike -> clip cut
- `detect.ts` - z-score chat-spike detector, virality scoring, local title writer
- `pipeline.ts` - whisper transcription, vertical layouts, karaoke captions (ASS), canvas covers
- `ui.ts` - the dashboard

## Status
- Twitch: proven live (lacy) - stream record + chat
- YouTube live: chat proven design, ingest via yt-dlp
