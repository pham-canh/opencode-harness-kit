import pytest

from app import STOCK, add, take


def setup_function():
    STOCK.clear()
    STOCK["widget"] = 3


def test_take_leaves_the_difference():
    assert take("widget", 2) == 1


def test_take_refuses_to_go_negative():
    with pytest.raises(ValueError):
        take("widget", 4)


def test_add_is_the_inverse():
    assert add("widget", 1) == 4
