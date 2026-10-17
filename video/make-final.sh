#!/usr/bin/env bash
# Builds the final Stall demo: your talking-head take + b-roll inserts + burned subtitles.
# Usage: ./make-final.sh my-face.mp4
# Edit cuts.txt to change when each b-roll clip covers your face.
set -euo pipefail
cd "$(dirname "$0")"
FACE="${1:?usage: ./make-final.sh <your-face-video>}"
OUT="stall-demo-final.mp4"
mkdir -p build

# 1) Normalize your take to 1920x1080, 30fps (crops/pads phone footage, keeps audio).
ffmpeg -y -loglevel error -i "$FACE" \
  -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,setsar=1" \
  -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k -ar 48000 build/face.mp4

# 2) Overlay each b-roll clip on top of your face at the times in cuts.txt.
#    Your voice keeps playing underneath, so the b-roll illustrates what you're saying.
#    cuts.txt line format: <clip-file> <start-seconds-in-your-video>
inputs=(-i build/face.mp4)
filter=""
last="[0:v]"
n=1
while read -r clip at; do
  [[ -z "${clip:-}" || "$clip" == \#* ]] && continue
  inputs+=(-itsoffset "$at" -i "clips/$clip")
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "clips/$clip")
  end=$(awk "BEGIN{print $at+$dur}")
  filter+="${last}[$n:v]overlay=enable='between(t,$at,$end)':eof_action=pass[v$n];"
  last="[v$n]"
  n=$((n+1))
done < cuts.txt

# 3) Optional burned subtitles from captions.srt (generate with whisper, see README).
sub=""
if [[ -f captions.srt ]]; then
  sub=",subtitles=captions.srt:force_style='FontName=Montserrat,Fontsize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00241B16,Outline=3,Shadow=0,MarginV=60'"
fi
filter+="${last}null${sub}[vout]"

ffmpeg -y -loglevel error "${inputs[@]}" -filter_complex "$filter" \
  -map "[vout]" -map 0:a -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart "$OUT"
echo "Done: $(pwd)/$OUT"
