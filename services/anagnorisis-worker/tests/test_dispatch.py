"""The operation surface, exercised without a GPU.

A recording engine stands in for Anagnorisis. What is being checked here is the part
that is ours: that a malformed request is refused with a sentence rather than a
traceback, that both envelope shapes parse, and that each operation reaches the engine
with the arguments it was given.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter.dispatch import dispatch  # noqa: E402
from adapter.engine import EngineError, Item, RatedItem, TrainOutcome  # noqa: E402


class RecordingEngine:
    def __init__(self, *, fail: Exception | None = None) -> None:
        self.calls: list[tuple] = []
        self.fail = fail

    def train(self, profile, model_version, events, *, max_steps=None, time_budget_seconds=None):
        if self.fail:
            raise self.fail
        self.calls.append(("train", profile, model_version, list(events), max_steps, time_budget_seconds))
        return TrainOutcome(
            model_version=model_version,
            model_path=f"/runpod-volume/{model_version}.pt",
            trained_event_count=len(events),
            trained_seconds=1.5,
        )

    def score(self, profile, model_version, items):
        if self.fail:
            raise self.fail
        self.calls.append(("score", profile, model_version, list(items)))
        return [7.5 for _ in items]

    def embed(self, profile, items):
        self.calls.append(("embed", profile, list(items)))
        return [[0.1, 0.2, 0.3] for _ in items], 3

    def describe(self, profile, items):
        self.calls.append(("describe", profile, list(items)))
        return [f"about {item.id}" for item in items]


def train_payload(**overrides):
    payload = {
        "operation": "train",
        "payload": {
            "profile": "default",
            "modelVersion": "model-3",
            "events": [
                {"itemId": "youtube:a", "rating": 10, "description": "kernel internals"},
                {"itemId": "youtube:b", "rating": 2, "description": "unboxing"},
            ],
        },
    }
    payload["payload"].update(overrides)
    return payload


def test_train_reaches_the_engine_with_every_event():
    engine = RecordingEngine()
    result = dispatch(train_payload(), engine)

    assert result["modelVersion"] == "model-3"
    assert result["trainedEventCount"] == 2
    operation, profile, version, events, _, _ = engine.calls[0]
    assert (operation, profile, version) == ("train", "default", "model-3")
    assert [event.rating for event in events] == [10.0, 2.0]
    assert isinstance(events[0], RatedItem)


def test_the_rating_date_is_carried_through():
    """Without it, re-running training files the same rating under a second date."""
    engine = RecordingEngine()
    dispatch(
        train_payload(
            events=[
                {
                    "itemId": "youtube:a",
                    "rating": 8,
                    "description": "text",
                    "ratedAt": "2026-04-01T00:00:00Z",
                }
            ]
        ),
        engine,
    )
    assert engine.calls[0][3][0].rated_at == "2026-04-01T00:00:00Z"


def test_score_batch_returns_one_score_per_item_in_order():
    engine = RecordingEngine()
    result = dispatch(
        {
            "operation": "score_batch",
            "payload": {
                "profile": "default",
                "modelVersion": "model-3",
                "items": [{"id": "a", "text": "one"}, {"id": "b", "text": "two"}],
            },
        },
        engine,
    )
    assert result["items"] == [{"id": "a", "score": 7.5}, {"id": "b", "score": 7.5}]
    assert result["modelVersion"] == "model-3"


def test_the_flat_envelope_from_design_section_23_also_parses():
    """Section 22 nests the fields, section 23 does not. Both have to work."""
    engine = RecordingEngine()
    result = dispatch(
        {
            "operation": "score_batch",
            "profile": "default",
            "modelVersion": "model-9",
            "items": [{"id": "a", "text": "one"}],
        },
        engine,
    )
    assert result["items"] == [{"id": "a", "score": 7.5}]


def test_embed_batch_reports_its_dimensionality():
    result = dispatch(
        {"operation": "embed_batch", "payload": {"profile": "p", "items": [{"id": "a", "text": "x"}]}},
        RecordingEngine(),
    )
    assert result["dimensions"] == 3
    assert result["items"][0]["vector"] == [0.1, 0.2, 0.3]


def test_describe_batch_returns_one_description_per_item():
    result = dispatch(
        {"operation": "describe_batch", "payload": {"profile": "p", "items": [{"id": "a", "text": "x"}]}},
        RecordingEngine(),
    )
    assert result["items"] == [{"id": "a", "description": "about a"}]


@pytest.mark.parametrize(
    "payload,expected",
    [
        ({"operation": "nonsense"}, "unknown operation"),
        ({"operation": "train", "payload": {"modelVersion": "model-1", "events": []}}, "non-empty"),
        (
            {"operation": "train", "payload": {"modelVersion": "model-1", "events": [{"itemId": "a", "rating": 11, "description": "x"}]}},
            "outside 0..10",
        ),
        (
            {"operation": "train", "payload": {"modelVersion": "model-1", "events": [{"itemId": "a", "rating": 5, "description": "  "}]}},
            "description is empty",
        ),
        ({"operation": "score_batch", "payload": {"items": [{"id": "a", "text": "x"}]}}, "modelVersion"),
    ],
)
def test_a_malformed_request_is_reported_not_raised(payload, expected):
    result = dispatch(payload, RecordingEngine())
    assert "error" in result
    assert expected in result["error"]


def test_an_engine_failure_becomes_a_sentence_the_worker_can_store():
    engine = RecordingEngine(fail=EngineError("model-3 is not on this volume"))
    result = dispatch(train_payload(), engine)
    assert result == {"error": "model-3 is not on this volume"}


def test_an_unexpected_failure_still_returns_a_result():
    """Runpod records a raised exception as a bare failure; this keeps the reason."""
    engine = RecordingEngine(fail=RuntimeError("CUDA out of memory"))
    result = dispatch(train_payload(), engine)
    assert result["error"] == "RuntimeError: CUDA out of memory"


def test_items_are_passed_through_as_typed_objects():
    engine = RecordingEngine()
    dispatch(
        {"operation": "embed_batch", "payload": {"profile": "p", "items": [{"id": "a", "text": "x"}]}},
        engine,
    )
    assert engine.calls[0][2] == [Item(id="a", text="x")]
