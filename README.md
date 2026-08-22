# Personal Preference Recommender

A recommendation profile you own, kept outside the platform that serves you content.

The design document is the source of truth for what this is and why it is built this way:
[`docs/design/personal-preference-model-youtube-recommender-v1.en.md`](docs/design/personal-preference-model-youtube-recommender-v1.en.md).

The short version: existing platforms do not let you see or control their objective
function, your profile, how your interests decay, or how much they explore. This moves
that profile to your machine, where you can read it, edit it, and roll it back. YouTube is
the first source, not the point.

## The split

```text
Cloud   knows what videos exist
Local   knows what you like
```

Nothing crosses that line. Ratings, interests, embeddings and ranking all stay on this
machine. Search queries built from your interests go straight to YouTube, never through a
server of ours. The optional catalog service is never told who is asking or what they
want — it accepts a paging cursor and nothing else.

## Packages

| Package | What it is |
|---|---|
| `packages/shared` | Domain types, zod schemas, and the three replaceable interfaces |
| `packages/core` | Preference model, clustering, ranker and metrics. Pure TypeScript, no browser APIs |
| `packages/extension` | The extension: store, ingestion, feed, interest editor, experiment |
| `packages/worker` | Optional public catalog on Cloudflare Workers and D1 |

`core` reads no clock and touches no browser API, so the preference model can be exercised
on synthetic event streams under Node. That is what makes claims like "interests decay"
testable rather than a matter of opinion.

## Getting started

```bash
pnpm install
pnpm test           # 151 tests across the four packages
pnpm typecheck
pnpm --filter @ypr/extension build
```

Load `packages/extension/.output/chrome-mv3` as an unpacked extension in Chrome, or
`packages/extension/.output/firefox-mv2/manifest.json` as a temporary add-on in Firefox.

It works immediately, with no credentials: a built-in fixture catalog stands in for the
API so the preference model, the interest editor and the ranker can all be used offline.
To read your real subscriptions, follow
[`docs/setup-youtube-credentials.md`](docs/setup-youtube-credentials.md).

## How it works

- **Ratings ask the right question.** Not "was this good" but "how much do you want to see
  videos like this from now on". A video can be excellent and still be something you want
  less of, and only this axis can say so. Unrated and "no more of this" are different
  states and stay different.
- **The event log is the truth.** Nothing is overwritten: re-rating appends, forgetting an
  interest adds a tombstone. That is what makes "show me my interests as of April" a
  matter of stopping the replay early rather than a feature of its own.
- **Interests are a set, not a vector.** Averaging unrelated interests gives a point that
  represents neither and has nothing near it. Keeping them separate also means each row of
  the interest screen is exactly one term of the scoring function, so the model is
  editable and explainable for the same reason.
- **Three lanes, and you set the mix.** Subscriptions, near your interests, and away from
  them. Whether today is for going deeper or for finding something unfamiliar is your
  decision, not something inferred on your behalf.
- **Popularity is not a score.** A "at least N views" rule manufactures the bias this
  project exists to avoid. View count only decides which stratum an item is sampled from,
  and small and evergreen videos have reserved slots.
- **No model call in the ranking path.** The score is a formula, so it is reproducible,
  free to run, and can always be spelled out. Generation is used only to name clusters.

## Verification

Unit tests cover the model. [`docs/verification`](docs/verification/README.md) covers the
thing actually running in a browser, with screenshots and a record of what that found.

## Limits worth knowing

- Only metadata is ever read — title, description, tags, channel, official category,
  duration, publication date. Audiovisual content is never downloaded, and captions are
  not used. Catalog metadata carries a 30 day TTL; your own ratings do not expire.
- Publishing this as a service, rather than running it yourself, needs an API compliance
  review first. That gate is written into the design document.
