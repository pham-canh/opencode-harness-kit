#!/usr/bin/env python3
"""Turn narration.md into one m4a per scene, plus a manifest of real lengths.

Durations are measured from the generated audio, not estimated from word count.
The picture is then held to exactly these lengths, which is what keeps the
narration from drifting out of sync with the frame it belongs to.

`-f` is the flag that reads a file. Passing the path as a bare argument makes
say treat the filename as the words to speak, which sounds like it works.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent
VOICE = "Reed"      # male, the closest available to the brief on this machine
RATE = 165          # words per minute

SCENE_RE = re.compile(r"## Scene (\d+) · (.+?)\n(.*?)(?=\n##|\Z)", re.S)
DUR_RE = re.compile(r"Duration: (\d+):(\d+):([\d.]+)")


def duration(path):
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path)],
        capture_output=True, text=True,
    ).stderr
    m = DUR_RE.search(err)
    if not m:
        raise SystemExit(f"could not read the duration of {path}")
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def main():
    text = (ROOT / "narration.md").read_text()
    outdir = ROOT / "audio"
    outdir.mkdir(exist_ok=True)

    manifest = {}
    total = 0.0
    for num, title, body in SCENE_RE.findall(text):
        # The narration is prose: drop the markdown scaffolding a writer leaves
        # in the file, not the words.
        clean = re.sub(r"^\s*---\s*$", "", body, flags=re.M)
        clean = re.sub(r"[#*_`]", "", clean)
        clean = re.sub(r"\n{3,}", "\n\n", clean).strip()

        txt = outdir / f"scene{num}.txt"
        aud = outdir / f"scene{num}.m4a"
        txt.write_text(clean)
        subprocess.run([
            "say", "-v", VOICE, "-r", str(RATE),
            "-f", str(txt), "-o", str(aud),
            "--data-format=aac", "--file-format=m4af",
        ], check=True)

        d = duration(aud)
        total += d
        manifest[str(num)] = {
            "title": title.strip(),
            "file": f"audio/scene{num}.m4a",
            "dur": round(d, 2),
            "words": len(clean.split()),
        }
        print(f"scene {num}: {d:6.2f}s  {len(clean.split()):3} words  {title.strip()}")

    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"\ntotal {total:.1f}s = {int(total // 60)}:{int(total % 60):02d} of speech")


if __name__ == "__main__":
    sys.exit(main())