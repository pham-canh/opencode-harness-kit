# Overview: stock-service as it is

Two files, one module, no layers yet.

```
app.py        STOCK dict, take(), add()
tests/        pytest, three tests, one per behaviour
```

## What the code already guarantees

- `take()` raises rather than returning a negative balance.
- A negative `count` argument is refused in both functions.
- `add()` and `take()` share one module-level dict, so they share one truth.

## Where the change goes

`STOCK` is a process-local dict. The intended change is to put a `storage`
module between the functions and the dict, so the dict can become the database
without `take()` and `add()` changing shape. That boundary does not exist yet;
the tasks add it, and the tests prove the behaviour did not move.

## What is deliberately not drawn

There is no web layer and no authentication. Drawing them would be a design
for a repository that does not exist, and the plan only covers code that is
here.
