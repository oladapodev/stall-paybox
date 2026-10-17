"""Transcribe the face take into captions.srt (short lines) + words.json (for retiming cuts)."""
import json, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel

src = sys.argv[1]
pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", src, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                     capture_output=True, check=True).stdout
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
model = WhisperModel("small.en", device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio, word_timestamps=True, vad_filter=True)
words = [{"w": w.word.strip(), "s": round(w.start, 2), "e": round(w.end, 2)} for seg in segments for w in seg.words]
json.dump(words, open("words.json", "w"), indent=1)

def ts(t):
    h, r = divmod(t, 3600); m, s = divmod(r, 60)
    return f"{int(h):02}:{int(m):02}:{int(s):02},{int((s % 1) * 1000):03}"

lines, cur = [], []
for w in words:
    cur.append(w)
    if len(cur) >= 5 or w["w"].endswith((".", "?", "!", ",")):
        lines.append(cur); cur = []
if cur: lines.append(cur)
with open("captions.srt", "w") as f:
    for i, l in enumerate(lines, 1):
        f.write(f"{i}\n{ts(l[0]['s'])} --> {ts(l[-1]['e'])}\n{' '.join(x['w'] for x in l)}\n\n")
print(f"{len(words)} words, {len(lines)} caption lines")
