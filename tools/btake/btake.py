#!/usr/bin/env python3
"""
btake — record a browser demo as a submission video, unattended.

Built for hackathon entries, where the video is part of the submission and a
silent capture failure costs the entry, not just an afternoon.

The whole design exists to fix one thing: Playwright's built-in screencast is
the wrong tool. It emits frames when it sees *damage*, which is not the same
moment the DOM changes, so a transient result — an order confirmation, a booked
slot, a "done" banner — can fall between two captured frames and never appear on
tape. Several takes passed every automated check and still ended on a reset
screen. So this captures on a fixed clock instead: every instant is a frame, and
the moment you know the result landed is by definition in the file.

Subcommands:

    btake record   --url URL [--click TEXT] [--confirm REGEX] [--out FILE]
    btake verify   FILE.mp4
    btake contact  FILE.mp4            # visual check — READ THIS, not just verify
    btake dub      FILE.mp4 --narration N.mp3 [--offset SECONDS]

`contact` exists because every real failure in this project got past `verify`.
A script can measure duration and speech; only your eyes can see that the
result is missing from the picture.
"""

import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path


def _find_ffmpeg():
    for c in ("/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", "ffmpeg"):
        try:
            subprocess.run([c, "-version"], capture_output=True, check=True)
            return c
        except Exception:
            continue
    raise SystemExit("ffmpeg not found")


FFMPEG = _find_ffmpeg()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def notify(title, message):
    """Never let a notification break a run."""
    try:
        subprocess.run(["osascript", "-e",
                        f'display notification "{message}" with title "{title}"'],
                       capture_output=True, timeout=15)
    except Exception:
        pass


def probe_duration(path):
    """Seconds, from ffmpeg's own banner — ffprobe is often not installed."""
    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                         capture_output=True, text=True).stderr
    for line in out.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)
    raise RuntimeError(f"no Duration found for {path}")


def speech_span(path):
    """(first_loud_second, last_loud_second, total) from a 1 kHz-ish RMS scan."""
    wav = Path(path).with_suffix(".probe.wav")
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(path),
                    "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le",
                    str(wav), "-y"], check=True)
    w = wave.open(str(wav)); n = w.getnframes(); sr = w.getframerate()
    d = struct.unpack("<%dh" % n, w.readframes(n))
    total = n / sr
    loud = [i for i in range(n // sr)
            if 20 * math.log10(
                math.sqrt(sum(x * x for x in d[i * sr:(i + 1) * sr]) / sr) / 32768
                + 1e-9) > -45]
    wav.unlink(missing_ok=True)
    if not loud:
        return None, None, total
    return loud[0], loud[-1] + 1, total


# Chrome/Streamlit/Cloudflare chrome that has no business in a submission video.
CHROME_CSS = """
header[data-testid='stHeader'], [data-testid='stToolbar'],
[data-testid='stStatusWidget'], [data-testid='stDecoration'],
[data-testid='stMainMenu'], iframe:not([src*='~/+']),
#MainMenu, footer { display: none !important; }
"""


async def pick_frame(page, args):
    """
    Find the frame that actually holds the app.

    Guessing (`iframe >> nth=0`) is a trap: Streamlit Cloud injects a
    statuspage.io feedback iframe alongside the app, and the wrong one wins the
    index. Then the click silently matches nothing and the run films a page
    that never does anything. Look for the button instead — the frame holding
    it is by definition the app.
    """
    if not args.frame:
        return page
    # App cua Streamlit Cloud nam trong iframe, app chay local thi chinh la
    # main frame. Xen ca hai vao, va doi chieu bang nut can bam.
    wanted = [c.strip() for c in (args.click or "").split("||") if c.strip()][0]
    for attempt in range(4):
        fallback = None
        for f in [page.main_frame] + [x for x in page.frames if x != page.main_frame]:
            try:
                if wanted and await f.locator(
                        "button", has_text=wanted).count() > 0:
                    log(f"app frame: {f.url[-46:]}")
                    return f
                if fallback is None and f.url not in ("about:blank", ""):
                    fallback = f
            except Exception:
                continue
        await page.wait_for_timeout(5000)
        log(f"no frame held {wanted!r} yet (attempt {attempt + 1})")
    if fallback:
        log(f"WARNING: falling back to {fallback.url[-46:]} — the click may not land")
        return fallback
    log("WARNING: no candidate frame; recording the top page")
    return page.main_frame


def _frames_to_mp4(frm_dir, fps, dst):
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-framerate", str(fps),
                    "-i", str(frm_dir / "%05d.png"),
                    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)],
                   check=True)
    return dst


def trim_white_lead(src, dst, fps):
    """
    Cut the white "Loading..." screen off the front.

    Capture starts when the context is created, before the app has painted, so
    the take always opens with blank page. Detect the first frame that is
    actually the app — hardcoding a number goes stale the moment the app boots
    faster or slower than last time.
    """
    from PIL import Image
    probe = src.parent / "lead"
    probe.mkdir(parents=True, exist_ok=True)
    for f in probe.glob("*.png"):
        f.unlink()
    subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(src),
                    "-vf", f"fps={fps}", "-frames:v", "80",
                    str(probe / "f%03d.png"), "-y"], check=True)
    frames = sorted(probe.glob("*.png"))
    cut = 0.0
    for i, f in enumerate(frames):
        im = Image.open(f).convert("L")
        px = list(im.getdata())
        if sum(1 for p in px if p > 235) / len(px) < 0.90:
            cut = i / fps
            break
    log(f"white lead: {cut:.2f}s")
    if cut < 0.3 or not frames:
        return src, 0.0
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-ss", f"{cut:.2f}",
                    "-i", str(src), "-c", "copy", str(dst), "-y"], check=True)
    return dst, cut


def cmd_record(args):
    from playwright.async_api import async_playwright
    import asyncio

    fps = args.fps
    work = Path(args.work or (args.out + ".work"))
    frames = work / "frames"
    frames.mkdir(parents=True, exist_ok=True)
    for f in frames.glob("*.png"):
        f.unlink()
    # "||" separates steps: button labels are free text and may well contain a
    # comma, so a comma cannot be the delimiter.
    clicks = [c.strip() for c in (args.click or "").split("||") if c.strip()]
    step_wait = args.step_wait

    async def go():
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=args.headless,
                                              args=["--force-device-scale-factor=1"])
            ctx = await browser.new_context(viewport={"width": args.width,
                                                     "height": args.height})
            page = await ctx.new_page()

            for attempt in range(1, args.retries + 1):
                try:
                    await page.goto(args.url, wait_until="domcontentloaded",
                                    timeout=60000)
                    break
                except Exception as e:
                    log(f"load attempt {attempt} failed: {e}")
                    if attempt == args.retries:
                        await browser.close()
                        raise RuntimeError("page never loaded")

            for frame in page.frames:
                for css in (CHROME_CSS, args.hide_css):
                    if not css.strip():
                        continue
                    try:
                        await frame.add_style_tag(content=css)
                        await frame.evaluate(
                            "c=>{const s=document.createElement('style');"
                            "s.textContent=c;document.head.appendChild(s);}", css)
                    except Exception:
                        pass
            await page.wait_for_timeout(1500)

            # Most single-page apps render inside an iframe; a selector on the
            # page returns zero and the run looks like a broken app.
            await page.wait_for_timeout(args.settle * 1000)
            # Pick the frame only once the app has painted. Asking too early
            # finds no button and falls back to whatever iframe came first.
            fr = await pick_frame(page, args)
            if fr is not page.main_frame:
                await page.wait_for_timeout(1500)
                fr = await pick_frame(page, args)

            # Whatever is on screen right now must not be mistaken for this
            # run's result. Apps keep state server-side across sessions.
            stale = None
            if args.confirm:
                try:
                    pre = await fr.locator("body").first.inner_text(timeout=15000)
                    m = re.search(args.confirm, pre)
                    stale = m.group(0) if m else None
                    log(f"pre-existing match on screen: {stale}")
                except Exception:
                    pass

            step = 1.0 / fps
            idx = 0
            done_steps = 0
            last_click = None
            first_click = None
            done_at = None
            rx = re.compile(args.confirm) if args.confirm else None

            while True:
                t0 = time.monotonic()
                try:
                    await page.screenshot(path=str(frames / f"{idx:05d}.png"))
                except Exception as e:
                    # Losing the page mid-run should end the take, not traceback:
                    # the frames already on disk are usually the usable part.
                    log(f"screenshot failed at frame {idx}: {e}")
                    break
                idx += 1

                if done_steps < len(clicks):
                    # Streamlit giu nguyen DOM cua lan render truoc khi ban
                    # chay lai script, nen nut moi co the bi bam ngay lap tuc
                    # vao nut cu. Cho mot khoang nghi giua cac buoc de man hinh
                    # kip ve lai truoc khi nguoi xem thay.
                    if step_wait and last_click is not None and (
                            asyncio.get_event_loop().time() - last_click) < step_wait:
                        await asyncio.sleep(step)
                        continue
                    want = clicks[done_steps]
                    try:
                        # timeout ngan: Playwright mac dinh cho 30 giay
                        # actionability, du mot nut chua render thi ca vong
                        # lap quay dung lai. Thu lai o toc do khung hinh.
                        await fr.locator("button", has_text=want).first.click(
                            timeout=1200)
                        done_steps += 1
                        last_click = asyncio.get_event_loop().time()
                        if first_click is None:
                            first_click = idx
                        log(f"clicked {want!r} (step {done_steps}/{len(clicks)}) "
                            f"at frame {idx} (t={idx/fps:.1f}s)")
                    except Exception:
                        pass
                elif done_at is None:
                    # Poll the DOM sparingly. Each read can block for seconds on
                    # a busy single-page app, and a stalled read starves the
                    # screenshot loop — which is the thing that actually
                    # records the result.
                    if idx % 3 == 0 and rx:
                        try:
                            text = await fr.locator("body").first.inner_text(timeout=3000)
                            m = rx.search(text)
                            fresh = bool(m) and (stale is None or m.group(0) != stale)
                            if fresh:
                                done_at = idx
                                log(f"confirmed {m.group(0)!r} at frame {idx} "
                                    f"(t={idx/fps:.1f}s)")
                        except Exception:
                            pass
                elif (idx - done_at) / fps > args.hold:
                    break

                if idx / fps > args.max_seconds:
                    log(f"hit the {args.max_seconds}s ceiling")
                    break
                delay = step - (time.monotonic() - t0)
                if delay > 0:
                    await page.wait_for_timeout(delay * 1000)

            await browser.close()
            return idx, first_click, done_at, done_steps

    notify("btake", "recording started")
    try:
        idx, first_click, done_at, done_steps = asyncio.run(go())
    except Exception as e:
        notify("btake FAILED", str(e)[:90])
        log(f"FAILED: {e}")
        return 1

    log(f"captured {idx} frames @ {fps}fps = {idx/fps:.1f}s")
    if done_at is None:
        log("NEVER CONFIRMED — recording anyway so you can look at it")
    if done_steps < len(clicks):
        log(f"FATAL: chi bam duoc {done_steps}/{len(clicks)} nut: {clicks!r}")
        return 1

    raw = work / "take-raw.mp4"
    _frames_to_mp4(frames, fps, raw)
    trimmed, cut = trim_white_lead(raw, work / "take.mp4", fps)
    subprocess.run(["cp", str(trimmed), args.out], check=True)

    # A take recorded without --click has no "the result happened" frame, so
    # there is nothing to measure narration from. Report null rather than 0.0:
    # 0.0 would tell the caller to dub narration over the very first frame,
    # which is silently wrong instead of obviously absent.
    narration_offset = None if first_click is None else round(
        max(0.0, first_click / fps - cut), 2)

    report = {
        "out": args.out, "frames": idx, "fps": fps,
        "duration": probe_duration(args.out), "white_cut": cut,
        "clicks": clicks,
        "click_frame": first_click, "confirm_frame": done_at,
        "confirmed": done_at is not None,
        "narration_offset": narration_offset,
    }
    (work / "report.json").write_text(json.dumps(report, indent=2))
    log(f"DONE {json.dumps(report)}")
    ok = done_at is not None
    notify("btake DONE" if ok else "btake UNCONFIRMED",
           f"{report['duration']:.1f}s — now run: btake contact {args.out}")
    print("\n" + "=" * 62)
    print("  Script checks passed. That is NOT the same as the video being right.")
    print(f"  LOOK AT IT:  btake contact {args.out}")
    print("=" * 62)
    return 0


def cmd_verify(args):
    path = Path(args.file)
    problems = []
    dur = probe_duration(path)

    out = subprocess.run([FFMPEG, "-hide_banner", "-i", str(path)],
                         capture_output=True, text=True).stderr
    has_v = "Video:" in out
    has_a = "Audio:" in out
    if not has_v:
        problems.append("no video stream")
    if not has_a:
        problems.append("no audio stream")
    if out.count("Duration:") != 1:
        problems.append("more than one duration line")
    if not re.search(r"yuv420p", out):
        problems.append("not yuv420p — many players refuse it")

    first, last, total = speech_span(path) if has_a else (None, None, 0)
    detail = {}
    if has_a:
        detail = {"audio_stream": round(total, 2), "speech": None,
                  "tail": None}
        if first is None:
            problems.append("audio stream is silent")
        else:
            detail["speech"] = [first, last]
            detail["tail"] = round(total - last, 2)
            if total < dur - 0.5:
                problems.append(
                    f"audio stream {total:.2f}s is shorter than the "
                    f"{dur:.2f}s video — audio dies before the end")
            if args.expect_narration:
                exp = probe_duration(args.expect_narration)
                spoken = last - first
                detail["narration"] = {"expected": round(exp, 2),
                                       "spoken": round(spoken, 2)}
                if spoken < exp - 1.0:
                    problems.append(f"only {spoken:.2f}s of {exp:.2f}s narration present")

    print(json.dumps({"file": str(path), "duration": dur, **detail,
                      "problems": problems or None}, indent=2))
    if problems:
        print("\nFAILED:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("\nPASS (mechanical checks only — still run `btake contact`)")
    return 0


def cmd_contact(args):
    """The check that actually catches mistakes. Save it and look at it."""
    sheet = str(Path(args.file).with_suffix(".contact.png"))
    interval = args.every or max(3.0, probe_duration(args.file) / (args.cols * args.rows))
    cols, rows = args.cols, args.rows
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", args.file,
                    "-vf", f"fps=1/{interval:.2f},scale={args.width}:-1,"
                           f"tile={cols}x{rows}",
                    sheet, "-y"], check=True)
    print(f"contact sheet: {sheet}")
    print(f"  {cols*rows} frames, one every {interval:.1f}s")
    print("  Read it in order. Is the RESULT actually on screen at the end?")
    return 0


def cmd_dub(args):
    """
    Lay narration over a take and pad it out to the take's length.

    `apad` + `-shortest` HANGS — ffmpeg waits forever. Cap with -t instead.
    And `ffmpeg -i` with no output file always exits 1, which under
    `set -o pipefail` inside a script kills everything before the mux runs.
    """
    dur = probe_duration(args.file)
    if args.offset is None:
        args.offset = 0.0
    if args.narration:
        narr = probe_duration(args.narration)
        if narr + args.offset > dur + 0.1:
            print(f"WARNING: narration ends at {narr + args.offset:.2f}s but the "
                  f"take is only {dur:.2f}s — it WILL be clipped. "
                  f"Re-trim the narration or start earlier.")
        else:
            log(f"narration {narr:.2f}s at offset {args.offset:.2f}s, "
                f"{dur - (narr + args.offset):.2f}s to spare")
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", args.file,
                    "-i", args.narration,
                    "-filter_complex",
                    f"[1:a]adelay={int(args.offset*1000)}|{int(args.offset*1000)},"
                    f"apad[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
                    "-t", f"{dur}", args.out], check=True)
    log(f"wrote {args.out}")
    return 0


def main():
    ap = argparse.ArgumentParser(prog="btake", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record", help="capture a browser demo on a fixed clock")
    r.add_argument("--url", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--click",
                   help="button text to click, e.g. 'RUN FULL DEMO'. For a "
                        "multi-step demo pass several separated by '||', "
                        "clicked in order: 'Seed||Sign in as Ada'")
    r.add_argument("--confirm", help="regex proving the result landed, e.g. 'VC-\\d+'")
    r.add_argument("--hold", type=float, default=8.0,
                   help="seconds to keep filming after --confirm matches")
    r.add_argument("--settle", type=float, default=3.0)
    r.add_argument("--step-wait", type=float, default=1.5,
                   help="seconds between two consecutive button clicks; "
                        "0 = click as fast as the element appears")
    r.add_argument("--fps", type=int, default=10)
    r.add_argument("--width", type=int, default=1440)
    r.add_argument("--height", type=int, default=900)
    r.add_argument("--max-seconds", type=float, default=150.0)
    r.add_argument("--retries", type=int, default=3)
    r.add_argument("--frame", action="store_true",
                   help="content lives in an iframe (Streamlit does)")
    r.add_argument("--hide-css", default="", help="extra CSS to hide app chrome")
    r.add_argument("--work", help="scratch dir (default <out>.work)")
    r.add_argument("--headless", action="store_true",
                   help="run Chromium without a window; needed when there is "
                        "no usable display (ssh, agent session, CI)")
    r.set_defaults(func=cmd_record)

    v = sub.add_parser("verify", help="mechanical checks on a finished file")
    v.add_argument("file")
    v.add_argument("--expect-narration", help="mp3 you laid down, to check it survived")
    v.set_defaults(func=cmd_verify)

    c = sub.add_parser("contact", help="contact sheet — LOOK AT IT")
    c.add_argument("file")
    c.add_argument("--every", type=float, default=0, help="seconds between frames")
    c.add_argument("--cols", type=int, default=4)
    c.add_argument("--rows", type=int, default=3)
    c.add_argument("--width", type=int, default=340)
    c.set_defaults(func=cmd_contact)

    d = sub.add_parser("dub", help="lay narration over a take, padded to length")
    d.add_argument("file")
    d.add_argument("--narration", required=True)
    d.add_argument("--out", required=True)
    d.add_argument("--offset", type=float)
    d.set_defaults(func=cmd_dub)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())