# Marqee Clip - full teardown (source: marqee.studio + installed app v0.1.6)

## Product
Windows Electron app (v0.1.6, NSIS installer, 241MB) that clips live streams
when chat "goes wild", outputs vertical 1080x1920 clips ready for TikTok/Shorts/Reels.
Paid: Pro $12.99/mo (1 stream), Studio $29/mo (4 streams). Polar payments.

## Architecture (verified from app.asar)
- Electron shell, app.asar 47MB (bundled JS/React UI + main process)
- Bundled binaries:
  - yt-dlp.exe -> live stream / VOD ingest (hls/dash/rtmp)
  - whisper-cli.exe + whisper.dll -> LOCAL speech-to-text for word-by-word captions
  - sherpa-onnx-node -> onnx models (resources/models) - face detection / VAD
  - fonts/ -> caption + cover typography
- Privacy claim: video never leaves the PC; only transcript text sent (to LLM for titles)

## Core pipeline
1. Paste channel URL, press Start -> yt-dlp records rolling short buffer + reads chat
2. Learns normal chat rate; when chat spikes (e.g. 5.1x) -> cut from just before moment to natural pause
3. Facecam auto-detect (sherpa-onnx) -> stacked over gameplay; movable box
4. Whisper word-level timestamps -> synced word-by-word captions, selectable styles
5. Cover generator with hook text, shuffleable styles
6. Clip scoring -> post best first
7. AI title + hook + posting caption per clip
8. One-click export video + cover + title.txt

## Feature parity target (free clone)
- [ ] multi-stream monitor (site caps at 4; we go unlimited)
- [ ] chat-spike detection (Twitch IRC + YouTube live chat)
- [ ] auto-clip cut windows (pre-roll buffer, natural pause end)
- [ ] facecam detection + stacking layout (also center-crop, blurred-fit)
- [ ] word-synced captions, multiple styles
- [ ] cover generation w/ hook text
- [ ] clip scoring
- [ ] AI titles
- [ ] file mode (VOD / OBS recordings)
- [ ] NO PAYWALL, all free

## Known gaps we must beat
- Twitch has native clipping (top comment on the reel!) -> our edge: auto, vertical, captioned, covers, scoring, multi-stream, YouTube support
