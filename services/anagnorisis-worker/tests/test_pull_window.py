"""The hours the runner is willing to work (docs/design/pull-engine.ja.md).

Small, but the one piece of the runner with a case that is easy to get wrong: a window
set overnight runs from one day into the next, and comparing it as a simple range says
that 02:00 is outside 23:00-05:00.
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from pull_runner import parse_window  # noqa: E402


def at(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 9, 6, hour, minute)


def test_no_window_means_always():
    assert parse_window(None) is None
    assert parse_window("") is None


def test_daytime_window():
    window = parse_window("01:00-07:00")
    assert window.contains(at(1))
    assert window.contains(at(6, 59))
    assert not window.contains(at(7))
    assert not window.contains(at(0, 59))
    assert not window.contains(at(13))


def test_window_crossing_midnight():
    window = parse_window("23:00-05:00")
    assert window.contains(at(23))
    assert window.contains(at(2))
    assert window.contains(at(4, 59))
    assert not window.contains(at(5))
    assert not window.contains(at(12))
    assert not window.contains(at(22, 59))


def test_malformed_window_is_refused_rather_than_guessed():
    # Silently treating an unparseable window as "always" would have the runner work
    # through the hours it was told to stay out of.
    with pytest.raises(SystemExit):
        parse_window("1pm to 5pm")
    with pytest.raises(SystemExit):
        parse_window("25:00-05:00")
