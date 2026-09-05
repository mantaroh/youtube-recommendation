"""Run one operation from the command line (design section 55, phases 0 and 1).

Phase 0 is "start Anagnorisis locally and find out whether its recommendations are any
good", and phase 1 is "get it running on Runpod, callable from a shell". Both need a
way in that is not the Worker, because at that point there is no Worker.

Reads the same JSON the endpoint takes, so a payload that works here works there:

    python cli.py --file train.json
    echo '{"operation":"score_batch","payload":{...}}' | python cli.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from adapter.console import use_utf8_io
from adapter.dispatch import dispatch


def main(argv: list[str] | None = None) -> int:
    use_utf8_io()
    parser = argparse.ArgumentParser(description="Run one Anagnorisis operation locally")
    parser.add_argument("--file", type=Path, help="request JSON; defaults to stdin")
    parser.add_argument(
        "--volume",
        type=Path,
        help="stand in for /runpod-volume, so this can run without one",
    )
    arguments = parser.parse_args(argv)

    raw = arguments.file.read_text(encoding="utf-8") if arguments.file else sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"could not parse the request: {error}", file=sys.stderr)
        return 2

    # Accept both the bare operation and Runpod's `{"input": {...}}` envelope, so a
    # payload copied out of a job log runs unchanged.
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        payload = payload["input"]

    from adapter.anagnorisis_engine import AnagnorisisEngine

    engine = AnagnorisisEngine(volume=arguments.volume)
    result = dispatch(payload, engine)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 1 if "error" in result else 0


if __name__ == "__main__":
    raise SystemExit(main())
