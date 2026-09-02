"""Request and response shapes (design sections 22 through 24).

One endpoint, ``operation`` inside the envelope. Parsing lives here rather than in the
handler so that a malformed request is rejected with a sentence naming the field,
rather than a ``KeyError`` traceback that bills for a container start and says nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from .engine import Item, RatedItem

OPERATIONS = ("train", "score_batch", "embed_batch", "describe_batch")


class PayloadError(ValueError):
    """A request that cannot be acted on. Reported as a 400-shaped error, not a crash."""


@dataclass(frozen=True)
class TrainRequest:
    profile: str
    model_version: str
    events: list[RatedItem]
    max_steps: int | None
    time_budget_seconds: float | None


@dataclass(frozen=True)
class BatchRequest:
    profile: str
    model_version: str
    items: list[Item]


def parse_operation(payload: dict[str, Any]) -> str:
    operation = payload.get("operation")
    if operation not in OPERATIONS:
        raise PayloadError(f"unknown operation {operation!r}; expected one of {', '.join(OPERATIONS)}")
    return str(operation)


def _body(payload: dict[str, Any]) -> dict[str, Any]:
    """The operation's fields.

    Design section 22 nests them under ``payload`` and section 23 writes them directly
    under ``input``. Both are accepted, because a request that works everywhere is
    worth more than a document that is right in one place.
    """
    nested = payload.get("payload")
    if isinstance(nested, dict):
        return nested
    return {key: value for key, value in payload.items() if key != "operation"}


def parse_train(payload: dict[str, Any]) -> TrainRequest:
    body = _body(payload)
    profile = _profile(body)
    model_version = _model_version(body)

    raw_events = body.get("events")
    if not isinstance(raw_events, list) or not raw_events:
        raise PayloadError("train needs a non-empty `events` list")

    events: list[RatedItem] = []
    for index, entry in enumerate(raw_events):
        if not isinstance(entry, dict):
            raise PayloadError(f"events[{index}] is not an object")
        item_id = entry.get("itemId")
        description = entry.get("description")
        rating = entry.get("rating")
        if not isinstance(item_id, str) or not item_id:
            raise PayloadError(f"events[{index}].itemId is missing")
        if not isinstance(description, str) or not description.strip():
            raise PayloadError(f"events[{index}].description is empty")
        if not isinstance(rating, (int, float)):
            raise PayloadError(f"events[{index}].rating is not a number")
        if not 0 <= float(rating) <= 10:
            raise PayloadError(f"events[{index}].rating is outside 0..10")
        rated_at = entry.get("ratedAt")
        events.append(
            RatedItem(
                id=item_id,
                text=description,
                rating=float(rating),
                rated_at=rated_at if isinstance(rated_at, str) else None,
            )
        )

    return TrainRequest(
        profile=profile,
        model_version=model_version,
        events=events,
        max_steps=_optional_int(body.get("maxSteps"), "maxSteps"),
        time_budget_seconds=_optional_float(body.get("timeBudgetSeconds"), "timeBudgetSeconds"),
    )


def parse_batch(payload: dict[str, Any], *, needs_model: bool) -> BatchRequest:
    body = _body(payload)
    profile = _profile(body)
    model_version = _model_version(body) if needs_model else ""

    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise PayloadError("this operation needs a non-empty `items` list")

    items: list[Item] = []
    for index, entry in enumerate(raw_items):
        if not isinstance(entry, dict):
            raise PayloadError(f"items[{index}] is not an object")
        item_id = entry.get("id")
        text = entry.get("text")
        if not isinstance(item_id, str) or not item_id:
            raise PayloadError(f"items[{index}].id is missing")
        if not isinstance(text, str) or not text.strip():
            raise PayloadError(f"items[{index}].text is empty")
        items.append(Item(id=item_id, text=text))

    return BatchRequest(profile=profile, model_version=model_version, items=items)


def score_response(items: Sequence[Item], scores: Sequence[float], model_version: str) -> dict[str, Any]:
    return {
        "modelVersion": model_version,
        "items": [{"id": item.id, "score": score} for item, score in zip(items, scores)],
    }


def embed_response(items: Sequence[Item], vectors: Sequence[Sequence[float]], dimensions: int) -> dict[str, Any]:
    return {
        "dimensions": dimensions,
        "items": [{"id": item.id, "vector": list(vector)} for item, vector in zip(items, vectors)],
    }


def describe_response(items: Sequence[Item], descriptions: Sequence[str]) -> dict[str, Any]:
    return {
        "items": [
            {"id": item.id, "description": description}
            for item, description in zip(items, descriptions)
        ]
    }


def _profile(body: dict[str, Any]) -> str:
    profile = body.get("profile") or body.get("profileId") or "default"
    if not isinstance(profile, str) or not profile:
        raise PayloadError("`profile` must be a non-empty string")
    return profile


def _model_version(body: dict[str, Any]) -> str:
    model_version = body.get("modelVersion")
    if not isinstance(model_version, str) or not model_version:
        raise PayloadError("`modelVersion` is required")
    return model_version


def _optional_int(value: Any, name: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or value <= 0:
        raise PayloadError(f"`{name}` must be a positive number")
    return int(value)


def _optional_float(value: Any, name: str) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or value <= 0:
        raise PayloadError(f"`{name}` must be a positive number")
    return float(value)
