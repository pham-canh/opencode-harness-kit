# Demo video

`space-harness-demo.mp4` — 2:11, 1920x1080, male English narration.

The finished video is committed as [`docs/demo/pitch.mp4`](../docs/demo/pitch.mp4).
Rebuilding here overwrites the working copy; copy it across when you publish.

## Rebuild

```sh
python3 audio.py     # narration.md -> one m4a per scene + manifest.json
python3 render.py    # manifest + repo facts -> scenes/scene<N>.png
python3 build.py     # stills + audio -> space-harness-demo.mp4
```

`render.py` reads its on-screen numbers out of the repository (test count from
`test/*.test.js`), so if the suite grows the frames change with it and the video
cannot quietly become a lie.

`build.py` fails if the result lands outside 2:00–3:00. Fix the narration rather
than the check.

## How the pieces fit

`narration.md` is the single source of the script — one `## Scene` heading per
beat, body text is what the narrator says. Scene lengths come from
`audio/manifest.json`, measured from the generated audio, never estimated, so
picture and narration cannot drift.

Voice is macOS `say -v Reed` at 165 wpm. `ffprobe` is not installed on this
machine; durations are read from ffmpeg's own banner instead.

## Requirements

`python3` with `playwright` (Chromium already downloaded), and `ffmpeg` on
`PATH`.