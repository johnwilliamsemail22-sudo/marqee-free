#!/usr/bin/env python3
# Transcribe an audio file to word-level timestamps with faster-whisper (local, free).
import json, sys
from faster_whisper import WhisperModel

def main():
    wav, out_json = sys.argv[1], sys.argv[2]
    model_size = sys.argv[3] if len(sys.argv) > 3 else "base"
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(wav, word_timestamps=True, vad_filter=True, beam_size=1)
    words = []
    text = []
    for seg in segments:
        text.append(seg.text.strip())
        for w in (seg.words or []):
            words.append({"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)})
    json.dump({"words": words, "text": " ".join(text), "language": info.language}, open(out_json, "w"))
    print("ok")

main()
