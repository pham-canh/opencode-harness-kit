# Milestones

## M1 - Prove the premise

- gate: node --test

The smallest change that makes one failing check pass. Stop when the check
passes and the rest of the system is untouched.

## M2 - Make it usable

- gate: node --test

The feature works end to end for one real case, with its own test.

## M3 - Make it safe to keep

Errors, boundaries, documentation and the rollback path. The acceptance
command passes from a clean checkout.
