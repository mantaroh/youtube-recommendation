"""The network volume layout (design sections 27 and 48).

Two things this file is responsible for, and both are about surviving a worker that
disappears mid-run:

- **Where things live.** The volume is mounted at ``/runpod-volume`` and survives
  scale-to-zero, so it holds the downloaded embedding weights, the per-profile memory
  files and the trained evaluators. Anything under ``/tmp`` is gone when the worker
  stops.

- **The atomic switch.** A training run writes ``model-15.tmp`` and renames it to
  ``model-15`` only once it has finished (design section 48). A run that dies halfway
  leaves a ``.tmp`` file that nothing reads, rather than a half-written model that the
  next score request would load.

Design section 27 draws the layout with ``trained/`` and ``cache/`` beside
``project_config/``. Anagnorisis derives both of those from ``project_config_path``
itself — ``<project_config>/models`` and ``<project_config>/cache`` — so they live
inside it here. Fighting that would mean patching upstream configuration handling for
no gain, which is the thing design section 51 says not to do.
"""

from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

#: Where Runpod mounts the network volume on a serverless worker.
DEFAULT_VOLUME = Path(os.environ.get("ANAGNORISIS_VOLUME", "/runpod-volume"))

#: The file name Anagnorisis loads a trained evaluator from.
ACTIVE_MODEL_NAME = "universal_evaluator.pt"

_VERSION_PATTERN = re.compile(r"^model-\d+$")


@dataclass(frozen=True)
class ProfilePaths:
    """Every path one profile's work touches."""

    profile: str
    #: Anagnorisis ``project_config``: memory, cache and personal models.
    project_config: Path
    #: Shared embedding weights, downloaded once and reused by every profile.
    embedding_models: Path

    @property
    def memory(self) -> Path:
        return self.project_config / "memory"

    @property
    def personal_models(self) -> Path:
        return self.project_config / "models"

    @property
    def versions(self) -> Path:
        return self.personal_models / "versions"

    @property
    def active_model(self) -> Path:
        return self.personal_models / ACTIVE_MODEL_NAME

    def version_path(self, model_version: str) -> Path:
        return self.versions / f"{model_version}.pt"

    def staging_path(self, model_version: str) -> Path:
        return self.versions / f"{model_version}.tmp"


def paths_for(profile: str, volume: Path | None = None) -> ProfilePaths:
    """Resolve a profile's directories, creating them if this is the first run."""
    root = volume or DEFAULT_VOLUME
    safe = _safe_profile(profile)

    paths = ProfilePaths(
        profile=safe,
        project_config=root / "project_config" / safe,
        embedding_models=root / "models",
    )
    for directory in (paths.project_config, paths.memory, paths.personal_models, paths.versions, paths.embedding_models):
        directory.mkdir(parents=True, exist_ok=True)
    return paths


def _safe_profile(profile: str) -> str:
    """A profile id that cannot escape its own directory.

    The profile arrives over the network. Without this, ``../../`` in a profile name
    would let a request write anywhere on the volume.
    """
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", profile or "")
    if not cleaned:
        raise ValueError(f"unusable profile id: {profile!r}")
    return cleaned


def publish(paths: ProfilePaths, model_version: str) -> Path:
    """Move a finished model into place, and make it the one that loads.

    ``os.replace`` is atomic on the same filesystem, which is what makes the switch
    safe: a concurrent score request either sees the whole old model or the whole new
    one, never a file being written.
    """
    _check_version(model_version)
    staging = paths.staging_path(model_version)
    if not staging.is_file():
        raise FileNotFoundError(f"nothing staged at {staging}")

    final = paths.version_path(model_version)
    os.replace(staging, final)
    activate(paths, model_version)
    return final


def activate(paths: ProfilePaths, model_version: str) -> Path:
    """Point ``universal_evaluator.pt`` at one stored version.

    Anagnorisis loads the evaluator from a fixed file name, so selecting a version
    means putting that version's bytes there. Copied to a temporary name and renamed
    rather than written in place, for the same reason as :func:`publish`.

    Safe only because the endpoint runs a single worker (design section 26). With two
    workers sharing this volume, one could activate a version while the other was
    scoring against a different one.
    """
    _check_version(model_version)
    source = paths.version_path(model_version)
    if not source.is_file():
        raise FileNotFoundError(f"no stored model at {source}")

    staging = paths.personal_models / f".{ACTIVE_MODEL_NAME}.tmp"
    shutil.copyfile(source, staging)
    os.replace(staging, paths.active_model)
    return paths.active_model


def stored_versions(paths: ProfilePaths) -> list[str]:
    """Versions on disk, newest first."""
    found = [
        path.stem
        for path in paths.versions.glob("model-*.pt")
        if _VERSION_PATTERN.match(path.stem)
    ]
    return sorted(found, key=lambda name: int(name.split("-")[1]), reverse=True)


def clear_memory(paths: ProfilePaths) -> int:
    """Empty the memory folder before writing a training set.

    The memory files are a cache of what D1 already holds, not the record: design
    section 4.1 makes the rating events the source of truth and everything downstream
    a derivative that can be rebuilt. The Worker sends the complete current training
    set on every run, so keeping the previous run's files would train the model on
    ratings the user has since replaced.
    """
    removed = 0
    for entry in paths.memory.iterdir():
        if entry.is_dir():
            removed += sum(1 for _ in entry.rglob("*.md"))
            shutil.rmtree(entry)
        elif entry.suffix == ".md":
            entry.unlink()
            removed += 1
    return removed


def prune_versions(paths: ProfilePaths, keep: int = 5) -> list[str]:
    """Delete all but the newest few versions.

    A model is a few tens of megabytes and the volume is billed by the gigabyte
    (design section 58). Keeping five leaves room to roll back through a bad run
    without paying to store every model ever trained.
    """
    versions = stored_versions(paths)
    removed: list[str] = []
    for name in versions[keep:]:
        paths.version_path(name).unlink(missing_ok=True)
        removed.append(name)
    return removed


def _check_version(model_version: str) -> None:
    if not _VERSION_PATTERN.match(model_version):
        raise ValueError(f"malformed model version: {model_version!r}")
