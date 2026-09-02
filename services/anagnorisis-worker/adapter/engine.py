"""The engine boundary (design section 51).

Anagnorisis is upstream code that moves on its own schedule. Everything this service
asks of it goes through the four methods below, so replacing it later — with a
different open model, or with something written here — is a matter of writing another
class, not of unpicking calls scattered through a handler.

Nothing above this file imports ``anagnorisis_core``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence


@dataclass(frozen=True)
class Item:
    """A piece of content, as the Worker describes it.

    Text only: title, channel, tags and description, assembled on the Cloudflare side.
    No audiovisual content is downloaded anywhere in this service (design section 3).
    """

    id: str
    text: str


@dataclass(frozen=True)
class RatedItem:
    """One training pair."""

    id: str
    text: str
    #: Anagnorisis scale, 0..10. The Worker has already doubled the user's 0..5.
    rating: float
    #: ISO 8601. Used as the memory file's date so that re-running training is idempotent.
    rated_at: str | None = None


@dataclass
class TrainOutcome:
    model_version: str
    model_path: str
    trained_event_count: int
    trained_seconds: float
    accuracy: dict[str, float] = field(default_factory=dict)


class PreferenceEngine(Protocol):
    """What this service needs a preference model to do."""

    def train(
        self,
        profile: str,
        model_version: str,
        events: Sequence[RatedItem],
        *,
        max_steps: int | None = None,
        time_budget_seconds: float | None = None,
    ) -> TrainOutcome:
        """Learn from every rating, and store the result under ``model_version``."""

    def score(self, profile: str, model_version: str, items: Sequence[Item]) -> list[float]:
        """Predict, on the 0..10 scale, what the user would rate each item."""

    def embed(self, profile: str, items: Sequence[Item]) -> tuple[list[list[float]], int]:
        """Vectors for each item, and their dimensionality."""

    def describe(self, profile: str, items: Sequence[Item]) -> list[str]:
        """A short description of each item, for text too long to use as it stands."""


class EngineError(RuntimeError):
    """Raised for a condition the caller can act on: no model, empty batch, bad version."""
