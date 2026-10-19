# space-harness — demo narration

Seven scenes. Prose, not bullets; `audio.py` reads it aloud as written.

## Scene 1 · The burn

Here's the thing nobody warns you about. Two thousand messages into a session,
you've spent two hundred thousand tokens on context. And most of it? Tool output
you already looked at once and never need again. That's not your prompt getting
longer. That's your tools talking over each other.

## Scene 2 · The ladder

So we built a ladder instead. Locate does the searching. It returns file and
line, nothing more. It reads one file for a search the old way would read
twelve. And it runs on the cheapest model you own, because finding a line
number is not a job that needs a frontier.

## Scene 3 · The numbers

Same task. Same repo. Fifty-four percent less context per request. File reads
per search, twelve point two down to one point eight. And a hundred and sixty
five tests that rerun on every commit, so the number can't quietly go stale.

## Scene 4 · The guard

But a harness that only nudges is a suggestion. This one enforces. Write to
git internals? Blocked. Chmod seven seven seven? Blocked. Recursive delete?
Blocked. Not because we asked nicely, because a real model reading a real
policy does better than a model reading a vibe.

## Scene 5 · The routing

And it routes. Every agent gets its own model and its own effort tier. Build
thinks hard. Locate doesn't need to. When the strong one fails over, the
profile swaps underneath and nothing in your code changes.

## Scene 6 · The part that bit us

Then we shipped a bug, which is the honest part. Our config is JSONC. Hand edits
add trailing commas. Our parser choked, returned nothing, and told you to rerun
a command that quietly deleted your settings. No warning. No backup. That's the
kind of failure a demo never shows, and the kind that matters.

## Scene 7 · Get it

It's fixed. The parser walks the text, the CLI refuses to guess instead of
writing over your work, and there's a test that fails if it ever regresses.

Typechecked. Tested. CI installs it clean. MIT licensed. Take it.