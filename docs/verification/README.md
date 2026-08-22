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
