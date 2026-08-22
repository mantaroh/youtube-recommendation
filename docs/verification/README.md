# Browser verification

Evidence that the extension runs, not just that the unit tests pass. Reproduce with:

```bash
pnpm --filter @ypr/extension build:chrome
node tools/verify-screenshots.mjs --headed
```

The script loads the built extension into a real Chromium profile, drives the interface,
records every page error, and writes the screenshots in this directory.

Run on 2026-08-22 (JST) against commit `4493331` plus the fixes it produced.

## What the run establishes

| Step | Screenshot | Result |
|---|---|---|
| Extension loads, service worker starts | `1-status-empty.png` | Dashboard opens, store empty |
| Ingestion and embedding | `2-status-after-ingest.png` | 5 items fetched and embedded |
| Feed before any rating | `3-feed-before-rating.png` | Items listed with rating controls |
| Interest search | `3b-status-after-discovery.png` | Queries built from interests, budget accounted |
| Ranked feed | `4-feed-ranked.png` | Lane tags, reasons and scores rendered |
| Interest editor | `5-interests.png` | Cluster materialised, controls present |
| Comparison experiment | `6-evaluation.png` | Trial recorded, metrics table rendered |
| Credentials screen | `7-settings.png` | Redirect URI shown for registration |

The embedding backend reported `Xenova/multilingual-e5-small · 384 dimensions`, so the
real sentence encoder ran in the browser rather than the lexical fallback. No page errors
were logged.

## What the run found

Two defects, both fixed, and neither of which the unit tests could have caught.

**The sentence encoder never actually ran.** Transformers.js fetches the ONNX runtime
from a CDN at run time, which `script-src 'self'` blocks outright in an MV3 extension.
The engine fell back to the lexical backend and reported success, so from the outside
everything looked fine. Fixed by copying the runtime into the extension at build time
(`packages/extension/tools/copy-onnx-runtime.mjs`) and pointing the library at it. A
second run then failed to *compile* the WebAssembly, because the default extension policy
forbids that too; the manifest now declares `wasm-unsafe-eval`, which permits compilation
without loosening where code may be loaded from.

The fallback behaving correctly is what made this invisible: a system that degrades
quietly needs the degraded state to be visible, which is why the Status tab now reports
which backend is in use.

**The empty feed gave the opposite advice to the one needed.** After rating every item in
a thin catalog, the feed said "rate a few videos so the model has something to work from"
— when the actual problem was that everything had already been rated and more needed
fetching. `buildFeed` now distinguishes an empty catalog from an exhausted one.

## Second run: against the deployed catalog

```bash
node tools/verify-screenshots.mjs --headed --catalog https://ypr-catalog.mantaroh.workers.dev
```

The worker was deployed with a real API key and crawled 298 videos. The extension synced
all of them, embedded 305 items with the real encoder, and produced a 24 item feed across
all three lanes with no page errors (`8-shared-catalog-sync.png`, `9-feed-real-catalog.png`).

The mechanism works end to end. The *output* exposed two problems that no test asserts on,
because both are questions of whether the numbers mean anything rather than whether the
code runs.

**Sentence encoder similarities sit in a narrow high band.** Across the real catalog,
cosine similarity to the single interest ranged roughly 0.77–0.86 — and the 0.86 end was a
computer-history video while the 0.77 end was a Japanese variety short. Absolute thresholds
are therefore close to meaningless here, which has three consequences:

- `τ = 0.55` cannot separate anything. Every rating fell into one cluster, which is why the
  interest reads "Unix · Archive · Computer" and why there is only ever one of them.
- `Novelty = 1 − max cos` is compressed into roughly 0.14–0.23, so the explore term barely
  distinguishes candidates.
- Scores bunch together: the related lane ran 1.76–1.79 across completely unrelated videos.

The design assumed similarity spread over a usable range. It does not with this model
family. Fixing it properly means calibrating similarity — ranking or standardising against
the candidate distribution rather than comparing raw cosines to a constant — which is a
change to section 3, not a constant to nudge.

**The shared catalog is popularity-defined at source.** `chart=mostPopular` is
preference-independent, which is what makes it safe to run on a server, but everything it
returns is by definition already popular. Section 4.3 reserves slots for emerging and
evergreen videos specifically to avoid manufacturing popularity bias, and the shared
catalog cannot fill those slots: every item it supplies is established-tier. In this run
that showed up as a related lane full of viral shorts.

The interim change made here was to stop the interface overclaiming: it now names the
*nearest* interest and shows the figure, rather than asserting a video is "close to" an
interest on the strength of a number near the floor of its own range.

## Known limitations of this run

- It runs against the fixture catalog, so the numbers are small: the subscription window
  looks back 30 days and the fixtures span 120, which leaves 5 items. A live account would
  produce a fuller feed.
- The related and explore lanes came back empty for the same reason. Both exclude channels
  the user already follows, and in the fixture set almost everything matching the interest
  queries belongs to a followed channel. This is a property of the fixture data rather
  than of the ranker; the lane quotas themselves are covered by unit tests.
- With the real encoder, the browser, operating system and computer history topics merged
  into a single interest at `τ = 0.55`. That is plausible — they are genuinely close in a
  semantic space — but it suggests the threshold wants tuning against real ratings. It is
  exposed as a setting for exactly this reason (design section 3.4).
