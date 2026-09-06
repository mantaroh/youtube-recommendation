"""Loading the runner's credentials and building its headers.

Worth testing because the failure is quiet: a request missing the service token headers
is answered by Cloudflare with a redirect to a login page, which reads as "nothing
queued" rather than as "you were never let in".
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from pull_runner import build_headers, read_credentials  # noqa: E402


@pytest.fixture(autouse=True)
def clear_environment(monkeypatch):
    for key in ("ENGINE_PULL_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"):
        monkeypatch.delenv(key, raising=False)


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "engine-credentials.env"
    path.write_text(body, encoding="utf-8")
    return path


def test_reads_key_value_lines(tmp_path):
    path = write(tmp_path, "ENGINE_PULL_TOKEN=abc\nCF_ACCESS_CLIENT_ID=id\nCF_ACCESS_CLIENT_SECRET=secret\n")
    assert read_credentials(path) == {
        "ENGINE_PULL_TOKEN": "abc",
        "CF_ACCESS_CLIENT_ID": "id",
        "CF_ACCESS_CLIENT_SECRET": "secret",
    }


def test_ignores_comments_blank_lines_and_quotes(tmp_path):
    path = write(tmp_path, '# a note\n\nENGINE_PULL_TOKEN="abc"\n')
    assert read_credentials(path)["ENGINE_PULL_TOKEN"] == "abc"


def test_missing_file_is_not_an_error(tmp_path):
    assert read_credentials(tmp_path / "absent.env") == {}
    assert read_credentials(None) == {}


def test_environment_overrides_the_file(tmp_path, monkeypatch):
    path = write(tmp_path, "ENGINE_PULL_TOKEN=from-file\n")
    monkeypatch.setenv("ENGINE_PULL_TOKEN", "from-environment")
    assert read_credentials(path)["ENGINE_PULL_TOKEN"] == "from-environment"


def test_headers_carry_both_tokens():
    headers = build_headers(
        {
            "ENGINE_PULL_TOKEN": "abc",
            "CF_ACCESS_CLIENT_ID": "id",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        }
    )
    # The service token gets past Access; the bearer token is what the Worker checks.
    assert headers["Authorization"] == "Bearer abc"
    assert headers["CF-Access-Client-Id"] == "id"
    assert headers["CF-Access-Client-Secret"] == "secret"


def test_service_token_headers_are_omitted_when_incomplete():
    # Half a service token would be sent and rejected; leaving it off at least makes the
    # 302 mean what it says.
    headers = build_headers({"ENGINE_PULL_TOKEN": "abc", "CF_ACCESS_CLIENT_ID": "id"})
    assert "CF-Access-Client-Id" not in headers
    assert headers["Authorization"] == "Bearer abc"
