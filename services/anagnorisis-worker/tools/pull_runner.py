"""Collect jobs from the Worker and run them here (docs/design/pull-engine.ja.md).

The push model has the Worker call the engine, which means the engine has to be
reachable from the internet and has to be awake when the Worker decides to call. This
inverts that: nothing listens, nothing is exposed, and this machine decides when it is
free enough to do the work.

    python tools/pull_runner.py --url https://yt.mantaroh.com --volume ./volume \
        --window 01:00-07:00

Credentials come from `engine-credentials.env` at the repository root, or from the
environment, which overrides it. Neither is an argument, so neither reaches shell
history or a process list.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, time as clock_time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter.console import use_utf8_io  # noqa: E402
from adapter.dispatch import dispatch  # noqa: E402

use_utf8_io()

USER_AGENT = "personal-recommender-runner/1.0"

# A claim that keeps failing the same way will keep failing. The night this was written
# for spent seven hours receiving the same 500 every five minutes and said nothing about
# it until someone thought to look — and the log had no times in it, so there was no way
# to tell one failure from eighty-four.
MAX_CONSECUTIVE_FAILURES = 5


def log(message: str, *, error: bool = False) -> None:
    """Every line stamped, in local time.

    This writes to a file that gets read the next morning, when the only questions are
    when something happened and how often. A line with no time answers neither.
    """
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {message}", file=sys.stderr if error else sys.stdout, flush=True)


@dataclass(frozen=True)
class Window:
    """The hours this machine is willing to work.

    Local time, not UTC: a window is set because of when the machine is in use, and the
    person setting it is thinking in the clock on their wall.
    """

    start: clock_time
    end: clock_time

    def contains(self, moment: datetime) -> bool:
        now = moment.time()
        if self.start <= self.end:
            return self.start <= now < self.end
        # Crosses midnight, which is the usual case for "overnight".
        return now >= self.start or now < self.end


def parse_window(text: str | None) -> Window | None:
    if not text:
        return None
    try:
        start_text, end_text = text.split("-", 1)
        start = datetime.strptime(start_text.strip(), "%H:%M").time()
        end = datetime.strptime(end_text.strip(), "%H:%M").time()
    except ValueError as error:
        raise SystemExit(f"--window must look like 01:00-07:00, not {text!r}") from error
    return Window(start, end)


def read_credentials(path: Path | None) -> dict[str, str]:
    """Loads `KEY=VALUE` lines, if the file is there.

    A file rather than three environment variables because that is how these arrive:
    Cloudflare shows a service token's secret once, and copying it into a git-ignored
    file is fewer chances to put it somewhere it will be kept. The environment still
    wins, so a one-off run can override without editing anything.
    """
    values: dict[str, str] = {}
    if path and path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("\"'")
    for key in ("ENGINE_PULL_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"):
        from_environment = os.environ.get(key)
        if from_environment:
            values[key] = from_environment
    return values


def build_headers(credentials: dict[str, str]) -> dict[str, str]:
    """The headers every request carries.

    Two layers, and both are wanted. The service token is what gets past Cloudflare
    Access at the edge, so a request without it never reaches the Worker at all. The
    bearer token is what the Worker itself checks, so a mistake in the Access
    configuration — an application scoped to the wrong path, say — does not leave the
    routes open.
    """
    headers = {
        "Authorization": f"Bearer {credentials['ENGINE_PULL_TOKEN']}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Cloudflare's browser integrity check refuses urllib's default agent as a bot
        # signature, and answers 403 with error 1010 — which reads exactly like a
        # rejected token. Naming the client avoids an hour spent on the wrong problem.
        "User-Agent": USER_AGENT,
    }
    client_id = credentials.get("CF_ACCESS_CLIENT_ID")
    client_secret = credentials.get("CF_ACCESS_CLIENT_SECRET")
    if client_id and client_secret:
        headers["CF-Access-Client-Id"] = client_id
        headers["CF-Access-Client-Secret"] = client_secret
    return headers


class WorkerApi:
    def __init__(self, base_url: str, headers: dict[str, str], timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = headers
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body or {}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers=self.headers,
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            payload = response.read().decode("utf-8")
        return json.loads(payload) if payload else {}

    def claim(self) -> dict | None:
        return self._request("POST", "/api/engine/claim").get("job")

    def report_result(self, job_id: str, output: dict) -> dict:
        return self._request("POST", f"/api/engine/jobs/{job_id}/result", output)

    def report_failure(self, job_id: str, error: str) -> dict:
        return self._request("POST", f"/api/engine/jobs/{job_id}/fail", {"error": error[:500]})


def run_one(api: WorkerApi, engine, job: dict) -> str:
    """Runs a claimed job and reports what happened.

    A failure is reported rather than raised. The job is held under a lease, and saying
    nothing would leave it stuck until that lease expired — half an hour of nothing for
    something already known to have gone wrong.
    """
    job_id = job["id"]
    envelope = {"operation": job["operation"], "payload": job["payload"]}

    started = time.monotonic()
    try:
        output = dispatch(envelope, engine)
    except Exception as error:  # noqa: BLE001 - reported upstream, not swallowed
        api.report_failure(job_id, f"{type(error).__name__}: {error}")
        return f"{job_id} failed after {time.monotonic() - started:.0f}s: {error}"

    # `dispatch` returns a structured error rather than raising, so this is the ordinary
    # "the engine refused the work" path.
    if "error" in output:
        api.report_failure(job_id, str(output["error"]))
        return f"{job_id} rejected: {output['error']}"

    api.report_result(job_id, output)
    return f"{job_id} done in {time.monotonic() - started:.0f}s"


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect and run preference engine jobs")
    parser.add_argument("--url", required=True, help="the deployment, e.g. https://yt.mantaroh.com")
    parser.add_argument("--volume", type=Path, default=Path("./volume"), help="model and memory storage")
    parser.add_argument("--window", help="local-time hours to work in, e.g. 01:00-07:00")
    parser.add_argument("--poll", type=int, default=300, help="seconds between checks")
    parser.add_argument("--once", action="store_true", help="take at most one job, then stop")
    parser.add_argument(
        "--credentials",
        type=Path,
        default=Path(__file__).resolve().parents[3] / "engine-credentials.env",
        help="KEY=VALUE file holding the tokens; the environment overrides it",
    )
    arguments = parser.parse_args()

    credentials = read_credentials(arguments.credentials)
    if not credentials.get("ENGINE_PULL_TOKEN"):
        log(f"no ENGINE_PULL_TOKEN, in the environment or in {arguments.credentials}", error=True)
        return 2

    if not credentials.get("CF_ACCESS_CLIENT_ID"):
        # Not fatal: a deployment behind a Bypass policy needs no service token. Worth
        # saying, though, because the symptom otherwise is a 302 that looks like nothing.
        log("no service token set; expect a redirect if Access protects this path", error=True)

    window = parse_window(arguments.window)
    api = WorkerApi(arguments.url, build_headers(credentials))

    arguments.volume.mkdir(parents=True, exist_ok=True)
    # Imported here rather than at the top: it pulls in torch, which takes seconds and
    # is wasted on a run that turns out to have nothing to do.
    from adapter.anagnorisis_engine import AnagnorisisEngine

    engine = AnagnorisisEngine(volume=arguments.volume)

    where = f"{arguments.url}  volume={arguments.volume}"
    log(f"runner started  {where}  window={arguments.window or 'always'}")

    # Reset by any job that runs: a night that did work and then hit a bad patch has not
    # been failing all along, and should not be treated as though it had.
    failures = 0

    while True:
        if window and not window.contains(datetime.now()):
            if arguments.once:
                log("outside the window; nothing done")
                return 0
            time.sleep(arguments.poll)
            continue

        try:
            job = api.claim()
        except urllib.error.HTTPError as error:
            # 403 comes from two very different places and waiting fixes neither, so the
            # body is printed rather than guessed at: the Worker answers `forbidden` for
            # a bad bearer token, while Cloudflare answers error 1010 when it dislikes
            # the client — which has nothing to do with the token at all.
            detail = error.read().decode("utf-8", "replace")[:300]
            if error.code == 403:
                log(f"refused (403): {detail}", error=True)
                return 1
            failures += 1
            log(f"claim failed ({error.code}), {failures} in a row: {detail}", error=True)
            if failures >= MAX_CONSECUTIVE_FAILURES:
                log("giving up: the same call has failed too many times", error=True)
                return 1
            job = None
        except urllib.error.URLError as error:
            failures += 1
            log(f"cannot reach the worker ({failures} in a row): {error.reason}", error=True)
            if failures >= MAX_CONSECUTIVE_FAILURES:
                log("giving up: the worker has been unreachable too long", error=True)
                return 1
            job = None

        if job:
            failures = 0
            log(run_one(api, engine, job))
            if arguments.once:
                return 0
            # Straight back for the next one: a queue is usually more than one job, and
            # the machine is evidently free right now.
            continue

        if arguments.once:
            log("nothing queued")
            return 0
        time.sleep(arguments.poll)


if __name__ == "__main__":
    raise SystemExit(main())
