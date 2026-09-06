# Personal Recommender

A recommendation profile you own, built from ratings you can read, edit and take with
you.

The design document is the source of truth:
[`docs/design/personal-recommender-v2.ja.md`](docs/design/personal-recommender-v2.ja.md).
What it left open is recorded in
[`docs/design/implementation-notes.ja.md`](docs/design/implementation-notes.ja.md), and
[`docs/architecture.md`](docs/architecture.md) is the map.

The short version: platforms will not tell you what their objective function is, what
your profile says, or how much they explore on your behalf. This puts that profile
somewhere you can look at it. YouTube supplies the videos and says what exists; every
judgement about what you might want is made here.

## The split

```text
Cloudflare   knows what videos exist, and what you rated
Runpod       predicts what you would rate a video, then goes back to sleep
YouTube      holds the videos
```

The GPU is woken for training and for scoring a batch in advance. It is never in the
path of a request, so the feed keeps working while it is asleep — or down, or never
configured at all.

## Layout

| Path | What it is |
|---|---|
| `apps/web` | The React SPA and the Worker API, deployed together |
| `services/anagnorisis-worker` | The GPU container: Anagnorisis behind a thin adapter |
| `packages/domain` | Types, schemas, and the two replaceable interfaces |
| `migrations` | The D1 schema, applied in order |

## Getting started

```bash
pnpm install
pnpm test                                   # 160 tests
pnpm typecheck

cd apps/web
npx wrangler d1 migrations apply catalog --local
npx wrangler dev                            # http://127.0.0.1:8787
```

That runs with no credentials at all. The feed will be empty until there is a catalog;
`node tools/verify-screenshots.mjs` seeds one and drives the whole application in a real
browser, which is also the fastest way to see what it does.

To read your own subscriptions, follow
[`docs/setup-youtube-credentials.md`](docs/setup-youtube-credentials.md). To train a
model, follow [`services/anagnorisis-worker/README.md`](services/anagnorisis-worker/README.md).

The Python side has its own tests:

```bash
cd services/anagnorisis-worker && python -m pytest tests -q   # 35 tests
```

## How it works

- **Ratings ask the right question.** Not "was this good" but "how much do you want to
  see videos like this from now on". A video can be excellent and still be something you
  want less of, and only this axis can say so. Unrated and "no more of this" are
  different states and stay different.
- **The rating log is the record.** Re-rating appends; retracting marks. Nothing is
  overwritten, which is what makes "I liked this in April and cooled on it in August" a
  thing the data can express rather than a thing it silently loses.
- **The model is derived, and says so.** A trained model can be rebuilt from the
  ratings. The ratings cannot be recovered from a model. Only one of those is backed up
  as if it mattered.
- **No model call in the ranking path.** The score is a formula — a prediction plus five
  named bonuses and two penalties — so it is reproducible, costs nothing to run, and can
  always be spelled out. The GPU contributes exactly one of those terms, in advance.
- **Three lanes, and you set the mix.** What you subscribe to, what the model is
  confident about, and what it knows nothing about. Whether today is for going deeper or
  for finding something unfamiliar is your decision, not something inferred for you.
- **Interests are yours to edit.** Every row of the preferences screen is one term of
  the scoring function. Turning one down takes effect on the next feed, not after the
  next training run.

## Verification

Unit tests cover the ranking, the schema and the job ledger.
[`docs/verification`](docs/verification/RUN.md) covers the thing actually running in a
browser, with screenshots and a record of what that found.

## Limits worth knowing

- Only metadata is read — title, description, tags, channel, category, duration,
  publication date. No audiovisual content is downloaded, anywhere, by anything.
- What reaches the GPU is the title, channel, tags and a truncated description. No OAuth
  token, Access identity, address or cookie goes with it.
- Everything is behind Cloudflare Access with an allow-list. This is built to be run by
  one person for themselves; publishing it as a service would need an API compliance
  review first.
