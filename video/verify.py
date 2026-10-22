#!/usr/bin/env python3
"""
verify.py — the gate a recorded take has to pass.

A recording is not evidence that the recording happened. `build.py` can
write a file that is 30 seconds of black, and every mechanical check on it
passes: the file exists, the duration is right, the size is right. The
thing that catches it is a frame with pixels in it.

So this decodes the take, pulls frames out of it at named moments, and
looks at them:

  - the file has to DECODE. A file that cannot be opened is not a video,
    and the honest answer says so instead of "0 problems".
  - the frames have to DIFFER from each other. A take of one flat colour
    has no content, and a content check that only looks at the average
    brightness calls a white screen "content".
  - the duration has to be inside the brief. Eight seconds handed over as a
    finished piece of work is the failure this whole project was written
    against.

The frames are written out as PNGs, because a check you cannot LOOK at is
a check you cannot argue with.

    python3 video/verify.py video/build/audit.mp4 --frames 2,10,20

Exits non-zero when the take fails. A take that is not verified is not a
take.
"""

import argparse
import base64
import shutil
import sys
from pathlib import Path

# Google Chrome decodes H.264; Playwright's own Chromium is built without
# proprietary codecs and cannot. So the decoder is chosen, not assumed.
CHROME = Path("/usr/bin/google-chrome")


def launch_options():
    opts: dict = {"args": ["--no-sandbox", "--allow-file-access-from-files"]}
    if CHROME.exists():
        opts["executable_path"] = str(CHROME)
    return opts


def decode(video: Path, stamps, outdir: Path):
    """(metadata, [(stamp, png bytes, spread)]) for the frames asked for."""
    from playwright.sync_api import sync_playwright

    outdir.mkdir(parents=True, exist_ok=True)
    # The page and the video have to sit in the SAME directory: a file://
    # video cannot be loaded into a page in another one.
    local = outdir / video.name
    if local.resolve() != video.resolve():
        shutil.copyfile(video, local)
    holder = outdir / "holder.html"
    holder.write_text(
        f"""<html><body style="margin:0;background:#000">
        <video id="v" src="{video.name}" style="width:100%"></video></body></html>"""
    )

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch_options())
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto(holder.as_uri())
        meta = page.evaluate(
            """async () => {
              const v = document.getElementById('v');
              // The metadata may ALREADY be loaded: the event fired before
              // this ran, and waiting for it again waits forever.
              if (v.readyState < 1) {
                await new Promise((res, rej) => {
                  v.onloadedmetadata = res;
                  v.onerror = () => rej(new Error('the video did not load'));
                  setTimeout(() => rej(new Error('timeout loading the video')), 15000);
                });
              }
              if (v.error) throw new Error('the video did not load: ' + v.error.message);
              return { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
            }"""
        )
        frames = []
        for stamp in stamps:
            if stamp >= meta["duration"]:
                continue
            data = page.evaluate(
                """async (t) => {
                  const v = document.getElementById('v');
                  await new Promise((res) => { v.onseeked = res; v.currentTime = t; });
                  const c = document.createElement('canvas');
                  c.width = v.videoWidth; c.height = v.videoHeight;
                  const g = c.getContext('2d');
                  g.drawImage(v, 0, 0);
                  // The spread of the pixels: a flat frame has almost none.
                  const d = g.getImageData(0, 0, c.width, c.height).data;
                  let sum = 0, sum2 = 0, n = 0;
                  for (let i = 0; i < d.length; i += 4) {
                    const lum = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
                    sum += lum; sum2 += lum*lum; n++;
                  }
                  const mean = sum/n;
                  const spread = Math.sqrt(Math.max(0, sum2/n - mean*mean));
                  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
                  const buf = new Uint8Array(await blob.arrayBuffer());
                  let s = '';
                  const CH = 0x8000;
                  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i+CH));
                  return { png: btoa(s), spread: spread, mean: mean };
                }""",
                stamp,
            )
            png = base64.b64decode(data["png"])
            path = outdir / f"frame-{stamp:g}s.png"
            path.write_bytes(png)
            frames.append((stamp, path, data["spread"], data["mean"]))
        browser.close()
    return meta, frames


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1] if __doc__ else "")
    ap.add_argument("video")
    ap.add_argument("--frames", default="2,10,20",
                    help="the seconds to look at, comma separated")
    ap.add_argument("--out", default=None, help="where the frames go (default video/scenes/frames)")
    ap.add_argument("--min", type=float, default=10.0, help="the shortest a take may be")
    ap.add_argument("--max", type=float, default=900.0, help="the longest a take may be")
    args = ap.parse_args()

    video = Path(args.video).resolve()
    if not video.exists():
        print(f"no such file: {video}", file=sys.stderr)
        return 2
    outdir = Path(args.out).resolve() if args.out else video.parent / "frames"
    stamps = [float(x) for x in args.frames.split(",") if x.strip()]

    problems = []
    try:
        meta, frames = decode(video, stamps, outdir)
    except Exception as exc:
        print(f"the take could not be decoded: {exc}", file=sys.stderr)
        return 1

    print(f"{video.name}: {meta['duration']:.1f}s, {meta['width']}x{meta['height']}, "
          f"{video.stat().st_size} bytes")
    if not frames:
        problems.append("no frame could be read at the moments asked for")
    for stamp, path, spread, mean in frames:
        print(f"  {stamp:6.1f}s  spread {spread:6.2f}  mean {mean:6.1f}  -> {path}")
        # A flat frame has almost no spread. 2.0 is well under the spread of
        # any frame that shows text on a background, and well over the noise
        # of a solid colour.
        if spread < 2.0:
            problems.append(f"the frame at {stamp:g}s is flat - the take shows nothing there")
    if meta["duration"] < args.min:
        problems.append(f"the take is {meta['duration']:.1f}s, under the {args.min:g}s floor")
    if meta["duration"] > args.max:
        problems.append(f"the take is {meta['duration']:.1f}s, over the {args.max:g}s ceiling")

    if problems:
        print("\nFAILED:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\nthe take passed: it decodes, it shows something, and it is inside the brief")
    return 0


if __name__ == "__main__":
    sys.exit(main())
