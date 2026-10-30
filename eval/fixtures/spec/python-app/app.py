"""A two-function stock service: small enough to read, real enough to detect."""

STOCK = {"widget": 3}


def take(name: str, count: int) -> int:
    """Remove `count` units and return what is left.

    Refuses to go negative: the ledger has no concept of a negative balance.
    """
    if count < 0:
        raise ValueError("count cannot be negative")
    left = STOCK.get(name, 0) - count
    if left < 0:
        raise ValueError(f"not enough {name}")
    STOCK[name] = left
    return left


def add(name: str, count: int) -> int:
    """Add `count` units and return the new balance."""
    if count < 0:
        raise ValueError("count cannot be negative")
    STOCK[name] = STOCK.get(name, 0) + count
    return STOCK[name]
