#!/usr/bin/env python3
"""Human-like pointer and typing kinematics.

Ported from artemindubai/human-input (MIT) -- https://github.com/artemindubai/human-input
Upstream couples this math to xdotool on X11. Only the geometry and timing are
kept here; the driver that posts the events lives in human_osx.py.

Copyright (c) upstream authors. MIT licensed, see
https://github.com/artemindubai/human-input/blob/main/LICENSE

Standard library only.
"""

import math
import os
import random

# Target width for Fitts's law. A browser button or a terminal character is
# roughly this big, and the constant that matters is only that it is stable.
TARGET_WIDTH = 32.0

MIN_TRAVEL_TIME = 0.35
MAX_TRAVEL_TIME = 1.60

# QWERTY neighbours, used to pick the wrong key a human would hit by accident.
_NEIGHBOURS = {
    "a": "sqwz", "b": "vghn", "c": "xdfv", "d": "serfcx", "e": "wsdr",
    "f": "drtgvc", "g": "ftyhbv", "h": "gyujnb", "i": "ujko", "j": "huikmn",
    "k": "jiolm", "l": "kop", "m": "njk", "n": "bhjm", "o": "iklp",
    "p": "ol", "q": "wa", "r": "edft", "s": "awedxz", "t": "rfgy",
    "u": "yhji", "v": "cfgb", "w": "qase", "x": "zsdc", "y": "tghu",
    "z": "asx",
    "0": "9", "1": "2", "2": "13", "3": "24", "4": "35", "5": "46",
    "6": "57", "7": "68", "8": "79", "9": "0", "-": "_=", "=": "-",
    "[": "]", "]": "[", ";": "'l", "'": ";", ",": ".m", ".": ",m",
    "/": ".", "\\": "|", "; ": None,
}


def _rng(seed=None):
    """A generator seeded by HI_SEED when the caller did not pick one.

    A fixed seed makes a recorded take reproducible, which is the only reason
    this reads an environment variable at all.
    """
    if seed is not None:
        return random.Random(seed)
    env = os.environ.get("HI_SEED")
    return random.Random(int(env) if env else None)


def ease_out_cubic(t):
    """Fast at first, settling at the end -- how a hand actually arrives."""
    return 1.0 - (1.0 - t) ** 3


def fitts_time(distance, width=TARGET_WIDTH):
    """Shannon form of Fitts's law: log2 of the index of difficulty."""
    return 0.05 + 0.13 * math.log2(distance / width + 1.0)


def _bezier(p0, p1, p2, steps, t_of):
    points = []
    for i in range(steps + 1):
        t = t_of(i / steps)
        u = 1.0 - t
        points.append(
            (
                u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
            )
        )
    return points


def path(x0, y0, x1, y1, seed=None, tremor=True):
    """Pointer samples from (x0, y0) to (x1, y1), last sample exactly the target.

    The curve is a quadratic bezier with the control point pushed off the
    straight line, timed by Fitts's law, eased out, and -- for a long trip --
    finished with a small overshoot and a short correction back onto target.
    """
    rng = _rng(seed)
    dx, dy = x1 - x0, y1 - y0
    distance = math.hypot(dx, dy)
    if distance < 3:
        return [(x1, y1)]

    ux, uy = dx / distance, dy / distance
    travel = min(MAX_TRAVEL_TIME, max(MIN_TRAVEL_TIME, fitts_time(distance)))

    def control(a, b, spread):
        offset = rng.uniform(-spread, spread)
        return ((a[0] + b[0]) / 2.0 - uy * offset, (a[1] + b[1]) / 2.0 + ux * offset)

    steps = max(24, int(distance / 12))
    overshoot = rng.uniform(0.08, 0.16) * distance if distance > 90 else 0.0
    far = (x1 + ux * overshoot, y1 + uy * overshoot)

    raw = _bezier((x0, y0), control((x0, y0), far, min(120.0, 0.25 * distance)), far, steps, ease_out_cubic)
    if overshoot:
        raw += _bezier(
            far,
            control(far, (x1, y1), min(18.0, 0.06 * distance))[0:2],
            (x1, y1),
            max(6, steps // 6),
            ease_out_cubic,
        )[1:]

    if tremor:
        amplitude = rng.uniform(2.0, 4.0)
        frequency = rng.uniform(0.8, 1.6)
        phase = rng.uniform(0.0, 2 * math.pi)

    points = []
    last = len(raw) - 1
    for i, (px, py) in enumerate(raw):
        if i == last:
            points.append((x1, y1))
            continue
        if tremor:
            # Drift fades out on the correction leg so the landing is clean.
            fade = min(1.0, (last - i) / max(1.0, steps * 0.35))
            wave = amplitude * fade * math.sin(2 * math.pi * frequency * (i / last) + phase)
            px += -uy * wave + rng.uniform(-0.5, 0.5)
            py += ux * wave + rng.uniform(-0.5, 0.5)
        points.append((int(round(px)), int(round(py))))

    points[-1] = (x1, y1)
    return points


def typing_speed():
    """Keystroke speed multiplier, from HI_TYPE_SPEED (default 1.0).

    The defaults below put a normal character at roughly 0.22s and a space at
    roughly 0.50s, which is right for realism and wrong for a five-minute take:
    a 52-character command line costs about fourteen seconds to type, and a
    nine-command take spends two minutes doing nothing but letters appearing.

    Scaling multiplies the sampled durations rather than narrowing the ranges,
    so the distribution keeps its shape and the recording still reads as typed.
    """
    try:
        speed = float(os.environ.get("HI_TYPE_SPEED", "1"))
    except ValueError:
        speed = 1.0
    return max(0.1, speed)


def key_timing(char, rng=None):
    """Hold and gap for one keystroke, in seconds.

    Hold is the key-down duration. Gap is the wait before the next key.
    Spaces and sentence punctuation get a longer gap because a typist's hand
    pauses there, and capitals cost extra because of the shift.
    """
    rng = rng or _rng()
    speed = typing_speed()
    # Hold has a floor even at high speed. A key held for less than about a
    # quarter of a frame register unreliably in Terminal.app, and hi_type
    # presses Return by itself -- a dropped character therefore runs a command
    # the take never typed.
    hold = rng.uniform(0.045, 0.120)
    gap = rng.uniform(0.055, 0.220)
    shift = char.isupper() or char in "!@#$%^&*()_+{}|:\"<>?~"
    if shift:
        hold += rng.uniform(0.020, 0.060)
        gap *= rng.uniform(1.10, 1.35)
    if char == " ":
        gap += rng.uniform(0.150, 0.400)
    if char in ".,;:!?":
        gap += rng.uniform(0.100, 0.260)
    if char.isdigit():
        gap *= rng.uniform(0.90, 1.10)
    # Speed divides. Multiplying here was the first version and it made typing
    # slower the faster you asked for it, which is exactly the sort of thing
    # that survives because nobody times a recording with a stopwatch.
    hold = max(0.025, hold / speed)
    return {"hold": hold, "gap": max(0.010, gap / speed), "shift": shift}


def neighbour_key(char):
    """The key a typist is most likely to hit instead, or None if isolated."""
    options = _NEIGHBOURS.get(char.lower())
    if not options:
        return None
    rng = _rng()
    return rng.choice(sorted(options))


def typing_events(text, typo_rate=0.05, seed=None):
    """The keystroke sequence a person produces for `text`.

    Each event is a dict: char, shift, backspace, hold, gap. A typo is the
    wrong neighbour key followed by a Backspace, which is the thing that makes
    a recording read as typed rather than pasted.

    The typo rate falls with speed. At triple speed a 5% rate means a correction
    every fourth keystroke, and a pause that long after a short keystroke is
    what makes fast typing look broken rather than quick.
    """
    rng = _rng(seed)
    speed = typing_speed()
    typo_rate = typo_rate / speed
    events = []
    for char in text:
        if char != " " and rng.random() < typo_rate:
            wrong = neighbour_key(char)
            if wrong:
                timing = key_timing(wrong, rng)
                events.append({
                    "char": wrong, "shift": wrong.isupper(), "backspace": False,
                    "hold": timing["hold"], "gap": timing["gap"], "typo": True,
                })
                # The beat where the typist notices. Without it the correction
                # reads as instant and mechanical.
                events.append({
                    "char": None, "shift": False, "backspace": True,
                    "hold": rng.uniform(0.030, 0.070),
                    "gap": rng.uniform(0.180, 0.520), "typo": False,
                })
        timing = key_timing(char, rng)
        events.append({
            "char": char, "shift": timing["shift"], "backspace": False,
            "hold": timing["hold"], "gap": timing["gap"], "typo": False,
        })
    return events


if __name__ == "__main__":
    pts = path(0, 0, 640, 400, seed=1)
    print("samples", len(pts), "last", pts[-1])
    for event in typing_events("npm run dev", seed=1):
        print(("BS" if event["backspace"] else repr(event["char"])), round(event["hold"], 3), round(event["gap"], 3))