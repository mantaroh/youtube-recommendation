"""Collect jobs from the Worker and run them here (docs/design/pull-engine.ja.md).

The push model has the Worker call the engine, which means the engine has to be
reachable from the internet and has to be awake when the Worker decides to call. This
inverts that: nothing listens, nothing is exposed, and this machine decides when it is
free enough to do the work.

    set ENGINE_PULL_TOKEN=...
    python tools/pull_runner.py --url https://yt.mantaroh.com --volume ./volume \
        --window 01:00-07:00

The token comes from the environment rather than an argument, so it stays out of shell
history and out of the process list.
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


class WorkerApi:
    def __init__(self, base_url: str, token: str, timeout: float = 60.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body or {}).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
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
    arguments = parser.parse_args()

    token = os.environ.get("ENGINE_PULL_TOKEN")
    if not token:
        print("ENGINE_PULL_TOKEN is not set", file=sys.stderr)
        return 2

    window = parse_window(arguments.window)
    api = WorkerApi(arguments.url, token)

    arguments.volume.mkdir(parents=True, exist_ok=True)
    # Imported here rather than at the top: it pulls in torch, which takes seconds and
    # is wasted on a run that turns out to have nothing to do.
    from adapter.anagnorisis_engine import AnagnorisisEngine

    engine = AnagnorisisEngine(volume=arguments.volume)

    where = f"{arguments.url}  volume={arguments.volume}"
    print(f"runner started  {where}  window={arguments.window or 'always'}")

    while True:
        if window and not window.contains(datetime.now()):
            if arguments.once:
                print("outside the window; nothing done")
                return 0
            time.sleep(arguments.poll)
            continue

        try:
            job = api.claim()
        except urllib.error.HTTPError as error:
            # 403 means the token is wrong, and waiting will not fix it.
            if error.code == 403:
                print("rejected: check ENGINE_PULL_TOKEN", file=sys.stderr)
                return 1
            print(f"claim failed: {error}", file=sys.stderr)
            job = None
        except urllib.error.URLError as error:
            print(f"cannot reach the worker: {error.reason}", file=sys.stderr)
            job = None

        if job:
            print(run_one(api, engine, job), flush=True)
            if arguments.once:
                return 0
            # Straight back for the next one: a queue is usually more than one job, and
            # the machine is evidently free right now.
            continue

        if arguments.once:
            print("nothing queued")
            return 0
        time.sleep(arguments.poll)


if __name__ == "__main__":
    raise SystemExit(main())
