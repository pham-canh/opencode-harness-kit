# Milestones

## M1 — The suite runs green before anything moves

The starting state is proven, not assumed: `python3 -m pytest -q` passes on the
code as it stands.

## M2 — A storage seam exists

`app.py` calls into a `storage` module instead of touching `STOCK` directly.
Behaviour is unchanged and the suite is the proof.

## M3 — The seam is the only writer

`take()` and `add()` no longer import the dict; the module-level `STOCK` is
removed, and the tests that reach into it are rewritten against the seam.

## M4 — The change that motivated this

Deferred. M1–M3 are the work that makes it possible, and this milestone stays
empty until a real requirement exists for it.
