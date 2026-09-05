"""Prove the engine works on this machine, end to end (design section 55, phase 0).

Runs the same code path the Worker would: the same envelopes, through the same
``dispatch``, against the real ``AnagnorisisEngine``. Nothing here is a mock, so a pass
means training and scoring genuinely work here — which on a CPU-only machine is the
thing actually in question.

    python tools/local_smoke.py [--volume PATH] [--keep]

The first run downloads about 3.4 GB of model weights into the volume's cache. Later
runs reuse them.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter.anagnorisis_engine import AnagnorisisEngine  # noqa: E402
from adapter.console import use_utf8_io  # noqa: E402
from adapter.dispatch import dispatch  # noqa: E402

use_utf8_io()

# Deliberately two-sided and bilingual: the point is to see whether the model separates
# what this reader wants more of from what they want less of, and whether it does so
# across scripts. A one-sided set would train a model that predicts the mean.
TRAINING: list[tuple[str, float, str]] = [
    ("k1", 10, "Linuxカーネルのスケジューラを読む\nChannel: Kernel Corner\nTags: linux, kernel, scheduler"),
    ("k2", 10, "ページキャッシュの仕組み\nChannel: Kernel Corner\nTags: linux, kernel, memory"),
    ("k3", 9, "Inside the Linux virtual memory subsystem\nChannel: Systems Deep Dive\nTags: linux, kernel, memory"),
    ("b1", 9, "ブラウザエンジンの内部構造\nChannel: Engine Room\nTags: firefox, browser, rendering"),
    ("b2", 8, "How Firefox paints a frame\nChannel: Engine Room\nTags: firefox, browser, rendering"),
    ("c1", 8, "コンパイラ最適化の基礎\nChannel: Compiler Notes\nTags: compiler, llvm"),
    ("c2", 7, "Type systems explained\nChannel: Compiler Notes\nTags: types, programming languages"),
    ("v1", 2, "【神回】爆笑ドッキリ仕掛けてみた結果www\nChannel: バラエティch\nTags: ドッキリ, 面白い"),
    ("v2", 2, "1000万円分の福袋を開封してみた\nChannel: 開封チャンネル\nTags: 開封, 福袋"),
    ("v3", 1, "Reacting to viral TikToks for 20 minutes\nChannel: Reaction Zone\nTags: reaction, tiktok"),
    ("v4", 1, "最強の筋トレルーティン公開\nChannel: Fitness Life\nTags: 筋トレ, フィットネス"),
    ("v5", 0, "赤ちゃんの可愛い瞬間まとめ\nChannel: ほのぼの動画\nTags: 赤ちゃん, 癒し"),
]

# Never rated. If the model has learned anything, the first two score above the last two.
HELD_OUT: list[tuple[str, str]] = [
    ("h1", "システムコールの実装を追う\nChannel: Kernel Corner\nTags: linux, kernel, syscall"),
    ("h2", "WebAssembly runtime internals\nChannel: Engine Room\nTags: wasm, browser"),
    ("h3", "話題のスイーツを food 全部食べてみた\nChannel: 大食いチャンネル\nTags: 大食い, グルメ"),
    ("h4", "Unboxing the newest phone\nChannel: Gadget Daily\nTags: unboxing, phone"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--volume", type=Path, help="stand in for /runpod-volume")
    parser.add_argument("--keep", action="store_true", help="do not delete a temporary volume")
    # Upstream trains for 5001 epochs when it is given no limit, which is seconds on a
    # GPU and does not finish in a sitting on a CPU. The budget is what makes this
    # runnable on the machine it is being proved on.
    parser.add_argument("--budget", type=float, default=300.0, help="seconds of training")
    arguments = parser.parse_args()

    volume = arguments.volume or Path(tempfile.mkdtemp(prefix="anag-smoke-"))
    volume.mkdir(parents=True, exist_ok=True)
    print(f"volume: {volume}")

    engine = AnagnorisisEngine(volume=volume)

    try:
        started = time.perf_counter()
        train_result = dispatch(
            {
                "operation": "train",
                "payload": {
                    "profile": "default",
                    "modelVersion": "model-1",
                    "timeBudgetSeconds": arguments.budget,
                    "events": [
                        {"itemId": i, "rating": r, "description": t, "ratedAt": "2026-08-01T00:00:00Z"}
                        for i, r, t in TRAINING
                    ],
                },
            },
            engine,
        )
        train_seconds = time.perf_counter() - started
        print(f"\n--- train ({train_seconds:.1f}s wall) ---")
        print(json.dumps(train_result, indent=2, ensure_ascii=False)[:600])
        if "error" in train_result:
            return 1

        started = time.perf_counter()
        score_result = dispatch(
            {
                "operation": "score_batch",
                "payload": {
                    "profile": "default",
                    "modelVersion": "model-1",
                    "items": [{"id": i, "text": t} for i, t in HELD_OUT],
                },
            },
            engine,
        )
        score_seconds = time.perf_counter() - started
        print(f"\n--- score ({score_seconds:.1f}s wall, {score_seconds/len(HELD_OUT):.2f}s per item) ---")
        if "error" in score_result:
            print(json.dumps(score_result, indent=2, ensure_ascii=False))
            return 1

        by_id = {entry["id"]: entry["score"] for entry in score_result["items"]}
        for item_id, text in HELD_OUT:
            print(f"  {by_id[item_id]:5.2f}  {text.splitlines()[0][:44]}")

        # The claim being tested: the two the reader would want outrank the two they
        # would not. A model that predicts the mean passes nothing here.
        wanted = min(by_id["h1"], by_id["h2"])
        unwanted = max(by_id["h3"], by_id["h4"])
        print(f"\n  wanted floor {wanted:.2f}  vs  unwanted ceiling {unwanted:.2f}")
        if wanted > unwanted:
            print("  SEPARATED: the model ranks the wanted pair above the unwanted pair")
        else:
            print("  NOT SEPARATED: twelve ratings may simply be too few to learn from")

        return 0
    finally:
        if arguments.volume is None and not arguments.keep:
            shutil.rmtree(volume, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
