"""Turning a request into a result (design section 22).

Kept apart from ``handler.py`` so that the whole operation surface can be exercised
without the Runpod SDK, a GPU, or a network. ``handler.py`` is then only the adapter
between Runpod's calling convention and this function.
"""

from __future__ import annotations

from typing import Any

from .engine import EngineError, PreferenceEngine
from . import payloads


def dispatch(payload: dict[str, Any], engine: PreferenceEngine) -> dict[str, Any]:
    """Run one operation and return its output.

    Errors come back as ``{"error": ...}`` rather than as an exception. Runpod records
    a raised exception as a failed job with a traceback; a structured error lets the
    Worker store a sentence in ``gpu_jobs.error`` that says what to fix.
    """
    try:
        operation = payloads.parse_operation(payload)

        if operation == "train":
            request = payloads.parse_train(payload)
            outcome = engine.train(
                request.profile,
                request.model_version,
                request.events,
                max_steps=request.max_steps,
                time_budget_seconds=request.time_budget_seconds,
            )
            return {
                "modelVersion": outcome.model_version,
                "modelPath": outcome.model_path,
                "trainedEventCount": outcome.trained_event_count,
                "trainedSeconds": outcome.trained_seconds,
                **({"accuracy": outcome.accuracy} if outcome.accuracy else {}),
            }

        if operation == "score_batch":
            request = payloads.parse_batch(payload, needs_model=True)
            scores = engine.score(request.profile, request.model_version, request.items)
            return payloads.score_response(request.items, scores, request.model_version)

        if operation == "embed_batch":
            request = payloads.parse_batch(payload, needs_model=False)
            vectors, dimensions = engine.embed(request.profile, request.items)
            return payloads.embed_response(request.items, vectors, dimensions)

        request = payloads.parse_batch(payload, needs_model=False)
        descriptions = engine.describe(request.profile, request.items)
        return payloads.describe_response(request.items, descriptions)

    except payloads.PayloadError as error:
        return {"error": f"bad request: {error}"}
    except EngineError as error:
        return {"error": str(error)}
    except Exception as error:  # noqa: BLE001 - the boundary has to report, not crash
        return {"error": f"{type(error).__name__}: {error}"}
