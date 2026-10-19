# space-harness demo

`docs/demo/pitch.mp4` — 4:47, 2880x1800 retina, English narration, recorded
live from a real terminal. Not slides: every command on screen is typed into a
Terminal window and executed while the camera runs.

The point of the demo is the last third of it. The take stages a config file
carrying a comment and a trailing comma, regenerates it with
`oc-harness use`, and then shows the setting that was in that file surviving.
That is the bug this branch fixed, and the previous bug — an unreadable config
made the reader return `{}`, and `use` wrote the user's settings back out
deleted — is not something a demo of winning numbers would have shown.

## Files

| | |
|---|---|
| `take.sh` | the take script: what gets typed, in what order, and what must be true when it ends |
| `narration.txt` | the voiceover, in beats, with `[[slnc N]]` pauses that hold the voice against the screen |
| `../docs/demo/pitch.mp4` | the published file |

## Rebuild

Recording needs [`vrec`](../../tools/vrec), which drives the keyboard and mouse
through the accessibility API and checks every claim in the take afterwards.

```sh
export PATH="$HOME/harness/tools/vrec/bin:$PATH"
export HI_TYPE_SPEED=1.0

vrec reset   space-harness        # clean slate before anything
vrec rehearse space-harness      # runs every gate with no recording
vrec record  --take "$PWD/take.sh" --max-duration 400
```

Then voice it:

```sh
say -v Reed -r 160 -f narration.txt -o vo.m4a \
    --data-format=aac@44100 --file-format=m4af

python3 ~/harness/tools/btake/btake.py dub <recording>.mp4 \
    --narration vo.m4a --offset 5 --out final.mp4
```

`--max-duration` is not advisory. `vrec` finalises the file and then fails the
take if it overran, because a 7:12 recording whose narration ran 4:34 was
handed over as done once already.

## Two things that will bite you

**Do not raise `HI_TYPE_SPEED` to save time.** At 1.8 the typing drops
characters in Terminal.app, and since the helper presses Return for you, one
dropped character runs a command the take never typed. It surfaces as an
unbalanced quote and a `dquote>` prompt, which looks like a flaky shell rather
than a typing bug. Time comes back from `wait_settle` instead — it watches the
screen instead of guessing how long a command takes.

**Run `vrec rehearse` before every record.** The gates run in the vrec process,
not in the recorded Terminal, so a gate can pass while the shell on camera did
something else. Rehearsing is what catches that. It is also cheaper than
discovering it in the footage.