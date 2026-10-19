#!/usr/bin/env python3
"""Give Terminal an opaque look for the duration of a recording.

A translucent Terminal window does not read as a terminal in a video: the
desktop, the browser and whatever else is behind it show through, and all of
it lands in the finished recording. The fix belongs to the recording, not to
the user's preferences, so this works on a copy.

  ensure    create the opaque profile and make it the default
  apply     point the front window at it
  restore   put the original default back

The profile is a copy of the user's current default with the background
colour and blur removed, which falls back to Terminal's opaque default
background. Nothing the user set is overwritten.
"""

import plistlib
import subprocess
import sys

DOMAIN = "com.apple.Terminal"
DEFAULT_KEY = "Default Window Settings"
PROFILE = "vrec-opaque"
SAVED_KEY = "VREC-SavedDefaultProfile"
ORIGINAL_KEY = "VREC-OriginalProfile"


def read_settings():
    # `defaults read` prints the old-style plist that Python 3.12 can no longer
    # parse; `defaults export` gives XML, which it can.
    out = subprocess.run(
        ["defaults", "export", DOMAIN, "-"],
        capture_output=True,
    )
    if out.returncode != 0:
        return None
    whole = plistlib.loads(out.stdout)
    return whole


def write_settings(whole):
    payload = plistlib.dumps(whole, fmt=plistlib.FMT_XML)
    subprocess.run(["defaults", "import", DOMAIN, "-"],
                   input=payload, check=True)


def read_saved_default():
    out = subprocess.run(["defaults", "read", DOMAIN, DEFAULT_KEY],
                         capture_output=True, text=True)
    name = out.stdout.strip() if out.returncode == 0 else ""
    return name or "Basic"


def read_saved_original():
    """The profile the user had before vrec ever touched this, if it is known."""
    out = subprocess.run(["defaults", "read", DOMAIN, ORIGINAL_KEY],
                         capture_output=True, text=True)
    name = out.stdout.strip() if out.returncode == 0 else ""
    return name or None


def opaque_background():
    """An NSColor blob for the profile, dark and fully opaque.

    Terminal stores its background as an archived NSColor, so it has to be
    produced by the same archiver rather than written as plain plist bytes.
    Without an explicit colour the profile falls back to Terminal's default,
    which is a light background on this system and looks nothing like the
    terminal a client expects to see in a demo.
    """
    try:
        from AppKit import NSColor
        from Foundation import NSKeyedArchiver
    except ImportError:
        return None
    color = NSColor.colorWithSRGBRed_green_blue_alpha_(0.06, 0.07, 0.09, 1.0)
    # plistlib writes plain bytes as <data>; an NSData object it cannot.
    return bytes(NSKeyedArchiver.archivedDataWithRootObject_(color))


def ensure():
    whole = read_settings()
    if whole is None:
        print("terminal_profile: cannot read the Terminal settings", file=sys.stderr)
        return 1

    settings = whole.get("Window Settings") or {}
    # Copy the user's real profile, not our own one from a previous run.
    # After the first recording the saved default is vrec-opaque, and copying
    # that would drop everything the user had configured.
    source = read_saved_original() or read_saved_default()
    profile = dict(settings.get(source) or settings.get("Basic") or {})
    # Dropping the colour and the blur is what makes it opaque; everything
    # else about the profile is left as the user had it.
    profile.pop("BackgroundColor", None)
    profile.pop("BackgroundBlur", None)
    background = opaque_background()
    if background is not None:
        profile["BackgroundColor"] = background
    profile["name"] = PROFILE
    profile["type"] = "Window Settings"
    settings[PROFILE] = profile
    whole["Window Settings"] = settings

    # Record the user's real profile once, and never overwrite it afterwards.
    if not read_saved_original():
        subprocess.run(["defaults", "write", DOMAIN, ORIGINAL_KEY, "-string", source], check=True)
    subprocess.run(["defaults", "write", DOMAIN, SAVED_KEY, "-string", source], check=True)
    write_settings(whole)
    subprocess.run(["defaults", "write", DOMAIN, DEFAULT_KEY, "-string", PROFILE], check=True)
    print("terminal_profile: using opaque profile %r (was %r)" % (PROFILE, source))
    return 0


def restore():
    out = subprocess.run(["defaults", "read", DOMAIN, SAVED_KEY],
                         capture_output=True, text=True)
    previous = out.stdout.strip() if out.returncode == 0 else ""
    if not previous:
        print("terminal_profile: nothing saved, leaving the default alone")
        return 0
    subprocess.run(["defaults", "write", DOMAIN, DEFAULT_KEY, "-string", previous], check=True)
    subprocess.run(["defaults", "delete", DOMAIN, SAVED_KEY], check=False)
    print("terminal_profile: default profile restored to %r" % previous)
    return 0


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "ensure"
    handler = {"ensure": ensure, "restore": restore}.get(action)
    if handler is None:
        sys.exit("usage: terminal_profile.py [ensure|restore]")
    sys.exit(handler())