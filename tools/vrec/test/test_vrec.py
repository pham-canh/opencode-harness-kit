"""Tests for vrec's pure logic — the parts that can be checked without a screen.

These exist because six defects in this tool were invisible to every existing
check. A typing speed multiplier that made typing slower passed syntax checks and
ran fine in the smoke test that used it at the wrong speed. A screen-fingerprint
comparison that resolved to a single cell returned "settled" instantly and
correctly, forever, because a one-cell comparison is trivially stable. Neither
could have been caught by watching the tool run.

Run with:  .venv/bin/python -m pytest test/
"""

import importlib.util
import os
import pathlib
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ROOT / "lib"
# importlib.reload resolves a spec by importing the name afresh, which fails for
# a module loaded by path alone. Putting lib/ on the path lets reload work,
# which the speed tests need -- they vary HI_TYPE_SPEED and re-read the module.
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))


def _load(name):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "lib" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def human_input():
    os.environ["HI_TYPE_SPEED"] = "1"
    return _load("human_input")


@pytest.fixture
def human_osx():
    return _load("human_osx")


# --- typing ---------------------------------------------------------------

def test_speed_one_is_unchanged_by_default(human_input):
    """HI_TYPE_SPEED must not move the default. Existing takes were authored
    against it, and silently retiming them is how a take stops matching its
    own rehearsal."""
    os.environ["HI_TYPE_SPEED"] = "1"
    t = human_input.key_timing("a")
    assert 0.04 <= t["hold"] <= 0.13
    assert 0.05 <= t["gap"] <= 0.23


def test_faster_typing_is_actually_faster(human_input):
    """The first version multiplied the timings instead of dividing them, so
    asking for speed produced a slower recording. That bug passed every
    syntax check and would have passed any test that only asserted the
    numbers changed."""
    def total(speed):
        os.environ["HI_TYPE_SPEED"] = speed
        import importlib
        importlib.reload(human_input)
        return sum(e["hold"] + e["gap"] for e in
                   human_input.typing_events("npm test", seed=3))

    slow, fast = total("1"), total("3")
    assert fast < slow, f"speed=3 took {fast:.2f}s, slower than speed=1 at {slow:.2f}s"


def test_hold_never_drops_below_the_floor(human_input):
    """Terminal.app drops sub-frame key presses, and the type helper presses
    Return by itself -- so a dropped character runs a command the take never
    typed. The floor is the only thing preventing that."""
    for speed in ("1", "4", "20"):
        os.environ["HI_TYPE_SPEED"] = speed
        import importlib
        importlib.reload(human_input)
        holds = [e["hold"] for e in human_input.typing_events(
            "export PATH=/usr/local/bin", seed=11)]
        assert min(holds) >= 0.025, f"speed {speed} produced hold {min(holds)}"


def test_typing_a_string_reproduces_it_exactly(human_input):
    os.environ["HI_TYPE_SPEED"] = "1"
    import importlib
    importlib.reload(human_input)
    text = "node bin/oc-harness.mjs use space-bunny-free --yes"
    typed = "".join(e["char"] for e in human_input.typing_events(text, typo_rate=0)
                    if not e.get("backspace"))
    assert typed == text


# --- screen fingerprint ---------------------------------------------------

def test_bmp_grid_has_many_cells(human_osx):
    """A bottom-up BMP stores height as a negative int32. Read unsigned, abs()
    turns -120 into 4294967176, and the whole screen collapses to one cell --
    which then compares equal to itself and reports "settled" forever."""
    import struct
    width, height, bits, offset = 64, -48, 24, 54
    stride = width * (bits // 8)
    body = bytearray()
    for y in range(abs(height)):
        for x in range(width):
            i = y * stride + x * 3
            body += bytes([x * 3 % 256, y * 5 % 256, (x + y) % 256])
    header = b"BM" + struct.pack("<IHHI", 54 + len(body), 0, 0, offset)
    header += struct.pack("<IiiHHIIiiII", 40, width, height, 1, bits,
                          0, len(body), 0, 0, 0, 0)
    grid = human_osx._bmp_grid(header + bytes(body))
    assert grid is not None and len(grid) == 48, f"got {len(grid or [])} cells"


def test_grid_diff_separates_a_blink_from_a_line_of_output(human_osx):
    """The threshold has to sit between a blinking cursor and real output.
    Measured on a real display: ~0.05 for a cursor, ~44 for a line of text."""
    quiet_a = [100, 100, 100, 100]
    quiet_b = [100, 100, 100, 100]
    changed = [100, 100, 160, 100]
    assert human_osx._grid_diff(quiet_a, quiet_b) == 0.0
    assert human_osx._grid_diff(quiet_a, changed) > 1.5


def test_grid_diff_refuses_to_compare_mismatched_grids(human_osx):
    """A None difference must not read as zero, or a screen that failed to
    capture would look identical to itself and settle immediately."""
    assert human_osx._grid_diff([1, 2, 3], [1, 2]) is None
    assert human_osx._grid_diff(None, [1, 2, 3]) is None


# --- take scripts ---------------------------------------------------------

@pytest.mark.parametrize("name", ["space-harness", "_smoke-speed"])
def test_takes_are_syntactically_valid(name):
    path = ROOT / "takes" / (name + ".sh")
    assert path.exists(), f"{name} take is missing"
    result = subprocess.run(["bash", "-n", str(path)],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("name", ["space-harness", "_smoke-speed"])
def test_takes_type_only_ascii(name):
    """The type helper presses Return itself, so a character the US layout
    cannot produce is silently dropped mid-line and the rest of the command
    runs against a broken quote."""
    path = ROOT / "takes" / (name + ".sh")
    for number, line in enumerate(path.read_text().splitlines(), 1):
        stripped = line.strip()
        if not (stripped.startswith("hi_run type") or
                stripped.startswith("vis ") or
                stripped.startswith('vis "')):
            continue
        body = line
        assert body.isascii(), f"{name}.sh:{number} types a non-ASCII character"