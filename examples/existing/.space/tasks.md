# Put a storage seam between the functions and the dict

## Tasks

- [ ] Prove the suite is green before anything moves
  - files: tests/test_app.py
  - change: nothing changes; run the suite and record the baseline in the task output
  - accept: the three existing tests pass on the untouched code
  - verify: python3 -m pytest -q
  - status: pending

- [ ] Add a storage module that owns the stock dict
  - files: storage.py, app.py
  - change: move STOCK into storage.py behind get_add/set_balance helpers, and have take()/add() call them
  - accept: take() and add() behave exactly as before and no longer touch the dict directly
  - verify: python3 -m pytest -q
  - status: pending

- [ ] Rewrite the tests against the storage seam
  - files: tests/test_app.py
  - change: replace the direct STOCK manipulation in tests with the storage helpers
  - accept: the tests pass without importing STOCK from app
  - verify: python3 -m pytest -q
  - status: pending
