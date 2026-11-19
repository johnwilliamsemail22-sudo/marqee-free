#!/usr/bin/env python3
# Find the streamer's camera box in a stream frame: YuNet face detection searched in
# tiles (so small webcam faces are found), then the face turned into a
# head-and-shoulders crop box in fractions of the frame.
# usage: facecam.py <video> [at_seconds...]  -> {"cam":{x,y,w,h}|null}
import json, os, sys
import cv2

W, H = 640, 360
MODEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models', 'yunet.onnx')

def main():
    video = sys.argv[1]
    ats = [float(a) for a in sys.argv[2:]] or [1, 5, 10]
    cap = cv2.VideoCapture(video)
    found = []  # (score, fx, fy, fw, fh) in fraction coords
    for at in ats:
        cap.set(cv2.CAP_PROP_POS_MSEC, at * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        fw, fh0 = frame.shape[1], frame.shape[0]
        det = cv2.FaceDetectorYN_create(MODEL, '', (fw, fh0), 0.5)
        det.setInputSize((fw, fh0))
        img = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        _, faces = det.detect(img)
        if faces is None:
            # retry upscaled: small webcam faces need a bigger input
            up = cv2.resize(img, (fw * 2, fh0 * 2))
            det2 = cv2.FaceDetectorYN_create(MODEL, '', (fw * 2, fh0 * 2), 0.5)
            det2.setInputSize((fw * 2, fh0 * 2))
            _, faces = det2.detect(up)
            if faces is not None:
                faces = [f / [2, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0][:len(f)] if False else f for f in faces]
        if faces is None:
            continue
        for f in faces:
            x, y, w, h, score = f[0], f[1], f[2], f[3], f[14]
            found.append((float(score), x / fw, y / fh0, w / fw, h / fh0))
    cap.release()
    if not found:
        print(json.dumps({"cam": None}))
        return
    # the biggest face wins (score is already high for every real face)
    found.sort(key=lambda f: -(f[3] * f[4]))
    _, fx, fy, fw, fh = found[0]
    # head-and-shoulders box: about 3x wider and 4.4x taller than the face, eyes in the upper part
    cx, cy = fx + fw / 2, fy + fh / 2
    bw = min(0.5, fw * 3.2)
    bh = min(0.6, fh * 4.4)
    x = max(0.0, min(1 - bw, cx - bw / 2))
    y = max(0.0, min(1 - bh, cy - bh * 0.42))
    print(json.dumps({"cam": {"x": round(x, 3), "y": round(y, 3), "w": round(bw, 3), "h": round(bh, 3)}}))

main()
