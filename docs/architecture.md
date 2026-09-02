# Architecture

The design document is the source of truth:
[`design/personal-recommender-v2.ja.md`](design/personal-recommender-v2.ja.md), with the
decisions it left open recorded in
[`design/implementation-notes.ja.md`](design/implementation-notes.ja.md). This page is
the map: what runs where, and why the boundaries fall where they do.

## The three places

```text
Cloudflare                  Runpod                     YouTube
──────────                  ──────                     ───────
knows what videos exist     predicts what you would    holds the videos
remembers what you rated    rate a video               reports what exists
decides what to show        asleep unless asked
always on
```

The split is not about tidiness. Cloudflare is always awake and costs nothing to keep
that way; a GPU costs money for every minute it is warm. So everything that has to
answer a request lives on Cloudflare, and the GPU is woken only for work that can wait:
training, and scoring a batch in advance.

A consequence worth stating plainly: **no GPU call happens while a feed is being built**
(design section 33). The feed reads scores that were computed earlier. If Runpod is
down, asleep, or has never been configured, the application still works — it simply
stops learning anything new (design section 49).

## Request path

```text
                          ┌──────────────────────┐
   Browser ──────────────▶│ Cloudflare Access    │  one policy, one allow-list
                          └──────────┬───────────┘
                                     ▼
   ┌─────────────────────────────────────────────────────────┐
   │  Worker  (apps/web)                                     │
   │                                                         │
   │   /            ──▶ assets ──▶ React SPA                 │
   │   /api/*       ──▶ routes/                              │
   │                      │                                  │
   │                      ├─ recommendation/  the score      │
   │                      ├─ discovery/       candidates     │
   │                      ├─ model/           GPU jobs       │
   │                      ├─ youtube/         API + OAuth    │
   │                      └─ backup/          export         │
   │                      │                                  │
   │                      ▼                                  │
   │                     D1 ─── R2                           │
   └─────────────────────────────────────────────────────────┘
                                     │  /run, then /status later
                                     ▼
                          ┌──────────────────────┐
                          │ Runpod Serverless    │  workersMin 0, workersMax 1
                          │  handler.py          │
                          │  adapter/            │
                          │  anagnorisis_core    │
                          └──────────┬───────────┘
                                     ▼
                              Network Volume
```

The SPA and the Worker are one deployment. That is not a packaging convenience: sharing
an origin is what lets a single Access policy protect both, and what means there are no
cross-origin credentials anywhere in the system.

## What crosses each boundary

| Boundary | What goes across | What does not |
|---|---|---|
| Browser → Worker | The rating, the interest keyword, the request | Nothing else; the browser holds no key |
| Worker → YouTube | An API key, or an OAuth token for `subscriptions.list` only | The user's ratings, interests, or feed |
| Worker → Runpod | Video title, channel, tags, truncated description, rating | OAuth token, Access identity, email, cookie, address |
| Worker → R2 | The export bundle | — |

The Runpod row is design section 44, and it is enforced by construction: the payload
types in `packages/domain/src/runpod.ts` have no field that could carry an identity, and
the text is assembled in one place (`services/model/text.ts`) so that what is sent can
be read rather than inferred.

## Data, and which of it matters

```text
rating_events     cannot be rebuilt from anything          ← the point of the system
interest_controls cannot be rebuilt                        ← written by hand
─────────────────────────────────────────────────────────
videos, channels  re-crawlable, at the cost of quota
recommendation_scores  regenerable by one GPU run
model_versions    regenerable from rating_events
gpu_jobs          bookkeeping
impressions       regenerable in the sense that it does not matter if lost
```

Everything below the line is derived. Everything above it is backed up to R2 on a
schedule and exportable at any moment from the settings screen, because a system that
holds your preferences hostage is the thing this one exists not to be (design sections
45 and 61).

## The two replaceable pieces

Design sections 51 and 52 ask for YouTube and Anagnorisis to be swappable. Both are
behind an interface, and the interfaces are the load-bearing part:

- `ContentSource` (`packages/domain/src/interfaces.ts`) — everything that knows YouTube
  exists is behind this. A Podcast or RSS source is another implementation, not a schema
  change: rows are keyed by `source:external_id` throughout.
- `PreferenceEngine` (`services/anagnorisis-worker/adapter/engine.py`) — four methods,
  and nothing above the file imports `anagnorisis_core`. The Worker never imports
  anything from Anagnorisis at all; it submits jobs described in its own terms.

## Scheduled work

One `scheduled` handler dispatches on the hour (design section 41):

| UTC | Work |
|---|---|
| 00:00 | Pull the subscription list, then walk uploads |
| 06:00 | Search for candidates, then score what is new |
| 12:00 | Walk uploads |
| 18:00 | Reconcile GPU jobs |
| Sunday 18:00 | Retrain if it is due, then back up to R2 |

## Costs, and what controls them

| | Controlled by |
|---|---|
| YouTube `search.list` | 30 of 100 daily calls, counted in `api_quota_usage` before each call |
| YouTube everything else | 1 unit per call; ~80 units a day for the upload walk |
| Runpod GPU | Woken for training and batch scoring only; `workersMin = 0` |
| Runpod volume | ~40 GB; old model versions pruned to the newest five |
| Cloudflare | Workers Paid for D1 and cron |

## Layout

```text
apps/web/                    the SPA and the Worker, one deployment
  src/                       React
  worker/
    routes/                  the eleven endpoints of design section 40
    services/                youtube, discovery, recommendation, model, runpod, backup
    db/                      D1 access
    scheduled/               cron dispatch
services/anagnorisis-worker/ the GPU container
packages/domain/             types, schemas, and the two replaceable interfaces
migrations/                  D1 schema, applied in order
docs/                        design, notes, verification
```
