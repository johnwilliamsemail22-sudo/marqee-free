# Marqee Clip v0.1.6 internals (from app.asar, unminified source)

Verified architecture of the real app:
- Electron; main process modules: detect/{spikes,chatlog,virality}, media/{ffmpeg,layouts,render,captions,whisper,voice,analysis}, modes/{live,filemode}, jobs, platforms, licence, store
- Ingest: yt-dlp resolves stream URL; ffmpeg records 2s mpegts segments into rolling 240s buffer; CSV segment list tracks stream-time->wall-time via running median offset
- Recorder runs under guard.js (leash via stdin pipe so it dies with the app)
- Auto-reconnect (20 tries, backoff 3s->15s); YouTube sends video/audio separately (2 inputs, -copyts -map merge)
- Chat: Twitch = anonymous IRC websocket (justinfan nick, tags CAP); Kick = poll chatroom history API 1.2s; YouTube = innertube live_chat get_live_chat continuation polling
- Spike detection: msgs/sec over 3s window vs rolling 180s baseline z-score (sd floor max(sd, sqrt(mean)*0.8, 0.5)); boosted 1+0.8*hypeFrac+1.2*strongFrac; floor mps>=max(1.5, mean*2.5); threshold 8.5-4.5*sensitivity (default 0.3 -> 7.15); must sustain 3 of last 4 seconds; cooldown 60s; spike timestamp = start of burst not confirmation
- Hype words list (lol kekw pog clip it wtf...), strong reactions (clip it, no way, kekw, omegalul, !!!, caps, spammed chars)
- Clip cut: pre-roll before spike moment, end snapped to speech pauses (VAD), window padded 30s for editing
- Virality score 0-100: weighted parts {spike .30, hype .08, excite .17, hook .15, talk .10, motion .10, length .10}, -12 if music detected, rescale 12+score*0.95
- Excitement from words: !?, excited interjections (what no bro omg...), ALLCAPS, hype words
- Hook: how fast speech starts (<4s) + punchy words in first 5s
- Length sweet spot 10-35s
- Whisper.cpp local STT (models: tiny/base/small/medium from HF ggml-org) + silero VAD v5.1.2, word timestamps
- Voice check: sherpa-onnx 3dspeaker speaker embedding - verifies only streamer talks in the cam crop
- Facecam: @mediapipe tasks-vision FaceDetector in renderer; editable box; default cam box x .72 y .62 w .26 h .34
- Layouts (1080x1920): facecam (cam top split .38, sharpened unsharp 5:5:0.7), split .5, face (vertical slice on face), center (crop follows action via focus track, pans away from cam), blur (boxblur bg), pip (retired)
- Focus track = periodic motion scoring; panX step-function keeps crop off the facecam box (+9% margin)
- Camera crop min 490x330 to avoid upscaling blur
- Captions: ASS subtitles, word-level karaoke, presets pop/clean, Inter Black, color #FFF highlight #FFD84D, size 86, pos 70%, 3 words/line, uppercase, outline size/14
- Covers: canvas-drawn 1080x1920, frame grab at spike moment, styles bold/yellow/glow/outline, hook text auto-sized from 150px, safe zones, reaction box with rotation/tilt variants, deterministic rng per variant id
- Titles: transcript (<=4000 chars) + 40 chat lines sent to marqee.studio /api/ai/clip-text (Claude via their Worker) -> title, hook, posting caption. judge-moment endpoint re-scores with AI, max 8/hour, only for paying users
- Music detection lowers score; export = video + cover + txt (title/hook/caption)
- Licence: key check against marqee.studio API, Polar payments
- File mode: VOD/OBS input, same pipeline offline; chat log parsers for TwitchDownloader JSON, yt-dlp rechat, YouTube live_chat JSONL, timestamped text
