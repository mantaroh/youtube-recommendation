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

        # `models_path`, not `embedding_models_path`: the README documents the latter
        # and the shipped signature takes the former. Verified against 0.4.10.
        cfg = load_config(
            project_config_path=str(paths.project_config),
            models_path=str(paths.embedding_models),
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
        _keep_models_resident(cfg)
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
                when=_as_date(event.rated_at),
            )

        probe = _AccuracyProbe()
        model_path = api.train_evaluator(
            cfg=cfg,
            ctx=probe,
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
            accuracy=probe.accuracy,
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
        _keep_models_resident(cfg)

        # Reported as it goes, not at the end. A batch is 250 items and each one embeds
        # text before it can be scored, so a run that says nothing for an hour is
        # indistinguishable from a run that has hung — and the only way to find out how
        # long a batch takes is to watch a partial one.
        scores: list[float] = []
        started = time.monotonic()
        for index, item in enumerate(items, start=1):
            scores.append(float(api.score_text(item.text, cfg=cfg)))
            if index == 1 or index % 10 == 0 or index == len(items):
                elapsed = time.monotonic() - started
                print(
                    f"[score] {index}/{len(items)}  {elapsed:.0f}s  {elapsed / index:.1f}s/item",
                    flush=True,
                )
        return scores

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


def _keep_models_resident(cfg, seconds: int = 7200) -> None:
    """Stops upstream from unloading models between items.

    Both the embedder and the evaluator run in subprocesses that a watchdog kills after
    two minutes without a call, to free GPU memory. On a GPU that threshold is never
    reached: an item embeds in seconds, so the next call always arrives first.

    On a CPU it is reached on every single item. Embedding one video's text takes longer
    than the timeout, and ``_execute`` holds its lock for the whole call, so from the
    watchdog's side the evaluator has simply been idle — it is killed mid-batch and
    reloaded for the next item. A measured run spent 81 seconds an item doing this, with
    five subprocess restarts in the first ten items.

    The embedder reads its timeout from configuration. The evaluator hardcodes it, so
    the attribute is set directly on the singleton. That is reaching into upstream and it
    can stop working silently if the name changes — which is why ``score`` prints its
    rate as it goes: if the seconds an item do not fall, this stopped taking effect.
    """
    try:
        from omegaconf import open_dict

        with open_dict(cfg):
            cfg.embedder.idle_timeout_seconds = seconds
    except Exception:  # noqa: BLE001 - a stale attribute name must not fail the run
        pass

    try:
        from anagnorisis_core.models.universal_evaluator import UniversalEvaluator

        # A singleton: this is the same object `api.score_text` will use.
        UniversalEvaluator()._idle_timeout = seconds
    except Exception:  # noqa: BLE001
        pass


class _AccuracyProbe:
    """Catches the accuracies the trainer reports, which it does not return.

    ``train_universal_evaluator`` computes a best epoch and train and test accuracy,
    prints them, and hands them to its progress callback — then returns none of it. The
    numbers matter here for one reason: a run cut short by its time budget still
    finishes "successfully" and can leave a model that predicts one constant, and the
    test accuracy is the only signal that says so. Without this, that model is stored,
    activated and ranked with, and nothing anywhere records that it is useless.

    The final message has a fixed shape — ``Best Epoch: N, Train Accuracy: X%, Test
    Accuracy: Y%`` — so it is matched rather than parsed. If upstream reworks the
    wording this stops finding anything, which loses a diagnostic and breaks nothing.
    """

    def __init__(self) -> None:
        self.accuracy: dict[str, float] = {}

    # The progress interface upstream expects: check() and update(fraction, message).
    def check(self) -> None:
        return None

    def update(self, fraction: float, message: str) -> None:
        import re

        found = re.search(r"Train Accuracy: ([\d.]+)%.*?Test Accuracy: ([\d.]+)%", message)
        if found:
            self.accuracy["train"] = float(found.group(1)) / 100
            self.accuracy["test"] = float(found.group(2)) / 100
        epoch = re.search(r"Best Epoch: (\d+)", message)
        if epoch:
            self.accuracy["bestEpoch"] = float(epoch.group(1))
        if "Time budget" in message:
            # Recorded as a fact rather than an error: hitting the ceiling is only a
            # problem if the model also failed to learn, and the accuracies say that.
            self.accuracy["timeBudgetReached"] = 1.0


def _as_date(rated_at: str | None):
    """The ISO timestamp our protocol carries, as the ``date`` upstream wants.

    ``save_text_rating`` files a memory under ``memory/<date>/`` and calls
    ``.isoformat()`` on whatever it is given, so a string reaches it as an
    ``AttributeError`` rather than a date. Only the day matters: two ratings of the
    same text on the same day are the same memory file, which is what makes re-running
    a training set idempotent.
    """
    import datetime

    if not rated_at:
        return None
    try:
        # `fromisoformat` in 3.11 accepts the trailing Z, but not every producer emits
        # one, so the parse is guarded rather than assumed.
        return datetime.datetime.fromisoformat(rated_at.replace("Z", "+00:00")).date()
    except ValueError:
        return None


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
