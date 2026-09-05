"""The engine as a plain HTTP service, for running it without Runpod.

Speaks the three routes the Worker uses — ``POST /run``, ``GET /status/{id}``,
``POST /cancel/{id}`` — and the same envelope, so pointing
``PREFERENCE_ENGINE_URL`` at this process exercises the entire job pipeline unchanged:
the ledger, the polling pass, the idempotency check and the atomic model switch all
behave exactly as they will against Runpod.

    python serve.py --volume ./volume [--port 9000]

Jobs run on a background thread and are reported through ``/status``, rather than
completing inside the POST. That is not ceremony: a training run takes minutes, the
Worker is on a request timeout, and a service that answered synchronously would let a
whole class of timing bug through untested.

Deliberately the standard library and nothing else. This is a development tool that
happens to sit in front of a GPU-shaped workload, and adding a web framework to the
image for it would be a dependency the container carries into production for no reason.

Bound to localhost, with no authentication. It executes model training on request, so
do not put it on an address anything else can reach.
"""

from __future__ import annotations

import argparse
import json
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from adapter.console import use_utf8_io
from adapter.dispatch import dispatch

MAX_BODY = 32 * 1024 * 1024


@dataclass
class Job:
    id: str
    status: str = "IN_QUEUE"
    output: Any = None
    error: str | None = None
    #: Set once the job reaches a terminal state, so `/cancel` can tell the difference.
    done: threading.Event = field(default_factory=threading.Event)


class JobStore:
    """Jobs, and the one worker thread that runs them.

    A single worker rather than a pool, matching `workersMax = 1` in design section 26.
    Two training runs against one volume could activate different model versions
    between one another's steps, and that is as true here as it is on Runpod.
    """

    def __init__(self, engine) -> None:
        self._engine = engine
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._queue: list[tuple[Job, dict]] = []
        self._wake = threading.Condition(self._lock)
        threading.Thread(target=self._run_forever, daemon=True).start()

    def submit(self, payload: dict) -> Job:
        job = Job(id=str(uuid.uuid4()))
        with self._wake:
            self._jobs[job.id] = job
            self._queue.append((job, payload))
            self._wake.notify()
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._wake:
            job = self._jobs.get(job_id)
            if job is None or job.done.is_set():
                return False
            # Only a job that has not started can be dropped. Interrupting a torch
            # training loop from another thread is not something to fake.
            for index, (queued, _) in enumerate(self._queue):
                if queued.id == job_id:
                    del self._queue[index]
                    job.status = "CANCELLED"
                    job.done.set()
                    return True
            return False

    def _run_forever(self) -> None:
        while True:
            with self._wake:
                while not self._queue:
                    self._wake.wait()
                job, payload = self._queue.pop(0)
                job.status = "IN_PROGRESS"

            try:
                result = dispatch(payload, self._engine)
                # `dispatch` reports engine failures as data rather than raising, and
                # the Worker reads a job as failed from the status, not the body.
                if isinstance(result, dict) and "error" in result:
                    job.status, job.error = "FAILED", str(result["error"])
                else:
                    job.status, job.output = "COMPLETED", result
            except Exception:
                job.status = "FAILED"
                job.error = traceback.format_exc(limit=3)
            finally:
                job.done.set()


class Handler(BaseHTTPRequestHandler):
    store: JobStore

    # HTTP/1.1, not the default 1.0, for one reason that cost an afternoon: a client
    # sending a large body may announce `Expect: 100-continue` and wait to be told to
    # proceed. Python only honours that header when this attribute is 1.1; under 1.0 it
    # reads the body without answering, and a client that waits sees the connection die
    # instead. curl hides the problem by giving up after a second and sending anyway —
    # the Workers runtime does not, so a score batch failed with "Network connection
    # lost" while the identical payload succeeded from a shell.
    #
    # Safe because every response here sends an accurate Content-Length, which is what
    # keep-alive needs to find the end of one.
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:  # noqa: N802 - name fixed by the base class
        path = self.path.rstrip("/")

        if path == "/run" or path == "/runsync":
            payload = self._read_json()
            if payload is None:
                return
            inner = payload.get("input")
            if not isinstance(inner, dict):
                self._json(400, {"error": "body has no `input` object"})
                return

            job = self.store.submit(inner)
            if path == "/runsync":
                # Allowed by design section 28 for small probes only. It blocks, which
                # is why the Worker never uses it for training.
                job.done.wait()
                self._json(200, self._describe(job))
            else:
                self._json(200, {"id": job.id, "status": job.status})
            return

        if path.startswith("/cancel/"):
            self._json(200, {"cancelled": self.store.cancel(path.rsplit("/", 1)[-1])})
            return

        self._json(404, {"error": f"no route for POST {self.path}"})

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.rstrip("/")

        if path in ("/health", ""):
            self._json(200, {"ok": True})
            return

        if path.startswith("/status/"):
            job = self.store.get(path.rsplit("/", 1)[-1])
            if job is None:
                self._json(404, {"error": "unknown job"})
                return
            self._json(200, self._describe(job))
            return

        self._json(404, {"error": f"no route for GET {self.path}"})

    @staticmethod
    def _describe(job: Job) -> dict:
        body: dict[str, Any] = {"id": job.id, "status": job.status}
        if job.output is not None:
            body["output"] = job.output
        if job.error:
            body["error"] = job.error
        return body

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self._json(400, {"error": "bad content-length"})
            return None
        if length <= 0 or length > MAX_BODY:
            self._json(400, {"error": "empty or oversized body"})
            return None
        try:
            body = self.rfile.read(length)
        except OSError as error:
            self._json(400, {"error": f"could not read the body: {error}"})
            return None

        try:
            return json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            # `UnicodeDecodeError` as well as the JSON one: a body that is not valid
            # UTF-8 — a payload mangled in transit, or by a shell that re-encoded the
            # Japanese in it — raises from inside `json.loads` before parsing begins.
            # Left uncaught it kills the handler thread, and the client sees the
            # connection close with no status at all rather than a reason.
            self._json(400, {"error": f"malformed request body: {error}"})
            return None

    def _json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt: str, *args) -> None:
        print(f"  {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


def main() -> int:
    use_utf8_io()
    parser = argparse.ArgumentParser(description="Run the preference engine over HTTP")
    parser.add_argument("--volume", type=Path, required=True, help="stands in for /runpod-volume")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--host", default="127.0.0.1")
    arguments = parser.parse_args()

    from adapter.anagnorisis_engine import AnagnorisisEngine

    arguments.volume.mkdir(parents=True, exist_ok=True)
    Handler.store = JobStore(AnagnorisisEngine(volume=arguments.volume))

    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    print(f"engine on http://{arguments.host}:{arguments.port}  volume={arguments.volume}")
    print("point the Worker at it with:")
    print(f'  PREFERENCE_ENGINE_URL="http://{arguments.host}:{arguments.port}"')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
