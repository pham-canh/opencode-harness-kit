# Superseded: the edge-tts narration generation

Kept because it holds two things the current pipeline does not: how the voice
was chosen, and the measured on-screen timings the script was written against.
Both were expensive to work out and would be easy to work out badly twice.

`video/narration.txt` is what actually ships. It runs on macOS `say`, not
edge-tts, and it is timed with `[[slnc ms]]` markers consumed by `btake`.

## What is here

- `narration-edge-tts.md` — script for the 1:42 `docs/demo.mp4`, with a table of
  what is on screen at which second. Records that `en-US-AndrewNeural` reads as
  a competent man in his thirties rather than a news anchor, that
  `en-US-ChristopherNeural` is flat, that macOS `say` is unusable on this machine
  because the default male voices are Fred, Ralph and Junior and Alex is not
  installed, and that `--rate=-6%` is needed because the default neural rate is
  rushed around numbers and version strings.
- `dub-edge-tts.py` — generates one audio file per segment and places each at its
  own timestamp, with the reason given in its docstring: placement is by the
  second each segment starts, *not* by chaining the previous one, because a voice
  reads longer or shorter than planned and a count-based chain drifts the last
  line off the picture.

  It also records two things that are easy to lose and expensive to rediscover.
  The first 50 seconds are just commands being typed, so it cuts 0:50-1:12 and
  1:18-1:41 into a 46 second video. And `CROP = "crop=1280:430:0:0"` exists
  because a 42-line terminal showing 22 lines of output leaves the bottom of the
  frame black -- without it, 70% of the picture is empty.

## What replaced it

`video/narration.txt` plus `btake dub`, built from `video/scenes/`. Audio lands in
`video/build/`; the old recording is at
`video/build/demo-2025-10-18-superseded.mp4`, kept for comparison only.
