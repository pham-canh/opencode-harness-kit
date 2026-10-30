# Charter: stock-service

## Goal

Keep `take()` and `add()` correct while the service is split into the storage
layer it already assumes, without changing the HTTP contract it will get.

## Scope

In scope: `app.py`, the `tests/` suite, and the module boundary between
balances and storage.

Out of scope: authentication, deployment, and the web layer that does not
exist yet.

## Constraints

- The existing test suite is the acceptance test: `python3 -m pytest -q` has
  to keep passing after every task.
- `take()` refuses a negative result. That rule is the reason the module
  exists and it does not change.
- No dependency is added for this. `pytest` is the only test tool.
- The public names `take` and `add` stay importable from `app`.

## Ready

- [x] The test command runs on this machine.
- [x] `app.py` has been read end to end.
- [x] The one behaviour that must not change is written down, above.
