"""Make stdio UTF-8, before anything writes to it.

On a Japanese Windows install the console codepage is cp932, and a training run that
prints an em dash dies with ``UnicodeEncodeError`` partway through — after the model
has loaded and the embeddings have been computed, which is the expensive part. The
progress line is not worth losing a run over.

Applied to the environment as well as to this process's own streams, because the
engine spawns subprocesses for the embedder and the evaluator and they inherit the
codepage, not our stream settings. That is where the failure actually surfaced.

Call this first thing in an entry point, before any subprocess is started.
"""

from __future__ import annotations

import os
import sys


def use_utf8_io() -> None:
    # Inherited by every child process. `PYTHONIOENCODING` covers stdio in children
    # that do not opt into UTF-8 mode; `PYTHONUTF8` covers the rest of their text
    # handling, including paths.
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("PYTHONUTF8", "1")

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            # `backslashreplace` rather than `strict`: a character the terminal cannot
            # draw should degrade to an escape, not end the job.
            reconfigure(encoding="utf-8", errors="backslashreplace")
        except (ValueError, OSError):
            # A stream that cannot be reconfigured — a pipe already in text mode, or a
            # captured buffer under a test runner — is not a reason to refuse to run.
            pass
