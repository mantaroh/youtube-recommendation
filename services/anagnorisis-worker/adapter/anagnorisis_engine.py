"""Anagnorisis behind the engine interface (design sections 21 and 51).

Upstream is used as a library, not as an application. ``anagnorisis_core`` is the part
of it that has no Flask server and no database — it takes a ``project_config`` folder,
reads ratings from it and writes a model back — which is exactly the shape a serverless
GPU worker needs, and the reason design section 21 says not to expose the web UI.

Four upstream calls carry everything:

- ``api.rate_text(text, rating, cfg=..., memory_dir=..., when=...)`` writes one memory file
- ``api.train_evaluator(cfg=...)`` reads that folder and writes an evaluator
- ``api.score_text(text, cfg=...)`` predicts a rating for text
- ``get_omni_embedder(cfg).embed_long_text(text)`` produces a vector

Text-only throughout. Upstream can rate and score files, and none of that is used: this
system never downloads a video (design section 3).
"""

from __future__ import annotations

import time
from typing import Sequence

from .engine import EngineError, Item, PreferenceEngine, RatedItem, TrainOutcome
from . import storage
from .storage import ProfilePaths


class AnagnorisisEngine(PreferenceEngine):
    """The real engine. Importing upstream is deferred until a method is called.

    Constructing this is cheap and happens at container start; loading torch and the
    embedding weights costs seconds and gigabytes, and a container that is only being
    health-checked should not pay for it.
    """

    def __init__(self, volume=None) -> None:
        self._volume = volume
        self._config_cache: dict[str, object] = {}

    # -- configuration ----------------------------------------------------

    def _paths(self, profile: str) -> ProfilePaths:
        return storage.paths_for(profile, self._volume)

    def _cfg(self, paths: ProfilePaths):
        """Upstream configuration for one profile.

        Cached per profile because ``load_config`` reads and merges several layers, and
        a score batch would otherwise redo that work for every item.

        ``use_user_config=False`` on purpose: a serverless container has no user, and
        reading ``~/.config`` would make behaviour depend on whatever happened to be
        baked into the image.
        """
        cached = self._config_cache.get(paths.profile)
        if cached is not None:
            return cached

        try:
            from anagnorisis_core.config import load_config
        except ImportError as error:  # pragma: no cover - depends on the image
            raise EngineError(
                "anagnorisis_core is not installed in this image"
            ) from error

        cfg = load_config(
            project_config_path=str(paths.project_config),
            embedding_models_path=str(paths.embedding_models),
            use_user_config=False,
        )
        self._config_cache[paths.profile] = cfg
        return cfg

    # -- training ---------------------------------------------------------

    def train(
        self,
        profile: str,
        model_version: str,
        events: Sequence[RatedItem],
        *,
        max_steps: int | None = None,
        time_budget_seconds: float | None = None,
    ) -> TrainOutcome:
        if not events:
            raise EngineError("refusing to train on an empty rating set")

        from anagnorisis_core import api

        paths = self._paths(profile)
        cfg = self._cfg(paths)
        started = time.monotonic()

        # The Worker sends the complete current training set, so last run's files are
        # a stale copy of it rather than extra evidence.
        storage.clear_memory(paths)

        for event in events:
            api.rate_text(
                event.text,
                event.rating,
                cfg=cfg,
                memory_dir=str(paths.memory),
                # The date the memory file is filed under. Passing the real rating date
                # means re-running training writes the same files rather than a second
                # set under today's date.
                when=event.rated_at,
            )

        model_path = api.train_evaluator(
            cfg=cfg,
            max_steps=max_steps,
            time_budget_seconds=time_budget_seconds,
        )

        # Upstream writes to its own fixed path. Copying it to a staging file and
        # renaming is what makes the switch atomic (design section 48).
        staging = paths.staging_path(model_version)
        staging.write_bytes(_read_model(model_path, paths))
        final = storage.publish(paths, model_version)
        storage.prune_versions(paths)

        return TrainOutcome(
            model_version=model_version,
            model_path=str(final),
            trained_event_count=len(events),
            trained_seconds=time.monotonic() - started,
        )

    # -- inference --------------------------------------------------------

    def score(self, profile: str, model_version: str, items: Sequence[Item]) -> list[float]:
        if not items:
            return []

        from anagnorisis_core import api

        paths = self._paths(profile)
        # Refuse rather than silently score with whatever is loaded. A batch labelled
        # `model-12` whose numbers came from `model-11` would be cached under the wrong
        # version and never corrected.
        if not paths.version_path(model_version).is_file():
            raise EngineError(
                f"{model_version} is not on this volume; stored: {storage.stored_versions(paths)}"
            )
        storage.activate(paths, model_version)

        cfg = self._cfg(paths)
        return [float(api.score_text(item.text, cfg=cfg)) for item in items]

    def embed(self, profile: str, items: Sequence[Item]) -> tuple[list[list[float]], int]:
        if not items:
            return [], 0

        from anagnorisis_core.models.embedder import get_omni_embedder

        cfg = self._cfg(self._paths(profile))
        embedder = get_omni_embedder(cfg)

        vectors: list[list[float]] = []
        for item in items:
            produced = embedder.embed_long_text(item.text)
            if produced is None or len(produced) == 0:
                raise EngineError(f"the embedder returned nothing for {item.id}")
            # ``embed_long_text`` returns one vector per chunk. Averaging gives one
            # vector for the item, which is what a caller storing it per video wants.
            vectors.append(_mean(produced))

        return vectors, len(vectors[0])

    def describe(self, profile: str, items: Sequence[Item]) -> list[str]:
        if not items:
            return []

        from anagnorisis_core.media import description

        cfg = self._cfg(self._paths(profile))
        described: list[str] = []
        for item in items:
            body, _ = description.body_for_text(item.text, cfg=cfg, summarise=None)
            described.append(body or item.text)
        return described


def _read_model(model_path, paths: ProfilePaths) -> bytes:
    """The bytes upstream just wrote.

    ``train_evaluator`` returns where it saved; older versions return nothing useful,
    so the fixed active path is the fallback.
    """
    from pathlib import Path

    candidate = Path(str(model_path)) if model_path else paths.active_model
    if not candidate.is_file():
        candidate = paths.active_model
    if not candidate.is_file():
        raise EngineError(f"training reported success but no model was written to {candidate}")
    return candidate.read_bytes()


def _mean(vectors) -> list[float]:
    columns = list(zip(*vectors))
    return [float(sum(column) / len(column)) for column in columns]
