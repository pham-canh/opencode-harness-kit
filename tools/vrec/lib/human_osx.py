#!/usr/bin/env python3
"""Post human-like mouse and keyboard events on macOS through CoreGraphics.

Geometry and timing come from human_input.py (ported from
artemindubai/human-input, MIT). This file is the driver: it walks the pointer
along the sampled path with real sleeps and posts CGEvents to the HID tap so
the whole system sees them, not just the focused window.

Coordinates are macOS points, top-left origin, which is what CGEvent expects.
The display is 2560x1600 pixels at 2x, i.e. 1280x800 points.

Subcommands:
  move X Y            walk the pointer to a point like a hand would
  click X Y [--right] move there, settle, click
  scroll X Y N        move there, scroll N wheel notches (negative = up)
  type TEXT           type text with human rhythm, typos and corrections
  key NAME            press Return / Tab / Backspace / Delete / Escape
  screen              print the main display bounds in points
  doctor              check Quartz and the Accessibility permission
"""

import argparse
import os
import hashlib
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import human_input as hi  # noqa: E402

# Virtual keycodes for a US layout (HIToolbox Events.h).
KEYCODES = {
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
    "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
    "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12,
    "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18,
    "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
    "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "return": 0x24,
    "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A,
    ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "tab": 0x30,
    " ": 0x31, "`": 0x32, "backspace": 0x33, "escape": 0x35, "delete": 0x75,
    "left": 0x7B, "right": 0x7D, "down": 0x7E, "up": 0x7F,
}
BASE_CHAR = {
    0x00: "a", 0x01: "s", 0x02: "d", 0x03: "f", 0x04: "h", 0x05: "g",
    0x06: "z", 0x07: "x", 0x08: "c", 0x09: "v", 0x0B: "b", 0x0C: "q",
    0x0D: "w", 0x0E: "e", 0x0F: "r", 0x10: "y", 0x11: "t", 0x12: "1",
    0x13: "2", 0x14: "3", 0x15: "4", 0x16: "6", 0x17: "5", 0x18: "=",
    0x19: "9", 0x1A: "7", 0x1B: "-", 0x1C: "8", 0x1D: "0", 0x1E: "]",
    0x1F: "o", 0x20: "u", 0x21: "[", 0x22: "i", 0x23: "p", 0x24: "\n",
    0x25: "l", 0x26: "j", 0x27: "'", 0x28: "k", 0x29: ";", 0x2A: "\\",
    0x2B: ",", 0x2C: "/", 0x2D: "n", 0x2E: "m", 0x2F: ".", 0x30: "\t",
    0x31: " ", 0x32: "`", 0x33: "\b", 0x35: "\x1b", 0x75: "",
}
SHIFT = 0x38
CONTROL = 0x3B

# What each physical key produces with Shift held, on a US layout.
#
# KEYCODES only records the unshifted character of a key and BASE_CHAR only
# goes from keycode back to that same character, so the shifted half of the
# keyboard — the entire row of symbols above the numbers — had no lookup in
# either direction. `_keycode_for('&')` found nothing and the character was
# dropped on the floor, which turned `cd x && npm run node` into
# `cd x  npm run node` and left the recorder waiting ninety seconds for a
# chain that was never asked to start.
SHIFTED_CHAR = {
    0x12: "!", 0x13: "@", 0x14: "#", 0x15: "$", 0x16: "^", 0x17: "%",
    0x18: "+", 0x19: "(", 0x1A: "&", 0x1B: "_", 0x1C: "*", 0x1D: ")",
    0x1E: "}", 0x21: "{", 0x27: '"', 0x29: ":", 0x2A: "|", 0x2B: "<",
    0x2C: "?", 0x2F: ">", 0x32: "~",
}
OPTION = 0x3A
COMMAND = 0x37

# Characters that are not on the US layout but are typed with Option on it.
# Without these a preset that types an em dash puts nothing in the video and
# the line reads wrong on screen.
#   char: (keycode, needs_shift)
OPTION_KEYCODES = {
    "—": (0x1B, True),   # Option+Shift+Hyphen
    "–": (0x1B, False),  # Option+Hyphen
    "‘": (0x27, False),  # Option+Quote
    "’": (0x27, True),   # Option+Shift+Quote
    "“": (0x21, False),  # Option+LeftBracket
    "”": (0x21, True),   # Option+Shift+LeftBracket
    "…": (0x2F, True),   # Option+Shift+Period
    "©": (0x05, False),  # Option+G
    "°": (0x1C, True),   # Option+Shift+8
    "€": (0x13, True),   # Option+Shift+2
    "×": (0x18, True),   # Option+Shift+Equal
    "•": (0x0A, False),  # Option+B
}


def quartz():
    """Import Quartz on demand so --dry-run works without the venv."""
    try:
        import Quartz  # noqa: F401
    except ImportError:
        sys.exit(
            "human_osx: PyObjC is not installed. Run: bash tools/vrec/lib/setup_env.sh"
        )
    return Quartz


def point(value):
    """CGPoint comes back as a CoreFoundation struct, not a plain tuple."""
    x = getattr(value, "x", None)
    if x is None:
        x, y = value[0], value[1]
    else:
        y = value.y
    return float(x), float(y)


def mouse_position():
    q = quartz()
    return point(q.CGEventGetLocation(q.CGEventCreate(None)))


def display_bounds():
    """Main display bounds in points: x, y, width, height."""
    q = quartz()
    bounds = q.CGDisplayBounds(q.CGMainDisplayID())
    origin = getattr(bounds, "origin", None)
    if origin is not None:
        ox, oy = point(origin)
        size = bounds.size
        return ox, oy, float(size.width), float(size.height)
    if isinstance(bounds, dict):
        return float(bounds["x"]), float(bounds["y"]), float(bounds["w"]), float(bounds["h"])
    return float(bounds[0]), float(bounds[1]), float(bounds[2]), float(bounds[3])


def post_mouse(kind, x, y, button=0, click_state=1):
    q = quartz()
    event = q.CGEventCreateMouseEvent(None, kind, (x, y), button)
    q.CGEventSetIntegerValueField(event, q.kCGMouseEventClickState, click_state)
    q.CGEventPost(q.kCGHIDEventTap, event)


def post_key(code, down):
    q = quartz()
    q.CGEventPost(q.kCGHIDEventTap, q.CGEventCreateKeyboardEvent(None, code, down))


def post_scroll(notches):
    q = quartz()
    event = q.CGEventCreateScrollWheelEvent(None, q.kCGScrollEventUnitLine, 1, notches)
    q.CGEventPost(q.kCGHIDEventTap, event)


def move_pointer(x, y, seed=None, jitter=0.0):
    """Walk the pointer to (x, y) along a human path and land on it exactly."""
    current = mouse_position()
    samples = hi.path(int(round(current[0])), int(round(current[1])), int(x), int(y), seed=seed)
    travel = hi.fitts_time(max(1.0, ((x - current[0]) ** 2 + (y - current[1]) ** 2) ** 0.5))
    stride = travel / max(1, len(samples) - 1)
    rng = hi._rng(seed)
    for index, (px, py) in enumerate(samples):
        offset_x = offset_y = 0.0
        if jitter and index not in (0, len(samples) - 1):
            offset_x = rng.uniform(-jitter, jitter)
            offset_y = rng.uniform(-jitter, jitter)
        post_mouse(quartz().kCGEventMouseMoved, px + offset_x, py + offset_y, click_state=0)
        if index < len(samples) - 1:
            time.sleep(stride)
    return samples


def cmd_move(args):
    move_pointer(args.x, args.y, seed=args.seed)
    return 0


def cmd_click(args):
    move_pointer(args.x, args.y, seed=args.seed)
    # A hand pauses over a target before committing to the button.
    time.sleep(hi._rng().uniform(0.060, 0.180))
    q = quartz()
    if args.right:
        post_mouse(q.kCGEventRightMouseDown, args.x, args.y, button=1)
        time.sleep(hi._rng().uniform(0.040, 0.110))
        post_mouse(q.kCGEventRightMouseUp, args.x, args.y, button=1)
    else:
        post_mouse(q.kCGEventLeftMouseDown, args.x, args.y, button=0)
        time.sleep(hi._rng().uniform(0.040, 0.110))
        post_mouse(q.kCGEventLeftMouseUp, args.x, args.y, button=0)
    return 0


def cmd_scroll(args):
    move_pointer(args.x, args.y, seed=args.seed)
    time.sleep(hi._rng().uniform(0.040, 0.120))
    post_scroll(args.notches)
    return 0


def _keycode_for(char):
    """The virtual keycode that types `char`, or None if nothing types it."""
    if char in OPTION_KEYCODES:
        return OPTION_KEYCODES[char][0]
    key = "\n" if char == "\n" else ("\t" if char == "\t" else char.lower())
    if key in KEYCODES:
        return KEYCODES[key]
    for code, shifted in SHIFTED_CHAR.items():
        if shifted == key:
            return code
    return None


def _needs_shift(char):
    if char in OPTION_KEYCODES:
        return OPTION_KEYCODES[char][1]
    code = _keycode_for(char)
    if code is None:
        return False
    return BASE_CHAR.get(code, "") != char


def _needs_option(char):
    return char in OPTION_KEYCODES


def send_event(event, dry_run=False):
    if event["backspace"]:
        label = "BS"
    elif event["char"] == "\n":
        label = "RETURN"
    elif event["shift"] or _needs_shift(event["char"]):
        label = "shift-tap %r" % event["char"]
    else:
        label = "tap %r" % event["char"]
    if dry_run:
        print("%-14s hold=%.3f gap=%.3f" % (label, event["hold"], event["gap"]))
        return

    if event["backspace"]:
        code = KEYCODES["backspace"]
        post_key(code, True)
        time.sleep(event["hold"])
        post_key(code, False)
    elif event["char"] == "\n":
        post_key(KEYCODES["return"], True)
        time.sleep(event["hold"])
        post_key(KEYCODES["return"], False)
    elif event["char"] == "\t":
        post_key(KEYCODES["tab"], True)
        time.sleep(event["hold"])
        post_key(KEYCODES["tab"], False)
    else:
        code = _keycode_for(event["char"])
        if code is None:
            print("human_osx: no key on a US keyboard types %r, skipped" % event["char"],
                  file=sys.stderr)
            time.sleep(event["gap"])
            return
        shift = event["shift"] or _needs_shift(event["char"])
        option = _needs_option(event["char"])
        if shift:
            post_key(SHIFT, True)
            time.sleep(0.012)
        if option:
            post_key(OPTION, True)
            time.sleep(0.012)
        post_key(code, True)
        time.sleep(event["hold"])
        post_key(code, False)
        if option:
            time.sleep(0.012)
            post_key(OPTION, False)
        if shift:
            time.sleep(0.012)
            post_key(SHIFT, False)
    time.sleep(event["gap"])


def cmd_type(args):
    rate = args.typos if args.typos is not None else float(os.environ.get("HI_TYPO_RATE", "0.05"))
    seed = args.seed if args.seed is not None else os.environ.get("HI_SEED")
    seed = int(seed) if seed is not None else None
    events = hi.typing_events(args.text, typo_rate=rate, seed=seed)
    if args.dry_run:
        for event in events:
            send_event(event, dry_run=True)
        return 0
    quartz()
    for event in events:
        send_event(event)
    return 0


def cmd_wander(args):
    """Drift the pointer around where it is for a while, the way a hand does.

    A pointer parked in one pixel for four seconds is the most obvious tell in
    a recorded demo: nobody watches a result without moving. Most of the motion
    is small; every few seconds the hand makes a real reposition.
    """
    import random

    quartz()
    rng = random.Random(args.seed if args.seed is not None else os.environ.get("HI_SEED"))
    x0, y0, width, height = display_bounds()
    right = x0 + width - 3
    bottom = y0 + height - 3
    deadline = time.monotonic() + args.seconds

    while time.monotonic() < deadline:
        current = mouse_position()
        span = args.radius * (rng.uniform(1.5, 4.0) if rng.random() < 0.18
                              else rng.uniform(0.15, 1.0))
        target_x = min(max(current[0] + rng.uniform(-span, span), x0 + 3), right)
        target_y = min(max(current[1] + rng.uniform(-span, span), y0 + 3), bottom)
        move_pointer(target_x, target_y, seed=rng.randrange(1 << 30))
        # HI_MOUSE_SPEED scales the cadence, not the distance. The distance is
        # what sells the movement as a hand; the cadence is just the pause
        # between flicks, and tuning it down is the difference between a
        # pointer that lives and one that looks paused.
        try:
            mspeed = max(0.25, float(os.environ.get("HI_MOUSE_SPEED", "1")))
        except ValueError:
            mspeed = 1.0
        time.sleep(rng.uniform(0.15, 0.65) / mspeed)
    return 0


def cmd_key(args):
    name = args.name.lower()
    if name not in KEYCODES:
        sys.exit("human_osx: unknown key %r (have: %s)" % (args.name, ", ".join(sorted(KEYCODES))))
    # Modifiers go down first and come up last, with a beat between so the
    # shortcut registers the way a key combination typed by hand does.
    if args.command:
        post_key(COMMAND, True)
        time.sleep(0.045)
    post_key(KEYCODES[name], True)
    time.sleep(0.055)
    post_key(KEYCODES[name], False)
    if args.command:
        time.sleep(0.045)
        post_key(COMMAND, False)
    time.sleep(0.06)
    return 0


def cmd_screen(args):
    x, y, w, h = display_bounds()
    if args.verbose:
        print("bounds x=%.0f y=%.0f w=%.0f h=%.0f" % (x, y, w, h))
    print(int(w), int(h))
    return 0


def _run_applescript(script):
    import subprocess

    proc = subprocess.run(
        ["osascript", "-e", script],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return proc.returncode, proc.stdout.decode("utf-8", "replace").strip()


def _frontmost_bundle():
    code, out = _run_applescript(
        'tell application "System Events" to get bundle identifier of '
        "first application process whose frontmost is true"
    )
    return out if code == 0 else ""


def _looks_like_url(target):
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", target)) \
        or target.startswith("localhost") or target.startswith("127.0.0.1")


def cmd_open(args):
    """Open an application or a URL, then wait until it is actually usable.

    Recording a take means driving real apps, and nothing in the pointer and
    keyboard verbs can do that: they post events into whatever is already
    frontmost. This is the verb that puts the right thing in front first.

    A URL goes to the default browser. A bare name is treated as an
    application, launched if it is not running yet, and then held -- activation
    alone is not enough, an app that grabs focus back within a few hundred
    milliseconds would swallow every keystroke after it.

    With --fresh the application is quit first and launched from scratch. That
    is the difference between a reused window and a clean one, and it is more
    than tidiness: a Terminal carried over from the previous take still has
    every variable that take exported and every line it printed. A stale
    OPENCODE_CONFIG_DIR made a test fail on camera during a later take, under a
    line of narration claiming the suite was green, and no gate could see it --
    the gate ran in the vrec process, not in that Terminal.
    """
    target = args.target
    if getattr(args, 'fresh', False) and not _looks_like_url(target):
        _run_applescript('tell application "%s" to quit'
                         % target.replace('"', '\\"'))
        # Quit is asynchronous. Give the process time to actually go away, or
        # the activate below lands on the window we were trying to discard.
        deadline = time.time() + max(args.wait, 0.5) + 5.0
        while time.time() < deadline:
            code, _ = _run_applescript(
                'application "%s" is running' % target.replace('"', '\\"'))
            if code != 0:
                break
            time.sleep(0.2)

    if _looks_like_url(target):
        code, _ = _run_applescript('open location "%s"' % target.replace('"', '\\"'))
        if code != 0:
            print("open: could not open %s" % target, file=sys.stderr)
            return 1
        print("open url %s" % target)
        time.sleep(max(args.wait, 0.5))
        return 0

    code, bundle = _run_applescript(
        'id of application "%s"' % target.replace('"', '\\"')
    )
    if code != 0 or not bundle:
        print('open: no application named "%s"' % target, file=sys.stderr)
        return 1

    _run_applescript('tell application "%s" to activate'
                     % target.replace('"', '\\"'))
    # Launch first when it is not running: activate alone does nothing for a
    # process that has not been started.
    deadline = time.time() + max(args.wait, 0.5) + max(args.launch, 12.0)
    launched = False
    while time.time() < deadline:
        if _frontmost_bundle() == bundle:
            print("open %s (%s)" % (target, bundle))
            return 0
        if not launched:
            # Give the app time to finish launching before deciding it failed.
            time.sleep(0.3)
            launched = True
            continue
        time.sleep(0.2)

    print("open: %s never came to the front (want %s, frontmost %s)"
          % (target, bundle, _frontmost_bundle() or "unknown"), file=sys.stderr)
    return 1


def cmd_shot(args):
    """Write a still of the display, the way a person would screenshot.

    A take that drives a page it has never seen needs to know where the
    buttons are before it clicks them. The bounds are the same ones `screen`
    prints, so a coordinate read off a shot is already in the units `click`
    takes.
    """
    x, y, w, h = display_bounds()
    path = os.path.abspath(args.path)
    parent = os.path.dirname(path)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError as exc:
            print("shot: cannot create %s (%s)" % (parent, exc), file=sys.stderr)
            return 1
    import subprocess

    # -x is the silent flag; without it macOS plays the shutter sound.
    proc = subprocess.run(
        ["screencapture", "-x", "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)),
         path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0 or not os.path.exists(path):
        print("shot: screencapture failed (%s)"
              % proc.stderr.decode("utf-8", "replace").strip(),
              file=sys.stderr)
        return 1
    print("%s %dx%d" % (path, int(w), int(h)))
    return 0


def _screen_grid(size=48):
    """A coarse luminance grid of the display, as a flat list of 0..255.

    Coarse on purpose. An exact hash of the frame never repeats: the terminal
    cursor blinks, so two captures of a screen nobody touched differ. Averaged
    down to a few dozen cells, one blinking cursor changes a fraction of a cell
    and the grid stays put -- while a line of new output still moves it plenty.
    """
    import subprocess
    import tempfile

    x, y, w, h = display_bounds()
    fd, raw = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    fd, small = tempfile.mkstemp(suffix=".bmp")
    os.close(fd)
    try:
        proc = subprocess.run(
            ["screencapture", "-x", "-t", "png",
             "-R%d,%d,%d,%d" % (int(x), int(y), int(w), int(h)), raw],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if proc.returncode != 0:
            return None
        subprocess.run(["sips", "-Z", str(size * 4), "-s", "format", "bmp",
                        raw, "--out", small],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with open(small, "rb") as handle:
            data = handle.read()
        return _bmp_grid(data)
    except Exception:
        return None
    finally:
        for path in (raw, small):
            try:
                os.unlink(path)
            except OSError:
                pass


def _bmp_grid(data):
    """Average a BMP down to size x size luminance cells. None if unreadable."""
    if len(data) < 54 or data[:2] != b"BM":
        return None
    offset = int.from_bytes(data[10:14], "little")
    width = int.from_bytes(data[18:22], "little")
    # Height is signed: a negative value means rows are stored bottom-up.
    # Read unsigned and abs() turns -120 into 4294967176, which collapses the
    # whole screen into a single cell -- and a one-cell comparison "settles"
    # instantly and silently, which looks like it works.
    height = int.from_bytes(data[22:26], "little", signed=True)
    bits = int.from_bytes(data[28:30], "little")
    if bits not in (8, 24, 32):
        return None
    flip = height > 0
    height = abs(height)
    stride = width * (bits // 8)
    step = max(1, height // 48)
    cells = []
    for y in range(0, height, step):
        base = offset + y * stride
        if base + stride > len(data):
            break
        acc = count = 0
        for x in range(0, width, step):
            i = base + x * (bits // 8)
            if bits == 8:
                acc += data[i]
            else:
                acc += (data[i + 2] * 3 + data[i + 1] * 6 + data[i]) // 10
            count += 1
        cells.append(acc // max(1, count))
    if flip:
        cells.reverse()
    return cells


def _grid_diff(a, b):
    """Mean absolute difference between two grids, or None if incomparable."""
    if not a or not b or len(a) != len(b):
        return None
    total = sum(abs(x - y) for x, y in zip(a, b))
    return total / float(len(a))


def cmd_wait_settled(args):
    """Block until the screen stops changing, wandering the pointer meanwhile.

    Takes used to end every beat with `hi_idle 9` -- a guess at how long a
    command takes. Those guesses are wrong in both directions: a cold `npm test`
    outruns them and the take reads as frozen, and a fast command gets the next
    beat typed over its own output.

    Watching instead of guessing. Comparing a coarse luminance grid tolerates a
    blinking cursor, which defeats an exact hash. The pointer drifts between
    samples so waiting never reads as dead screen time, and the return is
    immediate -- there is no fixed hold left to trim.
    """
    import time

    timeout = getattr(args, "timeout", 90.0)
    stable_needed = getattr(args, "samples", 2)
    floor = getattr(args, "floor", 1.0)
    radius = getattr(args, "radius", 90.0)

    began = time.time()
    deadline = began + timeout
    previous = None
    same = 0

    while True:
        # Drift the pointer instead of sleeping. Waiting is the part a viewer
        # reads as dead time, and it does not have to be.
        try:
            move_pointer(rng.uniform(0, radius), rng.uniform(0, radius))
        except Exception:
            pass
        time.sleep(0.35)

        current = _screen_grid()
        if current is None:
            # No screen recording permission or no display. Say so rather than
            # spin to the timeout.
            sys.stderr.write("screen capture unavailable — is Screen "
                             "Recording enabled for the terminal?\n")
            return 2

        if previous is None:
            same = 1
        else:
            diff = _grid_diff(previous, current)
            # A blinking cursor moves a fraction of a cell; a line of output
            # moves many. This threshold sits between the two by a wide margin.
            same = same + 1 if (diff is not None and diff < 1.5) else 1
        previous = current

        if same >= stable_needed and (time.time() - began) >= floor:
            return 0
        if time.time() >= deadline:
            sys.stderr.write("no settle within %.0fs\n" % timeout)
            return 1


def accessibility_trusted():
    """Ask the Accessibility subsystem whether we may post input events.

    AXIsProcessTrusted lives in ApplicationServices, which PyObjC does not
    wrap, so it is called through ctypes rather than pulling in another
    framework package.
    """
    import ctypes
    import ctypes.util

    path = ctypes.util.find_library("ApplicationServices") or \
        "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
    lib = ctypes.cdll.LoadLibrary(path)
    lib.AXIsProcessTrusted.restype = ctypes.c_bool
    return bool(lib.AXIsProcessTrusted())


# -------------------------------------------------------------- input source

ABC = "com.apple.keylayout.ABC"


def _tis():
    """Bind the Text Input Services calls we need, through ctypes.

    PyObjC does not wrap TIS, so this is hand-wired against Carbon.framework.
    The property keys are read out of the framework as the real CFStringRef
    globals rather than rebuilt as literals -- passing a fresh equal string
    makes TISGetInputSourceProperty come back empty.
    """
    import ctypes
    import ctypes.util

    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    lib = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Carbon"))

    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    cf.CFBooleanGetValue.restype = ctypes.c_bool
    cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetCount.restype = ctypes.c_long
    cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
    cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
    cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]

    lib.TISCreateInputSourceList.restype = ctypes.c_void_p
    lib.TISCreateInputSourceList.argtypes = [ctypes.c_void_p, ctypes.c_bool]
    lib.TISGetInputSourceProperty.restype = ctypes.c_void_p
    lib.TISGetInputSourceProperty.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.TISSelectInputSource.argtypes = [ctypes.c_void_p]

    return cf, lib


def _cf_string(cf, pointer):
    import ctypes

    if not pointer:
        return None
    buffer = ctypes.create_string_buffer(256)
    if cf.CFStringGetCString(pointer, buffer, 256, 0x08000100):
        return buffer.value.decode(errors="replace")
    return None


def input_sources():
    """Every source macOS knows about, as (id, selected) pairs."""
    import ctypes

    cf, lib = _tis()
    key_id = ctypes.c_void_p.in_dll(lib, "kTISPropertyInputSourceID")
    key_selected = ctypes.c_void_p.in_dll(lib, "kTISPropertyInputSourceIsSelected")
    found = []
    array = lib.TISCreateInputSourceList(None, True)
    if not array:
        return found
    for index in range(cf.CFArrayGetCount(array)):
        source = cf.CFArrayGetValueAtIndex(array, index)
        if not source:
            continue
        ident = _cf_string(cf, lib.TISGetInputSourceProperty(source, key_id))
        flag = lib.TISGetInputSourceProperty(source, key_selected)
        selected = bool(flag) and cf.CFBooleanGetValue(flag)
        if ident:
            found.append((ident, selected))
    return found


def current_input_source():
    """The id of the source that is actually in use, or None."""
    selected = [ident for ident, on in input_sources() if on]
    return selected[0] if selected else None


def select_input_source(wanted):
    """Make `wanted` the active input source. Returns the id in use after."""
    import ctypes

    cf, lib = _tis()
    array = lib.TISCreateInputSourceList(None, True)
    if not array:
        return None
    for index in range(cf.CFArrayGetCount(array)):
        source = cf.CFArrayGetValueAtIndex(array, index)
        if not source:
            continue
        key_id = ctypes.c_void_p.in_dll(lib, "kTISPropertyInputSourceID")
        if _cf_string(cf, lib.TISGetInputSourceProperty(source, key_id)) == wanted:
            lib.TISSelectInputSource(source)
            break
    return current_input_source()


def cmd_locale(args):
    """Report the input source, and switch to English for the typing to land.

    With a Vietnamese input source in Telex or VNI, a posted s turns into an
    acute accent and a posted c into a ư, so the recording shows mangled text
    and the mistyped-then-erased correction deletes a real character. Nothing
    about that is visible until it is on screen, so it is checked here.
    --check only reports, which is what the doctor wants.
    """
    before = current_input_source()
    print("input source: %s" % (before or "unknown"))
    if before == args.to:
        print("layout: %s" % before)
        return 0
    if args.check:
        print("layout: %s" % (before or "none"))
        print("not English — typed text would come out in the wrong layout",
              file=sys.stderr)
        return 1
    after = select_input_source(args.to)
    print("selected: %s" % (after or "none"))
    print("layout: %s" % (after or "none"))
    if after == args.to:
        return 0
    print("could not switch to %s -- the typed text may come out in the wrong layout" % args.to,
          file=sys.stderr)
    return 1


def cmd_doctor(args):
    try:
        import Quartz
        quartz_state = "ok"
    except ImportError:
        Quartz = None
        quartz_state = "missing"

    print("Quartz: %s" % quartz_state)
    if Quartz is not None:
        trusted = accessibility_trusted()
        print("Accessibility: %s" % ("ok" if trusted else "denied"))
        x, y, w, h = display_bounds()
        print("Display: %.0fx%.0f points at %.0f,%.0f" % (w, h, x, y))
        px, py = mouse_position()
        print("Cursor: %.0f,%.0f" % (px, py))
    else:
        print("Accessibility: unknown (no Quartz)")
    return 0 if quartz_state == "ok" else 1


def build_parser():
    parser = argparse.ArgumentParser(prog="human_osx", description=__doc__.splitlines()[0])
    parser.add_argument("--seed", type=int, default=None, help="deterministic path/typing")
    sub = parser.add_subparsers(dest="command")

    p = sub.add_parser("move", help="walk the pointer to a point")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.set_defaults(func=cmd_move)

    p = sub.add_parser("click", help="move then click")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--right", action="store_true")
    p.set_defaults(func=cmd_click)

    p = sub.add_parser("scroll", help="move then scroll")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("notches", type=int)
    p.set_defaults(func=cmd_scroll)

    p = sub.add_parser("type", help="type text with human rhythm")
    p.add_argument("text")
    p.add_argument("--typos", type=float, default=None)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_type)

    p = sub.add_parser("wander", help="drift the pointer around, the way a hand does")
    p.add_argument("seconds", type=float)
    p.add_argument("--radius", type=float, default=90.0)
    p.set_defaults(func=cmd_wander)

    p = sub.add_parser("key", help="press a named key")
    p.add_argument("name")
    p.add_argument("--command", action="store_true", help="hold Command down")
    p.set_defaults(func=cmd_key)

    p = sub.add_parser("screen", help="print display bounds in points")
    p.add_argument("--verbose", action="store_true")
    p.set_defaults(func=cmd_screen)

    p = sub.add_parser("wait-settled",
                       help="block until the screen stops changing, "
                            "wandering the pointer meanwhile")
    p.add_argument("--timeout", type=float, default=90.0)
    p.add_argument("--samples", type=int, default=3)
    p.add_argument("--floor", type=float, default=1.2,
                   help="never return before this many seconds")
    p.add_argument("--radius", type=float, default=90.0)
    p.set_defaults(func=cmd_wait_settled)

    p = sub.add_parser("locale", help="show the input source, switch to English")
    p.add_argument("--to", default=ABC, help="input source id to select")
    p.add_argument("--check", action="store_true", help="report only, never switch")
    p.set_defaults(func=cmd_locale)

    p = sub.add_parser("open", help="open an application or a URL and wait for it")
    p.add_argument("target")
    p.add_argument("--wait", type=float, default=1.2,
                   help="settle time after it is in front")
    p.add_argument("--launch", type=float, default=12.0,
                   help="seconds to allow a cold app to launch")
    p.add_argument("--fresh", action="store_true", default=False,
                   help="quit the app first, so it starts with no leftover "
                        "state from the last take")
    p.set_defaults(func=cmd_open)

    p = sub.add_parser("shot", help="write a still of the display to a file")
    p.add_argument("path")
    p.set_defaults(func=cmd_shot)

    p = sub.add_parser("doctor", help="check Quartz and Accessibility")
    p.set_defaults(func=cmd_doctor)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.seed is None and os.environ.get("HI_SEED"):
        args.seed = int(os.environ["HI_SEED"])
    if not getattr(args, "func", None):
        parser.print_help()
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())