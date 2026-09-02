"""The volume layout and the atomic model switch (design sections 27 and 48).

These run against a temporary directory rather than a network volume. What matters
here is the file-level behaviour: that a half-finished training run leaves nothing
loadable, that activating a version replaces the active file completely, and that a
profile id cannot walk out of its own directory.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import storage  # noqa: E402


def test_paths_are_created_on_first_use(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)

    assert paths.memory.is_dir()
    assert paths.versions.is_dir()
    assert paths.embedding_models == tmp_path / "models"
    # Anagnorisis derives memory and personal models from project_config, so they have
    # to sit inside it rather than beside it.
    assert paths.memory.parent == paths.project_config
    assert paths.personal_models.parent == paths.project_config


def test_a_profile_id_cannot_escape_its_directory(tmp_path: Path):
    paths = storage.paths_for("../../etc", tmp_path)
    assert paths.project_config == tmp_path / "project_config" / "etc"


def test_an_unusable_profile_id_is_refused(tmp_path: Path):
    with pytest.raises(ValueError):
        storage.paths_for("../", tmp_path)


def test_publishing_renames_the_staged_file_and_activates_it(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    paths.staging_path("model-1").write_bytes(b"weights")

    final = storage.publish(paths, "model-1")

    assert final == paths.version_path("model-1")
    assert final.read_bytes() == b"weights"
    assert not paths.staging_path("model-1").exists()
    assert paths.active_model.read_bytes() == b"weights"


def test_a_run_that_died_halfway_leaves_nothing_loadable(tmp_path: Path):
    """The point of the staging name: a `.tmp` file is not a model anything will load."""
    paths = storage.paths_for("default", tmp_path)
    paths.staging_path("model-2").write_bytes(b"half")

    assert storage.stored_versions(paths) == []
    assert not paths.active_model.exists()


def test_activating_replaces_the_active_model_completely(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    for version, body in (("model-1", b"first"), ("model-2", b"second-and-longer")):
        paths.staging_path(version).write_bytes(body)
        storage.publish(paths, version)

    storage.activate(paths, "model-1")

    # A shorter model must not leave a tail of the longer one behind it.
    assert paths.active_model.read_bytes() == b"first"


def test_activating_a_version_that_is_not_here_fails_loudly(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    with pytest.raises(FileNotFoundError):
        storage.activate(paths, "model-7")


def test_a_malformed_version_name_is_refused(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    with pytest.raises(ValueError):
        storage.activate(paths, "../../etc/passwd")


def test_stored_versions_are_ordered_by_number_not_by_name(tmp_path: Path):
    """`model-10` sorts before `model-9` as a string, and after it as a version."""
    paths = storage.paths_for("default", tmp_path)
    for version in ("model-2", "model-9", "model-10"):
        paths.staging_path(version).write_bytes(b"x")
        storage.publish(paths, version)

    assert storage.stored_versions(paths) == ["model-10", "model-9", "model-2"]


def test_pruning_keeps_the_newest_and_removes_the_rest(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    for index in range(1, 8):
        paths.staging_path(f"model-{index}").write_bytes(b"x")
        storage.publish(paths, f"model-{index}")

    removed = storage.prune_versions(paths, keep=3)

    assert storage.stored_versions(paths) == ["model-7", "model-6", "model-5"]
    assert set(removed) == {"model-4", "model-3", "model-2", "model-1"}


def test_clearing_memory_removes_every_rating_file(tmp_path: Path):
    paths = storage.paths_for("default", tmp_path)
    (paths.memory / "2026-04-01").mkdir(parents=True)
    (paths.memory / "2026-04-01" / "a.md").write_text("8\n\ntext", encoding="utf-8")
    (paths.memory / "b.md").write_text("2\n\ntext", encoding="utf-8")

    removed = storage.clear_memory(paths)

    assert removed == 2
    assert list(paths.memory.iterdir()) == []
