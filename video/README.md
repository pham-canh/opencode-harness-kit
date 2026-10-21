# The demo video

`docs/demo/pitch.mp4` — 4:47, 2880x1800 retina, English narration, recorded
live from a real terminal. Not slides: every command on screen is typed into
a Terminal window and executed while the camera runs.

**It was recorded against an earlier version of the kit.** The numbers it
names are the ones from then; the ones in the README are the ones now. The
file is here because a demo you can watch beats a demo you have to imagine,
and because the shape of it — a terminal, real commands, a result you can
read back — has not changed.

The point of the demo is the last third of it. The take stages a config file
carrying a comment and a trailing comma, regenerates it with
`oc-harness use`, and then shows the setting that was in that file surviving.
That is the bug this branch fixed, and the previous bug — an unreadable config
made the reader return `{}`, and `use` wrote the user's settings back out
deleted — is not something a demo of winning numbers would have shown.

## What is here

| | |
|---|---|
| `narration.txt` | the voiceover of the published video, in beats, with `[[slnc N]]` pauses that hold the voice against the screen |
| `../docs/demo/pitch.mp4` | the published file |
| `../docs/demo-loop.gif` | the short loop on the README's front page |
| `legacy/` | the first dubbing pipeline, kept because its notes explain the timing method |

## What is not here, and why

**The take script.** A take is a script that gets typed, and a script that
gets typed has to be reviewable before it is filmed — but it is also a shell
file with the recording machine's paths in it, and it goes stale the moment
the thing it films changes. The one that filmed the video above is on the
machine that recorded it, next to the recorder that ran it.

**The recording guide.** Same reason, and the same place. It is a document
about one machine and one take; publishing it would publish the paths and
the private workspace it points at.

**`setup-demo.sh`.** The recorder and the dubbing tool are separate
repositories with their own history. Copies inside this repository are how
they drifted: a bug fixed in one, a take recorded with the other. They live
one directory up, and there is exactly one of each.

## Rebuilding it, if you are reproducing it

```sh
git clone https://github.com/pham-canh/opencode-harness-kit.git
cd opencode-harness-kit
git clone https://github.com/pham-canh/vrec.git   ../tools/vrec
git clone https://github.com/pham-canh/btake.git  ../tools/btake
```

`vrec` is macOS-only: it posts real keyboard and mouse events, so the
recording looks like a person using the machine rather than a script driving
a screen. One-time setup is `bash tools/vrec/lib/setup_env.sh` plus the
Accessibility and Screen Recording permissions in System Settings —
`vrec doctor` reports both, and it records a real three-second clip to prove
the encoder works before you spend an hour on it.

The dubbing step is `say` for the voice and `btake dub` to fit the audio to
the picture:

```sh
say -v Reed -r 160 -f narration.txt -o vo.m4a \
    --data-format=aac@44100 --file-format=m4af

python3 ../tools/btake/btake.py dub <recording>.mp4 \
    --narration vo.m4a --offset 5 --out final.mp4
```

`--max-duration` is not advisory. `vrec` finalises the file and then fails
the take if it overran, because a 7:12 recording whose narration ran 4:34 was
handed over as done once already.

## Two things that will bite you

**Do not raise `HI_TYPE_SPEED` to save time.** At 1.8 the typing drops
characters in Terminal.app, and since the helper presses Return for you, one
dropped character runs a command the take never typed. It surfaces as an
unbalanced quote and a `dquote>` prompt, which looks like a flaky shell rather
than a typing bug. Time comes back from `wait_settle` instead — it watches the
screen instead of guessing how long a command takes.

**Rehearse before every record.** The gates run in the recorder's process,
not in the recorded Terminal, so a gate can pass while the shell on camera
did something else. Rehearsing is what catches that. It is also cheaper than
discovering it in the footage.

## The file size is a one-way door

`docs/demo/pitch.mp4` is under the 12 MB that a git repository accepts for
a large file on its first push. Replacing it later means Git LFS, and a
repository that suddenly needs LFS is a repository whose media stops
updating. The take that produced it was cut to fit.
