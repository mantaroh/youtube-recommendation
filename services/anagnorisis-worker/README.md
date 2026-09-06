# Anagnorisis worker

The GPU half of the system: it learns what you like from your ratings, and predicts what
you would rate videos you have not seen.

It is a Runpod Serverless endpoint with `workersMin = 0`, so it costs nothing while
nobody is training. The Cloudflare Worker submits a job and walks away; the result is
collected by a later cron pass (design sections 25, 28 and 29).

## What it is not

Anagnorisis ships a Flask application and a database. Neither is used. Only
`anagnorisis_core` is installed — the part of it that takes a `project_config` folder,
reads ratings out of it and writes a model back — because that is the whole of what a
serverless worker needs, and because design section 21 says not to expose the web UI.

Four upstream calls carry everything:

```python
api.rate_text(text, rating, cfg=..., memory_dir=..., when=...)   # one training pair
api.train_evaluator(cfg=...)                                     # folder in, model out
api.score_text(text, cfg=...)                                    # a predicted rating
get_omni_embedder(cfg).embed_long_text(text)                     # a vector
```

Text only. Upstream can rate and score files as well, and none of that is used: this
system never downloads a video (design section 3).

## Layout

```text
handler.py            Runpod entry point. Thin: it unwraps `input` and calls dispatch
cli.py                the same operations from a shell, for phases 0 and 1
adapter/
  engine.py           the four methods a preference engine has to have
  anagnorisis_engine.py   Anagnorisis behind them
  storage.py          the volume layout, and the atomic model switch
  payloads.py         request parsing, so a bad request is a sentence not a traceback
  dispatch.py         operation in, result out. No SDK, no GPU: testable
tests/
```

`dispatch.py` is deliberately separate from `handler.py`. Everything worth testing is on
one side of that line and the Runpod calling convention is on the other.

## Operations

One endpoint, `operation` inside the envelope (design section 22):

| Operation | What it does |
|---|---|
| `train` | Writes every rating as a memory file, trains, stores the result as `model-N` |
| `score_batch` | Predicts a 0..10 rating for each item, against a named model version |
| `embed_batch` | Vectors, for the day Vectorize is added (design section 54) |
| `describe_batch` | A short description of text too long to use as it stands |

```json
{
  "input": {
    "operation": "score_batch",
    "payload": {
      "profile": "default",
      "modelVersion": "model-12",
      "items": [{ "id": "youtube:abc", "text": "title + channel + tags + description" }]
    }
  }
}
```

Design section 23 writes the same request with its fields directly under `input`. The
parser accepts both, because a payload copied out of a job log should run unchanged.

## The volume

`/runpod-volume` survives scale-to-zero; `/tmp` does not.

```text
/runpod-volume/
├── models/                              shared embedding weights
├── cache/huggingface/                   downloaded model files
└── project_config/<profile>/
    ├── memory/                          rating memory files
    ├── models/
    │   ├── universal_evaluator.pt       the version currently loaded
    │   └── versions/model-N.pt          every stored version
    └── cache/
```

Two things to know about it:

- **The memory folder is a cache, not a record.** The Cloudflare side holds the ratings
  (design section 4.1) and sends the complete current set on every training run, so this
  folder is emptied and rewritten each time. Keeping the previous run's files would
  train on ratings the user has since replaced.
- **Model switching is a rename, never a write in place.** Training writes
  `model-15.tmp` and renames it once it has finished (design section 48). A run that
  dies halfway leaves a file nothing will load, rather than half a model that the next
  score request would happily use.

Both are only safe because the endpoint runs one worker (design section 26). With two
sharing this volume, one could activate a version while the other was mid-batch.

## Running it locally

```bash
python -m pytest tests -q          # 25 tests, no GPU, no upstream
```

The tests use a recording engine and a temporary directory, so they cover the part that
is ours: parsing, the volume layout, and the atomic switch.

For a real run, build the image and use the CLI:

```bash
docker build -t anagnorisis-worker .
docker run --rm --gpus all -v "$PWD/volume:/runpod-volume" anagnorisis-worker \
  python cli.py --file train.json
```

That is phase 0 and phase 1 of design section 55: find out whether the recommendations
are any good before there is anything to plug them into.

## Running it without Runpod

The engine also runs as a plain HTTP service, which is how to exercise the whole
pipeline on a machine that has no GPU account — and, on a machine with no GPU at all,
how to find out whether CPU inference is fast enough to be worth it.

```bash
python serve.py --volume ./volume --port 9000
```

Then point the Worker at it instead of Runpod:

```text
# apps/web/.dev.vars
PREFERENCE_ENGINE_URL="http://127.0.0.1:9000"
```

Nothing else changes. `serve.py` speaks the same three routes (`/run`,
`/status/{id}`, `/cancel/{id}`) and the same envelope, and runs jobs on a background
thread rather than inside the POST — so the job ledger, the polling pass, the
idempotency check and the atomic model switch are the real ones, not a simulation.
That is the whole reason it is worth having: a local engine that answered
synchronously would let a class of timing bug through untested.

One worker thread, matching `workersMax = 1` (design section 26). It binds to
localhost and authenticates nobody, so do not put it on an address anything else can
reach: it runs model training on request.

### Installing it on a machine

```bash
python -m venv .venv && . .venv/Scripts/activate   # or bin/activate

# torch first, from PyTorch's own index. PyPI has no wheels for some platforms that
# this index does — Windows on ARM among them.
pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision

# The core without its declared dependencies; see below.
pip install --no-deps anagnorisis-core

pip install numpy PyYAML omegaconf transformers sentence-transformers
pip install huggingface-hub accelerate safetensors tokenizers
pip install xxhash tinytag Pillow fs soundfile setproctitle
```

`--no-deps` for the core is deliberate. Upstream declares `librosa`,
`opencv-python-headless` and `torchaudio` for image, audio and video handling, and
this system reads none of those: it sends text (design section 3). On platforms where
those three have no wheel, installing them is a compiler toolchain's worth of work for
capability that is never called.

Two platform notes worth keeping, because both cost an hour to rediscover:

- **Windows on ARM**: PyYAML publishes `win_arm64` wheels only for Python 3.12 and
  later. On 3.11 it falls back to compiling, which needs MSVC. Build the pure-Python
  version instead: `PYYAML_FORCE_LIBYAML=0 pip install PyYAML`.
- **Long paths on Windows**: torch unpacks paths past the 260-character limit, so a
  virtualenv deep inside a project directory fails to install it. Put the environment
  somewhere short.

### Checking it works

```bash
python tools/local_smoke.py --volume ./volume
```

Twelve ratings in, a model out, four held-out items scored — through the same
`dispatch` the service uses, with the real engine. It reports whether the two items
the ratings imply the reader wants outrank the two they do not, which is a weaker
claim than "the model is good" and a much stronger one than "it ran".

The first run downloads about 3.4 GB of model weights into the volume. On CPU, expect
training and scoring to be minutes rather than seconds.

## Deploying

The image is the same for every profile — nothing user-specific is baked in — so it can
be built once and pushed to any registry Runpod can read. Then:

- endpoint: `workersMin = 0`, `workersMax = 1`, idle timeout 300s, FlashBoot on
- GPU: 16 GB is the floor; Anagnorisis expects at least 8 GB of VRAM
- volume: ~40 GB, mounted at `/runpod-volume`
- the Cloudflare Worker needs `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` as secrets

`ANAGNORISIS_REF` in the Dockerfile pins the upstream commit. Bump it deliberately and
read the diff first: this is the one dependency whose behaviour, not just its API, the
recommendations depend on.

## Letting this machine collect the work

`serve.py` waits to be called, which means being reachable from the internet and being
awake whenever the Worker decides to call. The runner inverts that: nothing listens,
nothing is exposed, and this machine decides when it is free enough.

```bash
set ENGINE_PULL_TOKEN=...
python tools/pull_runner.py --url https://yt.mantaroh.com --volume ./volume \
    --window 01:00-07:00
```

The window is local time, and may cross midnight (`23:00-05:00`). `--once` takes at most
one job and stops, which is the way to try it before leaving it running.

The token comes from the environment rather than an argument, so it stays out of shell
history and out of the process list. On the Worker side, setting `ENGINE_PULL_TOKEN`
is what puts the system in this mode: jobs are then left in the ledger instead of being
submitted anywhere.

A claimed job is held under a lease. If this machine is switched off mid-run, the job
returns to the queue on the next reconciliation pass rather than being stranded — so
closing the laptop costs a repeat of the work, not the loss of it.

See `docs/design/pull-engine.ja.md`.
