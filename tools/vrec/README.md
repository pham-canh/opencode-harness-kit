# vrec — verified screen recording for client demo videos

Built after losing a 3-hour assessment to three avoidable failures: a recorder
that silently wrote a 0.05-second file, a pixel format no player would open, and
six overlapping Terminal windows because a new one was opened for every step.

The design rule is simple: **anything that can fail, fails in the first ten
seconds — before the hour is spent.**

## Quick start

```bash
export PATH="$HOME/harness/tools/vrec/bin:$PATH"

vrec doctor                          # 10-second environment check
vrec record --preset web3-marketplace
vrec verify ~/Desktop/demo.mp4
vrec cut ~/Desktop/demo.mp4 00:06:30
```

## Before you record

The capture is the whole display, so a window that grabs the keyboard takes
your typed keystrokes with it and the take fails later with a symptom that has
nothing to do with the cause — a health check that times out, a blank screen,
a page that never loaded.

```bash
vrec doctor        # must print zero 'bad' lines
```

`doctor` reports the two conditions that produce exactly this, and both are
worth reading rather than ignoring:

- **`no emoji viewer / dictation panel holding the keyboard`** — the Globe key
  opens the emoji viewer and a second press raises the Dictation prompt. Either
  one owns the keyboard, so every later `npm run dev` is typed into it. Escape
  the panel and dismiss the prompt, then rerun. It checks for a *window*, not
  the process: `CoreServicesUIAgent` always runs, and only owning a window
  makes it a problem.
- **`these ports are already taken`** — only a warning. A take kills its own
  leftovers by name, but a chain left over from an earlier run will be reused
  instead of the fresh one, and the demo then runs against state you did not
  start.

Then, in the take itself:

- `beat_setup` must call **`hi_stage`**, not `hi_open "Terminal"`. `hi_open`
  leaves every other Terminal window on screen, so the recording shows a stack
  of terminals instead of the one thing being demonstrated. `hi_stage` closes
  the extras, sizes what is left to the display, and re-asserts focus.
- `wait_for` watches who owns the keyboard while it waits. If focus leaves the
  terminal it stops immediately and names the app, instead of sitting silent
  for 90 seconds and then blaming a port that was never opened.

## What makes it different

**`doctor` proves the encoder works before you start.**
It records a real 3-second clip and reads its duration back. A machine with
Screen Recording consent missing, or a broken ffmpeg build, fails here — not
after setup.

**`preflight` proves your demo works before you start.**
For the web3 preset that means: the chain answers RPC, the backend reports
`"connected":true`, the frontend port is listening, the listing is on chain, and
the seed-only model is *not*. It also refuses to record if `totalLicensesSold`
isn't `0`, because otherwise the buy-then-read shot can't show `0 → 1`.

**`record` refuses to produce a file you can't send.**
`rec_start` polls until the output actually exceeds 64 KB. A recorder that
isn't writing frames aborts in under 20 seconds. Afterwards `verify` rejects
anything under 1 second or not in `yuv420p`.

**`cut` is stream copy.**
`-c copy` — instant, no re-encode, no quality loss.

## The pixel format trap

The avfoundation screen device **cannot take `yuv420p` as input**. It offers
`nv12`, `uyvy422`, `yuyv422`, `0rgb`, `bgr0`. Recording with `-pix_fmt yuv422p`
produces a file QuickTime silently refuses to open.

The working pipeline is capture `nv12`, encode `yuv420p`:

```bash
ffmpeg -f avfoundation -capture_cursor 1 -framerate 30 -i "0:none" \
  -pix_fmt nv12 -c:v libx264 -pix_fmt yuv420p out.mp4
```

## Human input — the recording looks like a person

A pasted command and a frozen pointer make a demo video read as a machine
driving a machine. vrec drives the real input instead: the pointer walks a
curve and lands on the target, keys are held for a human length of time, and a
mistyped character is erased with Backspace rather than never having happened.

```bash
vrec doctor                      # checks Quartz, Accessibility, layout, display
vrec screen                      # 1440 900 — the units move/click use
vrec move 720 450                # walk the pointer there along a curve
vrec click 720 450               # move, settle, click
vrec scroll 720 450 -3           # move, then scroll 3 notches up
vrec type "npm run dev"          # human rhythm, typos included, then Return
vrec type --dry-run "npm run dev"  # print the keystroke timeline, post nothing
vrec type --plain "npm run dev"  # old AppleScript path, no venv needed
vrec locale                      # input source in use, switches to English
```

Inside a preset the same verbs are available as `hi_move`, `hi_click`,
`hi_scroll`, `hi_type`, `hi_focus`, `hi_fill`.

**Coordinates are points, not pixels.** On a 2880×1800 Retina display
`vrec screen` prints `1440 900`, so every coordinate is half what a screenshot
shows. Presets use points everywhere for this reason.

### One-time setup

```bash
bash tools/vrec/lib/setup_env.sh    # venv + pyobjc-framework-Quartz
```

Then grant **System Settings → Privacy & Security → Accessibility** to the
terminal running the recording. Without it `CGEvent` posts are dropped
silently: the video looks fine and the cursor simply never moves. `vrec doctor`
checks this and says so plainly.

### The Vietnamese keyboard trap

With a Vietnamese input source in Telex, a posted `s` comes out as an acute
accent, a posted `c` as `ư`, and the mistyped-then-erased correction deletes a
real character. The recording plays fine and is wrong the whole way through.

`vrec record` selects `com.apple.keylayout.ABC` before the first shot, and
`vrec doctor` warns when the layout is not English. Override with
`VREC_EXCLUDE_LEFT`-style env knobs — for the layout it is `HI_FOCUS_APP`,
for the typo rate `HI_TYPO_RATE`.

### Making it repeatable

| Variable | Effect |
|---|---|
| `HI_SEED=7` | fixes the pointer path and the typos, so a retake is identical |
| `HI_TYPO_RATE=0.05` | chance a keystroke is a typo that gets erased; `0` for clean typing |
| `HI_FOCUS_APP` | app `hi_type` focuses before typing (default `Terminal`) |
| `HI_FOCUS_TRIES` | how hard to hold focus before giving up |

### Speed, and why not to use it

| Variable | Effect |
|---|---|
| `wait_settle [timeout]` | end a beat by watching the screen instead of guessing |
| `VREC_SPEED` | scales every `hi_idle` hold; `1.0` default |
| `HI_TYPE_SPEED` | scales keystroke hold and gap; `1.0` default |
| `HI_MOUSE_SPEED` | scales the pause between pointer moves |
| `VREC_FRESH_WINDOW` | `1` default: `hi_stage` quits the app and relaunches it |
| `VREC_SETTLE_SAMPLES` / `_FLOOR` | consecutive unchanged samples, and the earliest a beat may end |

`wait_settle` is the one worth reaching for. A fixed hold is a claim about how
long a command takes, and it is wrong in both directions — `npm test` on a cold
cache outruns it and the take reads as frozen, while a fast command gets the
next beat typed over its own output. `wait_settle` captures a coarse luminance
grid of the screen and returns the moment it stops changing, so there is no
fixed hold left to trim. It compares grids rather than hashes on purpose: the
terminal cursor blinks, so an exact hash of an untouched screen never repeats.

`hi_stage` quits and relaunches the app because a Terminal carried over from the
previous take still holds every variable that take exported and every line it
printed. A stale `OPENCODE_CONFIG_DIR` made a test fail on camera during a later
take, under a line of narration claiming the suite was green — and no gate could
see it, because gates run in the vrec process, not in that Terminal.

**Leave `HI_TYPE_SPEED` at `1.0`.** At 1.8 the typing drops characters in
Terminal.app, and since the type helper presses Return for you, one dropped
character runs a command the take never typed. It surfaces as an unbalanced
quote and a `dquote>` prompt, which reads like a flaky shell rather than a
typing fault. Take the time back from `wait_settle` instead, which costs nothing
in realism.

`vrec doctor` runs `test/` — which covers the speed multiplier, the grid
comparison, and the take scripts — so a change that breaks the tool fails before
the next recording rather than during it.

## Keeping other UI out of the frame

The capture is the whole display, so anything else on it — a chat window, a
notification, a permission dialog from another agent — ends up in the video. A
crop drops a region without having to close anything:

| Variable | Effect |
|---|---|
| `VREC_EXCLUDE_LEFT=260` | drop 260 **points** from the left edge |
| `VREC_EXCLUDE_RIGHT=400` | drop 400 **points** from the right edge |
| `VREC_EXCLUDE_BOTTOM=300` | drop 300 **points** from the bottom edge |
| `VREC_CROP=1840:1800:1040:0` | raw ffmpeg crop in capture pixels, `W:H:X:Y` |
| `VREC_SCALE=2` | pixels per point, for a non-Retina display |
| `VREC_STATUS_FILE=/tmp/run.log` | where the progress log lives |

```bash
VREC_EXCLUDE_LEFT=260 vrec record --preset acme-checkout --out ~/Desktop/demo.mp4
```

A 2880×1800 capture with `VREC_EXCLUDE_LEFT=260` writes a 2360×1800 file.
`LEFT`, `RIGHT` and `BOTTOM` combine, so
`VREC_EXCLUDE_LEFT=260 VREC_EXCLUDE_RIGHT=400` writes 2080×1800.

### Watching a run without being in the video

A take can run twenty minutes showing nothing but a terminal that looks stuck.
`vrec status` reads the progress log and draws a live panel:

```
recording in progress
step  3   setup: start the API and the web app
time  2m14s    still running
last ok   chain answers RPC after deploy
warning  port 3000 slow to answer
error    none
```

It exits by itself when the run finishes, and turns red with `recording
FAILED` if the take aborts — so a caller can wait on it in a script.

The panel is a terminal you control, not a window on screen, which is the
whole point: it cannot end up in the recording. If your editor's chat panel
sits on the right of the screen, exclude that strip so a glance at it during a
recording is harmless:

```bash
VREC_EXCLUDE_RIGHT=400 vrec record --take acme-client   # terminal 1
vrec status                                            # terminal 2
```

## Writing a preset

A preset is a shell file in `presets/` defining four functions:

```bash
#desc: one-line description shown by `vrec list`

preflight_run()         {          # must return 0 to allow recording
  preflight_port "chain" 8545 || return 1
  preflight_check "api" "$API/api/chain/status" '"connected":true'
}

preflight_record_ready(){          # optional extra gate
  : 
}

preflight_shots()      {          # runs while recording
  shot_one; shot_two
}
```

Helpers available inside a preset:

| Call | Purpose |
|---|---|
| `preflight_port <label> <port>` | something is listening on that port |
| `preflight_check <label> <url> [substring]` | endpoint answers and contains the substring |
| `hi_focus [app]` | bring an app forward and **verify it stayed** forward |
| `hi_fill [app]` | stretch every window of an app over the display |
| `hi_type <text>` | type it like a person, then Return |
| `hi_move X Y` | walk the pointer there along a curve |
| `hi_click X Y` | move there, settle, click |
| `hi_scroll X Y N` | move there, scroll N notches (negative is up) |

`hi_focus` polls the frontmost bundle id instead of trusting `activate`: an
Electron app takes focus back within a few hundred milliseconds, and every
keystroke after that lands in the wrong window while the recording still looks
plausible. It fails loudly rather than typing into VS Code.

## Starting a preset for a new client task

```bash
vrec new acme-checkout "ACME checkout, guest to paid"
```

Copies `presets/_template.sh` to `presets/acme-checkout.sh` with the
description filled in. Nothing here is tied to one project.

## Shot discipline

These lessons came from a video that turned out to be unreadable:

1. **Set the whole project up first, record second.** Recording `npm install`
   is four minutes of dead air where every failure happens.
2. **One Terminal window.** Opening a window per step is how you get six
   overlapping windows and an unreadable video. `hi_fill` sizes every window to
   the display and **fails loudly if any of them is still partial**, because the
   window actually on screen is often not the `front window`.
3. **No foreground processes.** A process running in a Terminal window dies when
   that window is touched. Use `nohup … &` with a log.
4. **Keep shots short.** A 16-minute video is a worse deliverable than a 6-minute
   one. Hold each frame just long enough to read.
5. **End on the proof.** Buy the thing, then read the state back from the chain.
   Without the second read you have shown a button press, not a working result.

## Attribution

The pointer and typing kinematics are ported from
[artemindubai/human-input](https://github.com/artemindubai/human-input) (MIT).
Its X11 backend uses `xdotool`; only the geometry and timing were kept, and the
driver here posts CoreGraphics events on macOS instead. `OPTION_KEYCODES` and
the TIS input-source handling are local.

## Why this exists

The failure this tool exists to prevent, concretely: a three-hour deadline
spent building a working project, then discovering at the end that the recording
was 0.05 seconds long and the whole thing had to be redone. Nothing here is
clever. It just refuses to let a broken precondition reach the expensive stage.