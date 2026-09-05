"""The Runpod serverless entry point (design sections 22, 25 and 28).

Runpod calls ``handler(job)`` with whatever was posted under ``input`` and treats the
return value as the job's output. That is the whole of this file: the operations
themselves live in ``adapter.dispatch``, which needs neither the SDK nor a GPU and can
therefore be tested.

The engine is constructed once at import and reused across invocations. A warm worker
then keeps its loaded weights between jobs, which is what makes the second request in a
batch cost seconds rather than a cold start (design section 25, FlashBoot).
"""

from __future__ import annotations

import os
from typing import Any

from adapter.anagnorisis_engine import AnagnorisisEngine
from adapter.console import use_utf8_io
from adapter.dispatch import dispatch

# Before the engine is built, because building it is what spawns the subprocesses that
# inherit the console encoding.
use_utf8_io()

_engine = AnagnorisisEngine()


def handler(job: dict[str, Any]) -> dict[str, Any]:
    payload = job.get("input")
    if not isinstance(payload, dict):
        return {"error": "job has no `input` object"}
    return dispatch(payload, _engine)


if __name__ == "__main__":
    import runpod

    runpod.serverless.start(
        {
            "handler": handler,
            # One job at a time. The volume is shared and design section 26 fixes
            # `workersMax = 1` for exactly this reason: two concurrent runs could
            # activate different model versions between one another's steps.
            "concurrency_modifier": lambda _current: int(os.environ.get("MAX_CONCURRENCY", "1")),
        }
    )
