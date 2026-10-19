# Narration — opencode-harness-kit demo

English, male voice, aimed at a ~34-year-old engineer reading a demo.
Timed against `docs/demo.mp4` (1:42). Timings are measured, not guessed:
the terminal opens empty, `list` is fully on screen by 0:55, `verify` is on
screen by 1:30.

| at | what is on screen | line |
|---|---|---|
| 0:04 | prompt, `cd` typed | This is `oc-harness list`. |
| 0:09 | still typing | Every profile is a set of values calibrated against one vendor's behaviour. |
| 0:18 | | And it tells you which one, rather than leaving you to find out. |
| 0:25 | table appears | Look at the retention column. Three of these are may-train: the file is retained even though the base model is not. |
| 0:39 | | That is your provider's retention policy deciding what happens to your logs. |
| 0:48 | installable line | Now the installable line. The provider you train on does not have to be the provider you ship with. |
| 1:00 | verify typed | Now `oc-harness verify`. |
| 1:05 | | It checks your installed config against the profile, and exits non-zero on drift. |
| 1:16 | four green checks | Config matches. Instruction resolves. Plugin linked. Eleven skills valid. |
| 1:28 | "install is consistent" | Install is consistent with the profile. |
| 1:34 | | One command, and you can prove it. |

## Voice

```bash
edge-tts --voice en-US-AndrewNeural --rate=-6% \
  --text "Install is consistent with the profile." --write-media /tmp/t.mp3
```

`en-US-AndrewNeural` is the one that reads as a competent man in his
mid-thirties rather than as a news anchor. `en-US-ChristopherNeural` is
flat and authoritative, `en-US-GuyNeural` reads younger and punchier.
macOS `say` is not usable here: the default male voices are Fred, Ralph and
Junior, and Alex is not installed on this machine.

`--rate=-6%` because the default neural rate is slightly rushed for numbers
and version strings.