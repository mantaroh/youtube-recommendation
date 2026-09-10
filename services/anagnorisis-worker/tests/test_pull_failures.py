"""When the runner should stop trying (docs/design/pull-engine.ja.md).

Written after a night that produced nothing and said so nowhere. The Worker answered
every claim with the same 500, the runner asked again every five minutes for seven hours,
and the log — which had no timestamps — held two lines that looked like any other two.

Two properties come out of that: a line has a time on it, and a call that keeps failing
the same way eventually stops being made.
"""

from __future__ import annotations

import re
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import pull_runner  # noqa: E402
from pull_runner import MAX_CONSECUTIVE_FAILURES, log  # noqa: E402


def test_every_line_carries_a_time(capsys):
    log("something happened")
    written = capsys.readouterr().out
    # The morning's questions are when and how often; a bare line answers neither.
    assert re.match(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] something happened\n$", written)


def test_errors_go_to_stderr_so_a_redirect_keeps_them(capsys):
    log("that went wrong", error=True)
    captured = capsys.readouterr()
    assert "that went wrong" in captured.err
    assert captured.out == ""


class _FailingApi:
    """Answers every claim with the same server error."""

    def __init__(self, code: int = 500) -> None:
        self.code = code
        self.calls = 0

    def claim(self):
        self.calls += 1
        raise urllib.error.HTTPError(
            "https://example.test/api/engine/claim", self.code, "Server Error", {}, None
        )


def run_main(monkeypatch, api, tmp_path, extra=()):
    monkeypatch.setattr(pull_runner, "WorkerApi", lambda *a, **k: api)
    # The engine is imported inside `main` and never reached here: no claim succeeds.
    monkeypatch.setattr(
        pull_runner, "read_credentials", lambda path: {"ENGINE_PULL_TOKEN": "t"}
    )
    monkeypatch.setattr(pull_runner.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        sys, "argv", ["pull_runner.py", "--url", "https://example.test",
                      "--volume", str(tmp_path), *extra]
    )
    return pull_runner.main()


def test_stops_after_the_same_failure_repeats(monkeypatch, tmp_path, capsys):
    api = _FailingApi()
    assert run_main(monkeypatch, api, tmp_path) == 1
    # Not once more than needed, and emphatically not for seven hours.
    assert api.calls == MAX_CONSECUTIVE_FAILURES
    assert "giving up" in capsys.readouterr().err


def test_counts_the_failures_in_the_line(monkeypatch, tmp_path, capsys):
    # "3 in a row" is what turns a wall of identical lines into a fact.
    run_main(monkeypatch, _FailingApi(), tmp_path)
    err = capsys.readouterr().err
    assert "1 in a row" in err
    assert f"{MAX_CONSECUTIVE_FAILURES} in a row" in err


def test_a_forbidden_claim_stops_at_once(monkeypatch, tmp_path, capsys):
    # Waiting fixes neither of the things a 403 means, so there is nothing to retry for.
    api = _FailingApi(code=403)
    assert run_main(monkeypatch, api, tmp_path) == 1
    assert api.calls == 1
    assert "refused (403)" in capsys.readouterr().err
