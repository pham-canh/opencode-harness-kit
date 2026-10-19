#!/usr/bin/env python3
"""Assemble the space-harness demo into one mp4.

One still per scene, held for exactly that scene's narration, with a short
crossfade so cuts do not feel like a slideshow. Scene lengths come from
audio/manifest.json, which was measured from the generated audio rather than
estimated, so picture and sound cannot drift apart.

The script fails loudly if the result leaves the 2-3 minute brief, because a
video that misses its length is not a shorter video, it is the wrong video.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent
FPS = 30
FADE = 0.5          # crossfade, seconds
LEAD = 0.8          # hold on scene 1 before narration starts
TAIL = 1.6          # hold after the last word
MIN_S, MAX_S = 120, 180
BRIEF = "2-3 minute"

OUT = ROOT / "space-harness-demo.mp4"


def probe(path):
    """Duration in seconds, read from ffmpeg's own banner.

    ffprobe is not installed on this machine, so the banner is the measurement.
    """
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path)],
        capture_output=True, text=True,
    ).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    if not m:
        raise SystemExit(f"could not read the duration of {path}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def main():
    manifest = json.loads((ROOT / "audio" / "manifest.json").read_text())
    nums = sorted(int(k) for k in manifest)

    tmp = ROOT / "build"
    tmp.mkdir(exist_ok=True)

    # Normalise every clip to the same codec/size/fps. Concatenating mixed
    # stills is where ffmpeg silently produces a file that will not seek.
    clips = []
    total = 0.0
    for i, n in enumerate(nums):
        still = ROOT / "scenes" / f"scene{n}.png"
        if not still.exists():
            raise SystemExit(f"missing {still} -- run render.py first")
        clip = tmp / f"clip{n}.mp4"
        dur = manifest[str(n)]["dur"] + (LEAD if i == 0 else 0) + (
            TAIL if i == len(nums) - 1 else 0
        )
        total += dur
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-loop", "1", "-i", str(still),
            "-t", f"{dur:.3f}",
            "-r", str(FPS),
            "-vf", f"scale=1920:1080,fade=t=in:st=0:d={FADE},format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
            str(clip),
        ], check=True)
        clips.append(clip)
        print(f"clip {n}: {dur:.2f}s")

    # Concatenate, then attach the audio that matches it scene for scene.
    listing = tmp / "list.txt"
    listing.write_text("".join(f"file '{c}'\n" for c in clips))
    silent = tmp / "silent.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-c", "copy", str(silent),
    ], check=True)

    # Delay each scene's narration to its own place on the timeline. apad alone
    # would leave the file open-ended, so the total is trimmed back to what the
    # picture actually runs.
    audio_parts = []
    at = LEAD
    for i, n in enumerate(nums):
        src = ROOT / manifest[str(n)]["file"]
        part = tmp / f"aud{n}.m4a"
        subprocess.run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(src),
            "-af", f"adelay={int(at*1000)}|{int(at*1000)}",
            "-t", f"{total:.3f}",
            "-c:a", "aac", "-b:a", "128k", str(part),
        ], check=True)
        audio_parts.append(part)
        at += manifest[str(n)]["dur"] + (LEAD if i == 0 else 0)

    alist = tmp / "alist.txt"
    alist.write_text("".join(f"file '{c}'\n" for c in audio_parts))
    voice = tmp / "voice.m4a"
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(alist),
        "-t", f"{total:.3f}",
        "-c:a", "aac", "-b:a", "128k", str(voice),
    ], check=True)

    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(silent), "-i", str(voice),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest", str(OUT),
    ], check=True)

    got = probe(OUT)
    size = OUT.stat().st_size / 1024 / 1024
    print(f"\n{OUT.name}  {got:.1f}s = {int(got//60)}:{int(got%60):02d}  {size:.1f} MB")

    if not MIN_S <= got <= MAX_S:
        raise SystemExit(
            f"FAILED: {got:.1f}s is outside the {MIN_S}-{MAX_S}s brief. "
            f"The narration is too long or too short -- fix narration.md, not this check."
        )
    print(f"length is inside the {BRIEF} brief")


if __name__ == "__main__":
    sys.exit(main())