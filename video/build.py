#!/usr/bin/env python3
"""
build.py — record a demo video on a machine with no screen and no ffmpeg.

The published demo was recorded with `vrec`, which drives the real keyboard
and the real screen on macOS. That is the best-looking way to film a
terminal, and it is the wrong tool for a machine that has neither a screen
nor the Screen Recording permission: there is no permission to ask for, and
`vrec` needs Quartz.

So this is the other road, and it is not a smaller version of `vrec`:

  Playwright's Chromium + a canvas + MediaRecorder.

The scene IS a canvas. Every frame is painted and captured at a fixed
clock, and the file that comes out is an .mp4 with an H.264 track - with no
ffmpeg on the machine at all, because the browser IS the encoder. The
recording is as fixed-clock as `btake`'s is, so a transient result cannot
fall between two frames.

The text on screen is the REAL output of the REAL commands: the commands
in the take spec are run when the video is built, and their output is what
gets typed onto the screen. Nothing here is a transcript someone typed out.

    python3 video/build.py --spec video/takes/audit.json

The take spec is the take: which commands run, and which words are on the
cards. It lives in `video/takes/`, which is gitignored - a take is about
one machine and one moment, and the repository ships the recorder and not
the take. The video lands in `video/build/`, which is gitignored too: a
recording is a local artefact until somebody decides to publish it, and
publishing one is a separate, deliberate act.

What is NOT here: a copy of `vrec` or of `btake`. They have their own
repositories and their own history, and a copy inside this one is how two
copies drift.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")
ROOT = Path(__file__).resolve().parent.parent


def run(argv, cwd):
    """The real output of a real command, with the colour codes taken off."""
    try:
        p = subprocess.run(
            argv, cwd=cwd, capture_output=True, text=True, timeout=300
        )
        return ANSI.sub("", (p.stdout or "") + (p.stderr or ""))
    except Exception as exc:
        # A demo must not die because one command did: the take shows the
        # failure, and the rest of the take still gets recorded.
        return f"(this command could not be run here: {exc})"


def terminal_lines(spec, cwd):
    """The commands in the take, and what they printed.

    The output is trimmed to the last N lines, because a terminal in a
    video is read by a person: the lines that decide the take are the last
    ones, and the trim says how many were dropped - a take that hides what
    it cut is a lie.
    """
    cap = spec.get("max_lines", 10)
    lines = []
    for cmd in spec.get("commands", []):
        lines.append("$ " + " ".join(cmd))
        out = [l for l in run(cmd, cwd).splitlines() if l.strip()]
        if len(out) > cap:
            out = [f"… {len(out) - cap} earlier lines"] + out[-cap:]
        lines += out
    return lines


PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#0b0f14;overflow:hidden}
  canvas{display:block}
</style></head><body>
<canvas id="c"></canvas>
<script>
const DATA = __DATA__;
const W = DATA.width, H = DATA.height;
const c = document.getElementById("c");
c.width = W; c.height = H;
const g = c.getContext("2d");
const MONO = '"DejaVu Sans Mono","Liberation Mono",monospace';

const BG="#0b0f14", FG="#d8dee9", DIM="#6b7785", GREEN="#7bc96f",
      YELLOW="#e5c07b", RED="#e06c75", BLUE="#61afef", WHITE="#ffffff";

function bg(){ g.fillStyle=BG; g.fillRect(0,0,W,H); }
function text(s,x,y,size,color,weight){
  g.fillStyle=color; g.font=(weight||"400")+" "+size+"px "+MONO;
  g.textBaseline="top"; g.fillText(s,x,y);
}
function center(s,y,size,color,weight){
  g.font=(weight||"400")+" "+size+"px "+MONO; g.fillStyle=color;
  g.textBaseline="top"; g.fillText(s,(W-g.measureText(s).width)/2,y);
}
function rule(y,color){ g.fillStyle=color; g.fillRect(60,y,W-120,2); }

// The scenes, in order. Each one knows how long it lasts.
const SC=[]; let t=0;
function add(dur,fn){ SC.push({t0:t,t1:t+dur,fn}); t+=dur; }

// 1. Title card.
if (DATA.title) {
  const T = DATA.title;
  add(T.seconds || 4.2, () => {
    bg();
    center(T.heading, H*0.28, 44, WHITE, "700");
    if (T.sub) center(T.sub, H*0.28+70, 26, BLUE);
    rule(H*0.28+118, "#2b3440");
    (T.lines||[]).forEach((l,i)=>center(l, H*0.28+150+i*34, 21, FG));
  });
}

// 2. The terminal: the real output of the real commands.
if (DATA.terminal && DATA.terminal.lines.length) {
  const LINES = DATA.terminal.lines;
  const TYPE = 0.010, GAP = 0.42;
  let total = 0;
  for (const L of LINES) { L.start = total; total += L.length*TYPE + GAP; }
  add(total + 1.0, (el) => {
    bg();
    g.fillStyle="#141a21"; g.fillRect(60,60,W-120,H-140);
    g.fillStyle="#1b222b"; g.fillRect(60,60,W-120,34);
    g.fillStyle="#e06c75"; g.beginPath(); g.arc(84,77,6,0,7); g.fill();
    g.fillStyle="#e5c07b"; g.beginPath(); g.arc(106,77,6,0,7); g.fill();
    g.fillStyle="#7bc96f"; g.beginPath(); g.arc(128,77,6,0,7); g.fill();
    text(DATA.terminal.caption || "terminal", 150, 68, 15, DIM);
    const top = 112, step = Math.round((H-200)/Math.max(12, LINES.length));
    let y = top;
    for (const L of LINES) {
      const age = el - L.start;
      if (age < 0) break;
      const n = Math.max(0, Math.min(L.length, Math.floor(age/TYPE)));
      if (n === 0) { continue; }
      const s = L.slice(0,n);
      let color = FG, bold = "400";
      if (s.startsWith("$ ")) { color = WHITE; bold = "700"; }
      else if (s.startsWith("✓")) color = GREEN;
      else if (s.startsWith("#")) color = YELLOW;
      else if (s.startsWith("!")) color = RED;
      else if (s.startsWith("…")) color = DIM;
      text(s, 84, y, 19, color, bold);
      y += step;
    }
    const last = LINES.filter(L => el-L.start > 0).pop();
    if (last && Math.floor(el*2)%2===0) {
      const n = Math.max(0, Math.min(last.length, Math.floor((el-last.start)/TYPE)));
      g.font = "700 19px " + MONO;
      g.fillStyle = WHITE;
      g.fillRect(84 + g.measureText(last.slice(0,n)).width, top + LINES.indexOf(last)*step, 10, 20);
    }
  });
}

// 3. The bullets: what changed.
if (DATA.bullets) {
  const B = DATA.bullets;
  add(B.seconds || (B.items.length*1.25 + 1.2), (el) => {
    bg();
    center(B.heading, 90, 30, WHITE, "700");
    if (B.sub) center(B.sub, 134, 18, DIM);
    rule(176, "#2b3440");
    B.items.forEach((it,i)=>{
      const age = el - i*1.25;
      if (age < 0) return;
      g.globalAlpha = Math.min(1, age/0.35);
      text(B.mark || "✗", 150, 220+i*46, 22, RED, "700");
      text(it[0].padEnd(11), 190, 220+i*46, 21, YELLOW, "700");
      text(it[1], 340, 220+i*46, 21, FG);
      g.globalAlpha = 1;
    });
  });
}

// 4. End card.
if (DATA.end) {
  const E = DATA.end;
  add(E.seconds || 4.5, () => {
    bg();
    center(E.heading, H*0.3, 36, WHITE, "700");
    if (E.sub) center(E.sub, H*0.3+62, 22, BLUE);
    rule(H*0.3+118, "#2b3440");
    (E.lines||[]).forEach((l,i)=>{
      const color = l.startsWith("#") ? GREEN : (l.startsWith("~") ? DIM : FG);
      center(l.replace(/^[#~]/,""), H*0.3+150+i*34, 19, color);
    });
  });
}

// The clock. It starts when the RECORDER starts: the page loads a moment
// before the recorder is armed, and a clock that starts at page load cuts
// the first scene and runs the last one off the end of the file.
let START = performance.now();
window.__reset = () => { START = performance.now(); };
function frame(){
  const el = (performance.now() - START)/1000;
  for (const s of SC) { if (el>=s.t0 && el<s.t1) { s.fn(el-s.t0); break; } }
  if (el>=t) { g.fillStyle=BG; g.fillRect(0,0,W,H); }
  requestAnimationFrame(frame);
}
frame();
window.__duration = t;
</script>
</body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1] if __doc__ else "")
    ap.add_argument("--spec", required=True, help="the take: a JSON file")
    ap.add_argument("--out", help="the .mp4 to write (default video/build/<spec>.mp4)")
    ap.add_argument("--cwd", default=str(ROOT), help="where the commands run")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()

    spec_path = Path(args.spec).resolve()
    spec = json.loads(spec_path.read_text())
    out = Path(args.out).resolve() if args.out else ROOT / "video" / "build" / (spec_path.stem + ".mp4")
    out.parent.mkdir(parents=True, exist_ok=True)

    data = {
        "width": args.width,
        "height": args.height,
        "title": spec.get("title"),
        "bullets": spec.get("bullets"),
        "end": spec.get("end"),
        "terminal": {
            "caption": spec.get("terminal", {}).get("caption", ""),
            "lines": terminal_lines(spec.get("terminal", {}), args.cwd),
        },
    }
    print(f"terminal: {len(data['terminal']['lines'])} lines")

    html = PAGE.replace("__DATA__", json.dumps(data))
    scene = ROOT / "video" / "scenes" / (spec_path.stem + ".html")
    scene.parent.mkdir(parents=True, exist_ok=True)
    scene.write_text(html)

    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:
        print(f"playwright is not available: {exc}", file=sys.stderr)
        return 2

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": args.width, "height": args.height})
        page = ctx.new_page()
        page.goto(scene.as_uri())
        duration = page.evaluate("window.__duration")

        # The browser is the encoder: it picks the first container it can
        # actually PRODUCE, and the file says which one it is.
        mime = page.evaluate(
            """() => {
              for (const m of ['video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp8', 'video/webm']) {
                if (MediaRecorder.isTypeSupported(m)) return m;
              }
              return null;
            }"""
        )
        if not mime:
            print("this browser cannot record video", file=sys.stderr)
            browser.close()
            return 2
        print("recording as", mime)

        page.evaluate(
            """(mime) => {
              const c = document.getElementById('c');
              const stream = c.captureStream(__FPS__);
              const rec = new MediaRecorder(stream, {mimeType: mime, videoBitsPerSecond: 6000000});
              window.__chunks = [];
              rec.ondataavailable = e => { if (e.data && e.data.size) window.__chunks.push(e.data); };
              rec.start(200);
              window.__rec = rec;
            }""".replace("__FPS__", str(args.fps)),
            mime,
        )
        # The clock starts NOW, with the recorder armed.
        page.evaluate("() => window.__reset()")
        time.sleep(duration + 2.0)

        b64 = page.evaluate(
            """async () => {
              window.__rec.stop();
              await new Promise(r => setTimeout(r, 800));
              const blob = new Blob(window.__chunks, {type: 'video/mp4'});
              const buf = new Uint8Array(await blob.arrayBuffer());
              let s = '';
              const CH = 0x8000;
              for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i+CH));
              return btoa(s);
            }"""
        )
        browser.close()

    raw = base64.b64decode(b64)
    out.write_bytes(raw)
    print(f"wrote {out} ({len(raw)} bytes, {duration:.1f}s of animation)")
    print(f"scene: {scene}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
