> **Superseded.** This design put the preference model in a browser extension and kept
> ratings on one machine. The system described here no longer exists: see
> [`personal-recommender-v2.ja.md`](personal-recommender-v2.ja.md) for what replaced it,
> and [`implementation-notes.ja.md`](implementation-notes.ja.md) for what that
> implementation decided.
>
> It is kept because it is the record of a set of arguments — why ratings ask "how much
> more of this" rather than "was this good", why interests are a set rather than a
> vector, why popularity decides a stratum rather than a score — that the replacement
> inherited rather than reconsidered. The conclusion it reached about *where* the model
> should run is the part that changed.

# Personal Preference Model / YouTube Recommender V1 Design Document

- Created: 2026-08-22 (JST)
- Status: Approved and implemented, Phases 0–6 (2026-08-22 JST). Where the build departs from this document, see the implementation notes appendix.
- Target repository: `youtube-recommendation`
- Source of truth: this document. All design changes are made here first; any derived material (translations, review renderings) follows it.

---

## 0. Problem Statement

This system is **not** defined as a “replacement for YouTube recommendations.” Framing the problem on the assumption that recommendation systems necessarily create echo chambers would be too strong given the findings of current audit research. Some studies have observed misinformation filter bubbles, while large-scale sock-puppet audits have also reported results that do not support the simple claim that “the algorithm consistently pushes users toward more extreme views.”

Therefore, the problem is defined as follows:

> Existing platform recommendation systems do not give users sufficient visibility into or control over their objective functions, user profiles, interest decay, or exploration rates.

> Therefore, **move ownership and control of the recommendation profile to the user side**.

YouTube is only the first experimental environment. The ultimate research subject is the **Platform-independent Personal Preference Model**. V1 will not implement multi-platform support, but the data model will treat `source` as a first-class key so that Article / Podcast sources can be added later.

---

## 1. Architecture and Trust Boundary

Decision: **All preference-dependent processing, including candidate retrieval, must be completed locally.**

```text
   ┌──────────────────────────────────────────────────────────┐
   │ YouTube Data API v3                                      │
   │   OAuth: subscriptions / playlistItems                   │
   │   API key: search / videos                               │
   └───────┬───────────────────────────────────┬───────────────┘
           │ User's own OAuth token            │ Shared API key
           │ (preference-related requests)     │ (preference-independent crawling)
           ▼                                   ▼
╔══════════════════════════════════╗   ┌──────────────────────────┐
║ Browser Extension (trust boundary)║  │ Cloudflare Worker        │
║                                  ║  │ Hono + D1                │
║ Source Adapter                   ║  │                          │
║ Local Catalog Cache (IndexedDB)  ║◀─│ Public Content Catalog   │
║ Embedding (Transformers.js)      ║  │   metadata + TTL 30 days │
║ Preference Model                 ║  │   provenance             │
║ Interest Clusters                ║  │                          │
║ Local Ranker (brute-force ANN)   ║  │ V1: optional. The        │
║ Feed UI / Interest UI            ║  │ extension works without it│
╚══════════════════════════════════╝   └──────────────────────────┘
           │
           ▼
   YouTube Embedded Player (iframe)
```

The only information sent to Cloudflare is a request for “what videos exist in the world.” **No information indicating who likes what is ever sent.** Preference vectors, interest labels, subscription lists, and search queries never cross the trust boundary.

### 1.1 Consequences of This Choice (Changes from the Original Proposal)

Moving preference-dependent nearest-neighbor search to the local side changes the following three points from the original proposal.

1. **V1 does not use Vectorize.** At a scale of several thousand to several tens of thousands of videos, brute-force cosine similarity over 384 dimensions is fast enough (see §4.4), so an ANN index is unnecessary. Only the `CatalogVectorStore` interface is defined, and the only implementation provided is `LocalStore`. `CloudflareVectorizeStore` can be added later if scale becomes a problem. This preserves the original principle: “Do not make Vectorize the architecture; make it one interchangeable implementation.”

2. **Exploration of unknown videos (`search.list`) is performed by calling YouTube directly from the extension.** Search queries themselves reveal interests, so they must not pass through the Worker. If the destination is limited to YouTube, the additional disclosure to a party that already has the user’s viewing history is close to zero.

3. **The Worker is no longer a mandatory component.** In V1, the Worker is limited to “crawling and sharing a broad preference-independent catalog, while avoiding embedding an API key in the extension.” The extension continues to work with subscribed channels and its own searches even if the Worker is unavailable. The Worker package will exist, but implementation is optional and deferred to Phase 5.

---

## 2. Data Model

### 2.1 Separation of Source of Truth and Derived Data

| Category | Content | Storage | Regenerable |
|---|---|---|---|
| Source of truth | **Event sequence** for ratings, interest operations, and viewing | IndexedDB `events` (append-only) | No (single source of truth) |
| External | Video metadata | IndexedDB `items` / D1 | Yes, can be fetched again from YouTube |
| Derived | embedding | IndexedDB `embeddings` | Yes, recomputed from events + metadata |
| Derived | interest clusters / preference vectors | IndexedDB `clusters` / `snapshots` | Same as above |

**Do not treat embeddings as the source of truth for user data.** If the model is replaced, all embeddings can be recomputed while preserving the event sequence, and a new preference model can be rebuilt.

```text
Rating history (source of truth / immutable)
    ↓ recompute with embedding model B
New preference model
```

### 2.2 Events (Source of Truth)

```ts
type Event =
  | { seq: number; ts: string; type: 'rating';
      source: 'youtube'; externalId: string;
      rating: 0|1|2|3|4|5 }
  | { seq: number; ts: string; type: 'interest_override';
      clusterId: string;
      op: 'pin' | 'mute' | 'forget' | 'set_strength' | 'rename';
      value?: number; label?: string; untilTs?: string }
  | { seq: number; ts: string; type: 'watch';
      source: 'youtube'; externalId: string;
      watchedSeconds: number; durationSeconds: number }
  | { seq: number; ts: string; type: 'impression';
      source: 'youtube'; externalId: string; lane: Lane; position: number }
```

- **Unrated and 0 must always be distinguished.** Unrated means that no event exists; 0 is an explicit negative rating meaning “I do not want this anymore.”
- `watch` / `impression` events are **recorded even in V1**, but their score contribution is shipped with weight 0 (feature flag). Because the system uses event sourcing, they can be enabled retroactively later simply by assigning them weights.
- Interest operations are also events. This makes it possible to completely reconstruct “myself as of April 2026,” including both ratings and interest edits.

### 2.3 Catalog Items (External, with TTL)

```ts
interface CatalogItem {
  source: 'youtube'
  externalId: string
  title: string
  description: string
  tags: string[]
  channelId: string
  channelTitle: string
  officialCategoryId: string     // Official YouTube category. Do not overwrite with custom inference.
  durationSeconds: number
  publishedAt: string
  viewCount: number
  metadataFetchedAt: string
  expiresAt: string              // metadataFetchedAt + 30 days
  provenance: 'youtube_api'
}

interface EmbeddingRecord {
  source: 'youtube'
  externalId: string
  modelId: string                // e.g. 'Xenova/multilingual-e5-small'
  generatedAt: string
  vector: Float32Array           // 384 dimensions
}

interface RatingRecord {         // Latest state derived from events
  source: 'youtube'
  externalId: string
  rating: 0|1|2|3|4|5
  ratedAt: string
}
```

Data originating from external services (`CatalogItem`) and feedback generated by the user (`RatingRecord`) are stored in separate tables. The former expires by TTL and is refetched, while the latter persists permanently. This separation supports both the compliance requirements in §6 and future multi-platform support.

### 2.4 IndexedDB Schema (Dexie)

```ts
db.version(1).stores({
  events:     '++seq, ts, type, [source+externalId]',
  items:      '[source+externalId], channelId, publishedAt, expiresAt',
  embeddings: '[source+externalId], modelId',
  ratings:    '[source+externalId], ratedAt',      // derived
  clusters:   'id, updatedAt',                     // derived
  snapshots:  'atSeq',                             // derived (for faster reconstruction)
  settings:   'key',
})
```

`ratings` / `clusters` / `snapshots` can be completely rebuilt from `events` + `items` + `embeddings` even if they are deleted.

---

## 3. Preference Model

### 3.1 Do Not Use a Single Vector (Change from the Original Proposal)

Representing the original `P_long` as one vector breaks down for users with multiple distinct interests. Averaging the embeddings for “browser internals” and “Chinese language learning” produces a centroid that represents neither topic and may have no meaningful items nearby.

Instead, the model is represented as a **set of interest clusters**, and the score takes the **maximum value across clusters**.

```text
Long term interests
 ├─ Web Browser Internals   0.91   [pinned]
 ├─ Operating Systems       0.86
 ├─ Computer History        0.74
 ├─ Embedded Systems        0.62
 └─ AI                      0.41   [muted for 30 days]
```

This structure maps one-to-one to the interest management UI in §5. **Each row shown on screen is directly one term in the scoring formula.** The greatest advantage of this design is that explainability and editability arise naturally from the model itself.

### 3.2 Clustering

- Method: leader clustering (online / incremental). For each newly positively rated embedding `e`, assign it to the existing cluster with maximum cosine similarity if that similarity is at least the threshold `τ = 0.55`; otherwise create a new cluster.
- The centroid is the weighted average of member embeddings (weights use `w(r)` defined below).
- Maximum number of clusters: `K_max = 40`. If exceeded, merge the cluster with the smallest mass into another cluster.
- Labels: automatically name clusters by extracting top TF-IDF terms from the titles and tags of their member videos. **Users can rename them** (renaming is also an `interest_override` event).
- Leader clustering is chosen instead of k-means for three reasons: it supports incremental updates, does not require predefining the number of clusters, and is deterministic during reconstruction (processing the same event sequence in the same order reproduces the same result).

### 3.3 Rating Weights

```text
rating   0      1      2      3      4      5
w(r)    -1.00  -0.60  -0.25   0.00  +0.50  +1.00
```

Since 3 means “neutral,” `w(3) = 0`. The negative side is intentionally asymmetric because the UI meaning of the difference between “☆1 and ☆0” is larger than that between “☆4 and ☆5” (`☆0` alone means “I do not want this anymore”). This table should be extracted as a constant in `packages/core` so it can be tuned experimentally.

### 3.4 Time Decay and Four Components

```text
Mass (long term)   m_c = Σ_{i∈c} w(r_i)                                   no decay
Mass (short term)  s_c = Σ_{i∈c} w(r_i) · exp(-ln2 · Δt_i / H_short)
Negative mass      n_c = Σ_{i∈c, w<0} |w(r_i)| · exp(-ln2 · Δt_i / H_neg)
Explicit strength  x_c = user-defined value (null if unset)
```

| Constant | Value | Meaning |
|---|---|---|
| `H_short` | 14 days | Half-life of short-term interest |
| `H_neg` | 60 days | Half-life of negative interest (persists longer than positive interest) |
| `τ` | 0.55 | Cosine threshold for cluster assignment |
| `K_max` | 40 | Maximum number of clusters |

The problem of “something I was intensely interested in three months ago being recommended forever” is addressed by exponential decay in `s_c`. Conversely, the problem of “something I rated ☆0 returning too quickly” is reduced by using a longer `H_neg`.

### 3.5 Cluster Activity and User Operations

```text
a_c = clamp( w_L · norm(m_c) + w_S · norm(s_c) + w_E · x_c , 0, 1 )
```

Order of user-operation application:

| Operation | Effect |
|---|---|
| Pin | Set the lower bound of `a_c` to 0.8. Not affected by decay |
| Mute (temporary) | Set `a_c = 0` until `untilTs` |
| Forget this interest | Tombstone the cluster and exclude its member events from future cluster reconstruction |
| Set strength | Set `x_c` and enable the contribution of `w_E` |

“Forget” **does not delete events**. It only appends a tombstone event. Therefore, it is reversible and remains compatible with time travel.

### 3.6 Time Travel (`Restore myself as of April 2026`)

`rebuildAt(t)` reconstructs clusters and preference state by applying only events with `ts <= t`, in sequence. Because the event sequence is the source of truth and all derived state can be deterministically recomputed, this feature requires no additional mechanism. `snapshots` are only an optimization to avoid a full scan on every reconstruction.

---

## 4. Ranking

### 4.1 Scoring Function

```text
score(v) =   w_c · C(v)                  channel affinity
           + w_l · S_long(v)             similarity to long-term interests
           + w_s · S_short(v)            similarity to short-term interests
           - w_n · S_neg(v)              similarity to negative interests
           + w_e · Novelty(v)            distance from known regions
           + w_f · Freshness(v)          recency
           - Penalty(v)                  already seen / already rated
```

```text
S_long(v)    = max_c  a_c · norm(m_c) · cos(e_v, μ_c)
S_short(v)   = max_c  a_c · norm(s_c) · cos(e_v, μ_c)
S_neg(v)     = max_c  norm(n_c) · cos(e_v, μ_c)
Novelty(v)   = 1 - max_c cos(e_v, μ_c)
Freshness(v) = exp(-ln2 · Δt_pub / 30 days)
C(v)         = (Σ_{i∈ch(v)} w(r_i)) / (|ch(v)| + κ)     κ = 3 (Bayesian smoothing)
```

The reason for using `max_c` is explained in §3.1. Smoothing in `C(v)` prevents a channel with only one rated video from being treated as perfect. Subscribed channels receive an additional constant bonus in `C(v)`.

### 4.2 Three Lanes

| Lane | Candidate source | Initial share |
|---|---|---|
| Subscription | Recent videos from subscribed channels' uploads playlists | 50–60% |
| Related | `search.list` results from interest-cluster terms + catalog neighbors | 25–35% |
| Explore | Candidates intentionally far from known interests (high `Novelty`) | 10–20% |

The proportions are derived from a “stable ←→ discovery” slider `s ∈ [0,1]`.

```text
Stable ←──────────────→ Discovery
        s = 0              s = 1

sub     = 0.60 - 0.30 s
related = 0.30
explore = 0.10 + 0.30 s
```

The system does not attempt to automatically eliminate echo chambers. **The user decides whether they want to go deeper into familiar topics today or discover unfamiliar ones.** This is the direct answer to the problem statement in §0.

### 4.3 Stratified Sampling by Popularity

A fixed condition such as “at least 1,000 views” would recreate popularity bias internally (popular → passes filter → recommended → becomes even more popular). Instead, sample in strata within the Related / Explore lanes.

| Stratum | Share | Condition |
|---|---:|---|
| established | 70% | Has reached a certain level of viewership |
| emerging | 20% | New / small channels |
| wild card | 10% | Popularity is mostly ignored. `Freshness` is also disabled so evergreen content can surface |

External mentions (web search, etc.) are **not treated as a mandatory quality criterion** because the amount of external information is itself a proxy for popularity. However, displaying “how this video or channel is discussed externally” as **supplementary explanatory information** is a candidate for V2 and later.

### 4.4 Diversity Re-ranking (MMR) and Computational Complexity

```text
MMR: argmax_v [ λ · score(v) - (1-λ) · max_{u∈selected} cos(e_v, e_u) ]   λ = 0.7
```

```text
CPU                    CPU
CPU                    Operating System
CPU          →         Computer History
CPU                    Electronics
CPU                    Programming Language History
```

Complexity estimate:

- Brute-force cosine similarity for 20,000 videos × 384 dimensions is approximately 7.68 million multiply-accumulate operations. If stored as a matrix in a contiguous `Float32Array` buffer, this should complete in tens of milliseconds in the browser.
- MMR is applied only to the top 300 candidates.

**At this scale, an ANN index is unnecessary**, which is the basis for removing Vectorize from V1 in §1.1.

### 4.5 No Bandit in V1

A non-stationary contextual bandit using rating values as rewards (Thompson Sampling / LinUCB) fits this problem, but it will not be included in V1. A deterministic scoring function must first establish a baseline; otherwise, it would be difficult to distinguish whether improvements come from bandit exploration or whether the scoring function itself is simply poor. Because `impression` events are recorded from the beginning, V2 can perform offline evaluation using historical logs.

### 4.6 Do Not Use an LLM for Core Recommendation

There is no need to send 100 candidates to an LLM on every request and ask it to choose. That approach is worse in cost, latency, and reproducibility, and more importantly, **it removes the ability to explain mathematically why a video was recommended**. Generative models are limited to “cluster naming” and “natural-language explanation of recommendation reasons.” The embedding model is central to recommendation, but it is a deterministic mapping rather than a generative model.

---

## 5. UI

### 5.1 Rating Axis (Original Proposal Retained)

Asking “How many points would you give this video?” cannot express **“It was a good video, but I do not want to see more of this genre.”** Therefore, the question is changed.

> **How much would you like to see videos like this in the future?**

```text
☆☆☆☆☆   I do not want this anymore
★☆☆☆☆
★★☆☆☆
★★★☆☆   Neutral
★★★★☆
★★★★★   I want to see more
```

Unrated and 0 must always remain distinct (§2.2). To leave room for a V2 expansion into two axes—“content quality” and “desire to see more”—the `rating` event should be designed so that `contentRating` can be added later.

### 5.2 Manage Interests

| Interest | Strength | State |
|---|---:|---|
| Browser Engine | 85 | Pinned |
| OS Internals | 78 | Normal |
| AI Agents | 64 | Normal |
| Chinese Learning | 51 | Temporary |
| Investment | 18 | Muted |

```text
Show more ←────────────→ Show less

[Pin]  [Mute for 30 days]  [Forget this interest]  [Rename]
```

Also provide **“Restore myself as of April 2026”** (§3.6). This is where user agency over recommendation appears in a form that is almost entirely absent from existing platform recommendation systems.

### 5.3 Presentation Surface

In V1, **do not rewrite the DOM of youtube.com**. The extension displays the user’s own feed on a standalone page (new tab / side panel), and playback uses the YouTube embedded player (iframe). Injecting into the existing UI is outside the V1 scope because it has heavier policy implications and would constantly break whenever YouTube changes its DOM.

---

## 6. YouTube API Usage and Compliance

### 6.1 Crawl Plan and Quota

| Purpose | Endpoint | Auth | Approx. units/day |
|---|---|---|---:|
| Fetch subscribed channels | `subscriptions.list` | OAuth | 2–4 |
| Identify uploads playlists | `channels.list` | OAuth | 2–4 |
| Fetch recent uploads | `playlistItems.list` | OAuth | about 100 for 100 channels |
| Explore unknown videos | `search.list` | API key | 60 calls |
| Complete metadata | `videos.list` | API key | about 60 calls at 50 items/call |

Cap `search.list` at 10 clusters × 3 queries × 2 runs/day = 60 calls.

> **Item to verify**: The original proposal states that, from June 2026 onward, `search.list` uses an independent quota bucket (standard 100 calls/day), but this must be confirmed against a primary source before implementation begins. If approval is given, the official documentation will be checked. Even if the quota number changes, the design can adapt through three parameters: number of clusters, number of queries, and execution frequency.

### 6.2 Compliance Requirements

| Item | Response |
|---|---|
| No downloading / caching / storing audio or video content without prior written approval | Never retrieve the video body. Thumbnails are referenced only by URL and are not cached |
| Caption retrieval | `captions.download` requires edit permission for the target video, so it cannot be used for arbitrary public videos. **Do not use it** |
| Delete or refresh unauthenticated API data within 30 days | `CatalogItem.expiresAt = fetchedAt + 30 days`. Both the extension and D1 include a cleanup job for expired data |
| Restrictions on independently inferring content categories/types from API Data | Do not overwrite official YouTube categories. Custom clusters are **private user interest labels** and are not published externally as video classifications |
| User-generated feedback | `rating` and similar data are first-party data and are not subject to the TTL (§2.3 separation is important here) |

Therefore, V1 features are limited to:

```text
Title / description / tags / channel / official category / duration / publish date / own rating
```

VLM analysis of the video body and time-lapse analysis are **excluded from V1 for policy reasons** (change from the original proposal).

> When turning this into a public service, do not assume that “YouTube API metadata → AI semantic embedding → persistent storage” is automatically permitted. Confirm this, including through an API Compliance Audit. **This is explicitly defined in the design document as a mandatory gate when moving beyond personal research.**

### 6.3 Why Preference Information Is Not Sent to Cloudflare

Cloudflare states that Workers AI Customer Content is not used for model training or service improvement. However, the requirement of this system is not merely “do not use it for training,” but the stricter rule **“do not send it in the first place.”** Therefore, Workers AI is not used. AI Gateway is also avoided because prompt / response logging is enabled by default (though it can be explicitly disabled), and the cleaner design is not to route preference information through it at all.

---

## 7. Package Structure and Replaceability

```text
youtube-recommendation/
├─ package.json              pnpm workspace root
├─ pnpm-workspace.yaml
├─ docs/design/              this design document
└─ packages/
   ├─ shared/                types / zod schemas / interface definitions (no dependencies)
   ├─ core/                  preference model / clustering / ranker / MMR (pure TS)
   ├─ extension/             WXT + React + Dexie + Transformers.js
   └─ worker/                Hono + D1 (Phase 5 / optional)
```

The key point is to keep `core` as pure TypeScript independent of the browser. The preference model and ranker can be unit-tested under Node, and synthetic event sequences can be used to verify “does an interest decay after three months?” and “does ☆0 have the intended effect?” **without launching a browser**.

### 7.1 Replaceable Components

```ts
// Inference engine: make WebLLM / llama.cpp server / vLLM / Ollama interchangeable
interface InferenceEngine {
  embed(texts: string[]): Promise<Float32Array[]>
  generate(messages: Message[]): Promise<string>   // cluster naming / explanation text only
}

// Catalog search: only LocalStore is implemented in V1
interface CatalogVectorStore {
  upsert(items: CatalogVector[]): Promise<void>
  query(vector: Float32Array, options: QueryOptions): Promise<Candidate[]>
}

// Source: YouTube / future Article / Podcast
interface SourceAdapter {
  readonly source: string
  listSubscriptionUpdates(since: string): Promise<CatalogItem[]>
  search(query: string, options: SearchOptions): Promise<CatalogItem[]>
  hydrate(externalIds: string[]): Promise<CatalogItem[]>
}
```

By introducing `InferenceEngine`, the system avoids dependence on any specific commercial API. The default V1 implementation uses Transformers.js (WebGPU, in-browser); only if a heavier model becomes necessary should it switch to a local `llama.cpp` server (OpenAI-compatible API).

### 7.2 Embedding Model

- Default: `Xenova/multilingual-e5-small` (384 dimensions, supports both Japanese and English)
- E5-family models require a `query: ` prefix on the query side and a `passage: ` prefix on the document side. This convention should be encapsulated inside the `InferenceEngine` implementation.
- Always store `EmbeddingRecord.modelId`, and recompute affected embeddings when the model changes. **The inner product is meaningless unless the catalog side and query side use the same model and dimensionality**, so a model-ID mismatch must be detected at runtime and trigger recomputation.

---

## 8. Implementation Phases

| Phase | Scope | Completion criterion |
|---|---|---|
| 0 | Workspace skeleton, `shared` types and zod schemas, `core` test infrastructure | `pnpm test` passes |
| 1 | Ingestion: OAuth subscriptions → recent uploads → `videos.list` → embedding → IndexedDB | Extension debug screen shows fetched item count and embedding count |
| 2 | Rating UI and event store (append-only, time-travel foundation) | Star ratings are recorded as events and survive restart |
| 3 | Preference model: clustering, decay, interest-management UI | Synthetic-event unit tests verify decay and mute behavior |
| 4 | Ranker: three lanes, stratified sampling, MMR, feed UI | Personal feed is displayed and videos can be played |
| 5 | Worker (optional): D1 catalog, `/catalog/since`, TTL cleanup | Add only after confirming the extension works without the Worker |
| 6 | Evaluation experiment (§9) | Comparison metrics can be produced from two weeks of logs |

Before starting each Phase, present the phase details (files to change / impact scope) and obtain approval again.

---

## 9. Evaluation Experiment

Compare against standard YouTube recommendations in Phase 6.

| Metric | Measurement method |
|---|---|
| Average satisfaction | Mean post-hoc star rating for the top 10 items |
| Rejection rate | Proportion rated ☆0 (“I do not want this anymore”) |
| Diversity | Entropy of official categories among displayed videos |
| Novelty | Proportion of videos from unsubscribed channels |
| Responsiveness to waning interest | Correlation over time between cluster activity `a_c` and actual star ratings |

Procedure: Each day, record the top 10 items from the personal feed and the top 10 items from the YouTube home feed side by side. On the following day, rate both sets with stars while hiding which system produced each item at the time of rating.

---

## 10. Rejected Alternatives

| Alternative | Reason for rejection |
|---|---|
| Make Vectorize a mandatory path in V1 | Preference vectors would be sent to the cloud, breaking the trust boundary (§1). It is also unnecessary at this scale (§4.4) |
| Represent preference as a single vector | The centroid becomes meaningless for users with multiple unrelated interests (§3.1) |
| Ask an LLM to select candidates every time | Worse cost / latency / reproducibility, and explainability is lost (§4.6) |
| Analyze video body / captions | Conflicts with Developer Policies and Captions API permission requirements (§6.2) |
| Replace the youtube.com DOM | Heavier policy implications and continuously fragile against YouTube changes (§5.3) |
| Use Workers AI / AI Gateway | Cannot satisfy the stricter rule of “do not send it” instead of merely “do not train on it” (§6.3) |
| Fixed “1,000+ views” filter | Reproduces popularity bias internally (§4.3) |
| Introduce a bandit in V1 | Without a deterministic baseline, the contribution of exploration cannot be isolated (§4.5) |

---

## 11. Impact Scope and Risks

Because this is a new repository, there is no impact on existing behavior. External impact and risks are as follows.

| Risk | Impact | Mitigation |
|---|---|---|
| YouTube API policy changes | Retrieval method may become unavailable | Encapsulate behind `SourceAdapter` and continuously monitor changes |
| Insufficient `search.list` quota | Exploration of unknown videos becomes narrower | Adjust the three parameters: cluster count, query count, frequency. Subscription lane remains unaffected |
| Viewing history cannot be fetched via API | “Already watched” detection is incomplete | Use a content script to detect viewing on youtube.com and record `watch` events |
| Cost of in-browser embedding | Initial ingestion is heavy | Batch processing + execute while idle. Initial model load is approximately 60–120 MB (obtain approval before execution) |
| Clustering quality | Interest granularity may be too coarse / too fine | Expose `τ` and `K_max` in settings and tune on real data |
| Moving from personal research to a public service | Compliance violation | Make the §6.2 gate mandatory |

---

## 12. Open Issues

1. The 2026 quota behavior of `search.list` (§6.1). Confirm against a primary source before implementation begins.
2. Preparation of a Google Cloud project and OAuth client (whether to use the user’s own quota or share a development client).
3. Initial weights for `w_c` through `w_f`. Determine them in Phase 4 using synthetic and real data.

---

## Appendix: implementation notes

Where the built system differs from this document, and why. Recorded during Phases 0–6 so
that the document stays the source of truth rather than drifting away from the code.

### Decisions the design left open

| Point | Resolution |
|---|---|
| `norm()` in section 3.5 | Long- and short-term mass are normalised against a **shared** scale (the largest long-term mass). Normalising each against its own maximum made decay invisible: a user with a single interest would see it rescaled to full strength however stale it was. A shared denominator also makes the two comparable, which a weighted sum requires. A regression test pins this down. |
| Popularity share rounding (section 4.3) | Largest remainder. Rounding each share independently gave the minority strata zero slots on small lanes, and the back-fill then handed those slots to the popular stratum — reintroducing the bias the strata exist to prevent. |
| Initial weights (open issue 3) | `channel 1.0, long 1.0, short 0.8, negative 1.2, explore 0.35, freshness 0.25, watch 0.0`. The negative term is heaviest so an explicit "no more of this" outweighs a merely similar positive match. |
| Cluster identity across rebuilds | A cluster's id derives from the rating that created it (`c:<item key>`), so a user edit still refers to the same interest after a rebuild. Merges record an alias so edits made before a merge keep applying. |

### Deviations from the written design

| Deviation | Reason |
|---|---|
| Ingestion runs in the dashboard page, not the background service worker | Embedding a batch far outlives the idle timeout an MV3 service worker gets, and the worker has no GPU context. The worker only schedules and marks a refresh as due. |
| Interest operations include `unpin`, `unmute`, `restore` and `rename` | Section 3.5 lists only the destructive half. A pin with no unpin is not an editable model. |
| "Forget" suppresses rather than excluding events from re-clustering | Implemented as a tombstone plus a rule that rating the topic positively again revives it, which is what someone who changed their mind twice would expect. Excluding the events from clustering would require knowing membership before clustering. |
| Time travel is a persisted "as of" view, not a destructive restore | Rebuilding at a past instant already gives the behaviour; writing that state back would add events to the present and corrupt the very history the feature depends on. Editing is disabled while viewing the past. |
| `CatalogItem.provenance` accepts `fixture` | The fixture catalog must be impossible to mistake for API data, particularly around the 30 day TTL rule. |
| Trials live outside the event log | They are observations about an experiment, not statements about what the user wants. Deleting them changes no preference. |
| The Firefox build is MV2 | WXT's default for Firefox. The sources are shared; only the manifest differs. |
| The ONNX runtime is copied into the extension at build time, and the manifest declares `wasm-unsafe-eval` | Transformers.js otherwise fetches its WebAssembly loader from a CDN, which `script-src 'self'` blocks, and the encoder silently drops to the lexical fallback. Found by running the extension in a real browser; see `docs/verification`. |
| The worker crawls `chart=mostPopular` rather than searching | A query that depends on nobody's preferences, so running it on a server reveals nothing. It is also a `videos.list` call, so it never touches the `search.list` budget. |
| `@wxt-dev/module-react` is not used | Its current release pulls a Vite plugin requiring a newer Vite than WXT builds on. The React plugin is wired directly instead. |

### Still open

- **Open issue 1 remains open.** The 2026 `search.list` quota behaviour has not been
  confirmed against a primary source. The implementation caps itself at 60 calls per day
  and degrades rather than failing when a budget is spent, so a different real limit
  changes a constant rather than the design.
- **Cluster threshold.** With the real sentence encoder, browser, operating system and
  computer history merged into one interest at `τ = 0.55`. Plausible, but it wants tuning
  against real ratings; `τ` is exposed as a setting for this.
- **Worker API key.** The worker is deployed with `ADMIN_TOKEN` set, but `YOUTUBE_API_KEY` is not: that one has to come from a Google Cloud project rather than being generated. Until it exists the scheduled run only sweeps expired rows and the catalog stays empty.

## Turn Count

| Phase | Planned turns | Actual turns |
|---|---:|---:|
| Design (this document) | 3 | 4 (includes English translation and consolidation into a single source of truth) |
| Implementation Phase 0–6 | Not estimated | 1 (a single autonomous run covering all seven phases) |
| **Total** | — | **5** |

The implementation ran as one uninterrupted turn because the decisions it needed were
gathered in advance: credentials, target browser, resource approvals and the treatment of
Phases 5 and 6 were all settled before any code was written. The one decision deliberately
left for later is deploying the worker, which needs an account check at the moment of
deployment rather than beforehand.

Worth carrying into the next estimate: two defects were found only by running the
extension in a real browser, and neither was reachable from unit tests. Budget for that
step rather than treating a green test suite as completion.

---

## Addendum: findings from running against real data (2026-08-22 JST)

The worker was deployed, given an API key, and crawled 298 real videos; the extension
synced and embedded all of them. The mechanism works end to end. Two assumptions in this
document did not survive contact with real embeddings and a real catalog. Both need a
decision before the evaluation in section 9 would mean anything.

### 1. Similarity has almost no usable range with a sentence encoder

Section 3.2 sets `τ = 0.55`, and section 4.1 uses raw cosine directly. Measured against
the real catalog, similarity to the single interest ran about 0.77–0.86 — with a computer
history video at the top and an unrelated Japanese variety short near the bottom. The
absolute value carries little information; only the ordering does.

Consequences observed:

- Every rating collapsed into one cluster, because everything clears `τ`.
- `Novelty = 1 − max cos` compressed to roughly 0.14–0.23.
- Related-lane scores bunched into 1.76–1.79 across unrelated videos.

Raising `τ` is not a fix on its own: the usable band shifts with the model and with the
content mix. The options are to calibrate similarity against the candidate distribution
(rank or z-score before it enters the formula), or to keep raw cosine and accept that the
clustering threshold has to be re-tuned per model. The first changes section 3; the second
changes what section 3.4 promises about `τ` being a stable constant.

### 2. The shared catalog supplies only popular content

Section 4.3 reserves slots for emerging and evergreen videos so that the system does not
manufacture the popularity bias it exists to avoid. The worker crawls `chart=mostPopular`,
which is preference-independent — the property that makes it safe to run on a server — but
is popularity-defined by construction. Every item it contributes is established-tier, so
the emerging and wildcard strata can never be filled from it.

The options are to change what the worker crawls (for example category browsing ordered by
date, which is still preference-independent but costs search quota), or to narrow the
shared catalog's stated role to cold start only and rely on subscriptions and local
interest searches for everything the ranker actually leans on.

### Resolution (2026-08-22 JST)

Both were addressed. The shape of the fix turned out to be the same in each case, and it
is worth stating as a rule rather than as two coincidences:

> **A constant compared against a measurement is only meaningful if the measurement's scale
> is fixed. Neither of these scales is.**

Cosine similarity depends on the embedding model. View count depends on what the catalog
happens to contain. Both constants were replaced by a position within the distribution the
value is drawn from.

**Similarity (section 3.2, 4.1).** The clustering threshold is now derived from the ratings
— one standard deviation above the typical similarity between two rated items — and the
ranker maps each similarity to its position within the candidate pool before scoring.
Novelty uses a two-sided form of the same measure, since a one-sided one cannot tell
"further away than usual" from "as far as everything else".

**Catalog (section 1.1).** `search.list` returned nothing without a `q`, so the recent-uploads
pass instead walks the uploads playlist of channels already in the catalog: still
preference-independent, one unit per channel, and no search budget at all.

**Strata (section 4.3).** The channel pass alone did not help, because channels drawn from
the popular chart are large and even their newest uploads pass 5,000 views within hours.
Measured on the deployed catalog, the fixed boundary put 98% of items in one stratum; the
relative boundary splits it 50/50, so the reserved slots can actually be filled.

| Boundary | established | emerging | wildcard |
|---|---:|---:|---:|
| Fixed, 5,000 views | 98% | 2% | 0% |
| Relative, median of the pool | 50% | 50% | 0% |

The wildcard stratum is still empty, and honestly so: both crawl passes fetch recent
content, so the catalog holds nothing older than ninety days for that stratum to draw on.
Evergreen material reaches the feed through subscriptions and local interest searches
instead. Widening the shared catalog to cover it is not attempted here.

Observed effect on the feed, over the deployed catalog: scores previously bunched into
1.76–1.79 across unrelated videos now spread across roughly 1.27–2.15, and the related lane
returns recognisably on-topic material rather than whatever was trending.

What remains unvalidated is the choice of the constants that replaced the old ones — one
standard deviation for clustering, two for the scoring span, the median for the strata.
They are defensible and they behave correctly on the data seen so far, but only the
comparison in section 9 can say whether they are right.
