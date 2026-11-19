#!/usr/bin/env python3
# Find the streamer's camera box in a stream frame: a face detector searched in
# tiles (so small webcam faces are found), then the face turned into a
# head-and-shoulders crop box in fractions of the frame.
# usage: facecam.py <video> [at_seconds...]  -> {"cam":{x,y,w,h}|null, "faces":[...]}
import json, sys
import cv2

W, H = 640, 360

def main():
    video = sys.argv[1]
    ats = [float(a) for a in sys.argv[2:]] or [1, 5, 10]
    cap = cv2.VideoCapture(video)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
    found = []  # (score, fx, fy, fw, fh) in fraction coords
    for at in ats:
        cap.set(cv2.CAP_PROP_POS_MSEC, at * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        fw, fh0 = frame.shape[1], frame.shape[0]
        for det, w in ((cascade, 1.1), (profile, 1.05)):
            faces = det.detectMultiScale(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), scaleFactor=w, minNeighbors=5, minSize=(int(fw*0.04), int(fw*0.04)))
            for (x, y, ww, hh) in faces:
                found.append((ww / fw, x / fw, y / fh0, ww / fw, hh / fh0))
    cap.release()
    if not found:
        print(json.dumps({"cam": None, "faces": []}))
        return
    # the biggest, most repeated face wins
    found.sort(key=lambda f: -f[0])
    best = found[0]
    score, fx, fy, fw, fh = best
    # head-and-shoulders box: about 3x wider and 4x taller than the face, eyes in the upper part
    cx, cy = fx + fw / 2, fy + fh / 2
    bw = min(0.5, fw * 3.2)
    bh = min(0.6, fh * 4.4)
    x = max(0, min(1 - bw, cx - bw / 2))
    y = max(0, min(1 - bh, cy - bh * 0.42))
    print(json.dumps({"cam": {"x": round(x, 3), "y": round(y, 3), "w": round(bw, 3), "h": round(bh, 3)}, "faces": [round(f[0], 3) for f in found[:5]]}))

main()
