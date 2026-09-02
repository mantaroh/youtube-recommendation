"""The Anagnorisis adapter (design section 51)."""

from .engine import EngineError, Item, PreferenceEngine, RatedItem, TrainOutcome
from .dispatch import dispatch

__all__ = [
    "EngineError",
    "Item",
    "PreferenceEngine",
    "RatedItem",
    "TrainOutcome",
    "dispatch",
]
