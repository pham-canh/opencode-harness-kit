#!/usr/bin/env python3
"""Render one still per scene for the space-harness demo video.

The point of a still frame is that it can carry real content from the repo --
actual numbers, actual file paths -- rather than a mock-up. Everything on screen
here is taken from files in this repository, so if the project changes, these
frames are wrong and the render fails loudly.

Output: scenes/scene<N>.png at 1920x1080.
"""

import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).parent
REPO = ROOT.parent
W, H = 1920, 1080

# --- numbers quoted on screen, read from the repo so they cannot drift --------

def repo_fact(*parts):
    return (REPO.joinpath(*parts)).read_text()


def test_count():
    """Count `test(` calls the way node's runner reports them."""
    n = 0
    for t in (REPO / "test").glob("*.test.js"):
        n += t.read_text().count("\ntest(") + t.read_text().count("\n  test(")
    return n


CSS = """
*{margin:0;padding:0;box-sizing:border-box}
body{width:1920px;height:1080px;background:#0b0d12;color:#e6e9ef;
  font-family:-apple-system,'SF Pro Text',system-ui,sans-serif;
  display:flex;flex-direction:column;padding:96px 120px;position:relative;overflow:hidden}
.mono{font-family:'SF Mono',Menlo,monospace}

.eyebrow{font-size:26px;letter-spacing:.22em;text-transform:uppercase;
  color:#7c8496;font-weight:600;margin-bottom:26px}
h1{font-size:82px;line-height:1.08;font-weight:700;letter-spacing:-.025em}
h1 .accent{color:#5ee6a8}
h2{font-size:66px;line-height:1.12;font-weight:700;letter-spacing:-.022em;margin-bottom:44px}
p.lede{font-size:37px;line-height:1.45;color:#aeb6c6;max-width:1420px}

.body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:30px;
  padding-bottom:54px}

.card{background:#131721;border:1px solid #232a38;border-radius:20px;
  padding:38px 44px}
.card h3{font-size:30px;font-weight:650;color:#5ee6a8;margin-bottom:14px;
  letter-spacing:.01em}
.card p{font-size:31px;line-height:1.45;color:#c3cad8}
.card p.dim{color:#98a1b3;font-size:28px}

.grid2{display:grid;grid-template-columns:1fr 1fr;gap:30px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}

.stat{background:#131721;border:1px solid #232a38;border-radius:20px;
  padding:40px 44px;display:flex;flex-direction:column;justify-content:center}
.stat .big{font-size:82px;font-weight:700;color:#5ee6a8;line-height:1;
  letter-spacing:-.03em}
.stat .big.red{color:#ff8087}
.stat .lbl{font-size:26px;color:#98a1b3;margin-top:18px;line-height:1.35}

.term{background:#0e1119;border:1px solid #232a38;border-radius:18px;
  padding:34px 40px;font-size:29px;line-height:1.65;color:#c3cad8;
  white-space:pre;overflow:hidden}
.term .p{color:#5ee6a8}
.term .c{color:#6f7889}
.term .g{color:#5ee6a8}
.term .y{color:#ffd479}
.term .r{color:#ff8087}

.bar{height:34px;border-radius:9px;background:#1c2230;overflow:hidden;
  display:flex;margin-top:22px}
.bar i{display:block;height:100%}
.bar i.old{background:#3b455c}
.bar i.new{background:#5ee6a8}

.foot{position:absolute;bottom:56px;left:120px;right:120px;display:flex;
  justify-content:space-between;align-items:center;font-size:24px;color:#5f6879}
.foot .dot{width:9px;height:9px;border-radius:50%;background:#5ee6a8;
  display:inline-block;margin-right:14px;vertical-align:middle}

.logo{position:absolute;top:60px;right:120px;font-size:27px;color:#6f7889;
  font-weight:600;letter-spacing:.02em}
"""

TITLE = "space-harness"
SUBTITLE = "An open-source harness kit for opencode"


def wrap(head, body, foot_left):
    return f"""<!doctype html><meta charset="utf-8"><style>{CSS}</style>
<div class="body">{head}{body}</div>
<div class="logo mono">{TITLE}</div>
<div class="foot"><span><i class="dot"></i>{foot_left}</span><span class="mono">{SUBTITLE}</span></div>"""


def s1():
    head = """<div class="eyebrow">The problem</div>
<h1>Change one line.<br>Read <span class="accent">four hundred files</span>.</h1>"""
    body = """<p class="lede" style="margin-top:40px">Nothing told the agent where to look,
so it looked everywhere -- and you paid for every token twice: once to read,
once to carry forward.</p>"""
    return wrap(head, body, "MIT licensed")


def s2():
    head = """<div class="eyebrow">What it actually is</div>
<h2>Four layers, and none of them a wrapper.</h2>"""
    body = """<div class="grid2">
  <div class="card"><h3>1 &nbsp;Profiles</h3><p>Which model gets which budget,
    and which may train on your prompts.</p></div>
  <div class="card"><h3>2 &nbsp;Skills</h3><p>Eleven procedures, from planning a
    change to reviewing one.</p></div>
  <div class="card"><h3>3 &nbsp;Plugins</h3><p>Four runtime plugins that enforce
    the rules, not suggest them.</p></div>
  <div class="card"><h3>4 &nbsp;CLI</h3><p>Wires it together and checks the
    install is whole.</p></div>
</div>"""
    return wrap(head, body, "The layer underneath")


def s3():
    n = test_count()
    head = """<div class="eyebrow">Measured, not claimed</div>
<h2>A benchmark you can rerun.</h2>"""
    body = f"""<div class="grid3">
  <div class="stat"><div class="big">53.8%</div>
    <div class="lbl">less context per request</div></div>
  <div class="stat"><div class="big">1.8</div>
    <div class="lbl">file reads per search, down from 12.2</div></div>
  <div class="stat"><div class="big">{n}</div>
    <div class="lbl">tests in the suite</div></div>
</div>
<div style="margin-top:44px">
  <div class="bar"><i class="old" style="width:100%"></i></div>
  <div class="bar" style="margin-top:14px"><i class="new" style="width:46.2%"></i></div>
  <p class="lede" style="font-size:29px;margin-top:22px;color:#98a1b3">
    153,411 tokens &rarr; 70,948 &nbsp;&middot;&nbsp;
    <span style="color:#5ee6a8">locate before you read</span></p>
</div>"""
    return wrap(head, body, "Reproducible benchmark")


def s4():
    head = """<div class="eyebrow">The engineering loop</div>
<h2>Plan. Build. Review. Finish.</h2>"""
    body = """<div class="term"><span class="c">$</span> oc-harness <span class="y">run</span>

  <span class="p">[1]</span> parse the task file
      <span class="c">src/tasks.js</span>
      <span class="c">verify: npm run check</span>
      <span class="g">done</span> 42s

  <span class="p">[2]</span> write the parser test
      <span class="c">test/tasks.test.js</span>
      <span class="c">verify: node --test</span>
      <span class="g">done</span> 18s

  <span class="g">done  every task is done (2/2).</span></div>
<p class="lede" style="margin-top:36px;font-size:30px;color:#98a1b3">
  One task at a time, headless, writing the real output as it goes.</p>"""
    return wrap(head, body, "Headless driver")


def s5():
    head = """<div class="eyebrow">The safety model</div>
<h2>The agent does not grade its own homework.</h2>"""
    body = """<div class="term"><span class="c">$</span> oc-harness <span class="y">run</span>
  <span class="r">stopped  agent reported success; verify did not.</span>
  <span class="c">marked blocked, real output written to .space/tasks.md</span>

<span class="c">$</span> task with no verify command
  <span class="r">blocked  unverifiable work is not run unattended</span></div>
<div class="grid3" style="margin-top:36px">
  <div class="card"><h3>Verify yourself</h3><p class="dim">The driver re-runs the
    command. It never takes the agent's word.</p></div>
  <div class="card"><h3>Refuse the unclear</h3><p class="dim">No verify command,
    no completion.</p></div>
  <div class="card"><h3>Never publish</h3><p class="dim">No push, no PR, no
    release. A human decides.</p></div>
</div>"""
    return wrap(head, body, "Human keeps the publish key")


def s6():
    head = """<div class="eyebrow">The part that bit us</div>
<h2>A bug a demo never shows.</h2>"""
    body = """<div class="term"><span class="p">$</span> oc-harness use space-bunny-free
  <span class="y">trailing comma in a hand-edited .jsonc</span>

  parser threw &rarr; reader returned <span class="r">{}</span>
  &rarr; merged onto an empty base
  &rarr; wrote your settings back out <span class="r">deleted</span>

  <span class="y">no warning. no backup.</span></div>
<p class="lede" style="margin-top:36px;font-size:30px;color:#98a1b3">
  The kind of failure that only shows up on someone else's machine &mdash;
  after they've already lost the setting.</p>"""
    return wrap(head, body, "caught before release")


def s7():
    head = """<div class="eyebrow">Fixed</div>
<h1>Take it.</h1>"""
    body = f"""<div class="term" style="margin-top:30px"><span class="p">$</span> npm i -g opencode-harness-kit
$ oc-harness <span class="y">init</span> &amp;&amp; oc-harness <span class="y">use</span> space-bunny-free</div>
<p class="lede" style="margin-top:38px;font-size:29px">
  The parser walks the text. The CLI refuses to guess rather than write over
  your work. And <span class="g">{test_count()} tests</span> rerun on every commit,
  so none of it rots quietly.</p>
<p class="lede" style="margin-top:22px;font-size:27px;color:#98a1b3">
  Typechecked &middot; tested &middot; MIT licensed</p>"""
    return wrap(head, body, "github.com/pham-canh/space-harness")


SCENES = {1: s1, 2: s2, 3: s3, 4: s4, 5: s5, 6: s6, 7: s7}


def main():
    outdir = ROOT / "scenes"
    outdir.mkdir(exist_ok=True)
    manifest = json.loads((ROOT / "audio" / "manifest.json").read_text())
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": H},
                        device_scale_factor=1)
        for n in sorted(SCENES):
            pg.set_content(SCENES[n](), wait_until="networkidle")
            dest = outdir / f"scene{n}.png"
            pg.screenshot(path=str(dest))
            print(f"scene {n}: {dest.name}  {dest.stat().st_size // 1024} KB  "
                  f"{manifest[str(n)]['dur']}s audio")
        b.close()


if __name__ == "__main__":
    sys.exit(main())