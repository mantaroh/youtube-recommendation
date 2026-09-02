# Cloudflare + Runpod + Anagnorisis 個人向け YouTube 推薦システム設計書

## 1. 概要

本システムは、YouTube 標準の Recommendation / Suggestion に依存せず、ユーザー自身が管理する嗜好データに基づいて動画を推薦する個人向けシステムである。

YouTube は主として以下の役割に限定する。

* 動画配信
* 動画・チャンネルのメタデータ提供
* 登録チャンネル情報の提供
* 動画検索

推薦ロジック、評価履歴、嗜好モデルは本システム側で管理する。

推薦モデルには OSS の **Anagnorisis** を利用する。

Anagnorisis は、コンテンツを 0〜10 で評価し、その評価データからユーザーの嗜好を学習して、未評価コンテンツに対する予測評価値を生成する仕組みを持つ。現在は PyTorch / Transformers を利用し、GPU 8GB VRAM 以上を想定している。

---

# 2. 目的

本システムの最終的な目的は、

> 「プラットフォームが推定した自分」ではなく、
> 「自分が管理している嗜好モデル」によってコンテンツを推薦する

ことである。

具体的には以下を実現する。

1. 登録済み YouTube チャンネルの動画を優先的に推薦する。
2. 登録していないチャンネルからも興味に近い動画を発見する。
3. あえて現在の興味から少し離れた動画を提示する。
4. 各動画に対して 0〜5 の評価を付けられる。
5. 評価を Anagnorisis の学習データに利用する。
6. 興味の変化を後から調整できる。
7. YouTube / Google の Recommendation Profile に依存しない。
8. OpenAI / Gemini 等の外部 LLM API に個人嗜好を送らない。
9. GPU は必要なときのみ起動する。
10. 将来的に YouTube 以外のコンテンツソースへ拡張できる。

---

# 3. 非目標

初期バージョンでは以下を実施しない。

* YouTube 動画ファイルのダウンロード
* YouTube 動画フレームの自動抽出
* 音声のダウンロード・文字起こし
* YouTube と同等の巨大な推薦基盤
* 複数ユーザー向け SaaS
* リアルタイム GPU 推論
* LLM による直接的な推薦判定

特に YouTube の audiovisual content のダウンロード・キャッシュ・保存は、事前承認なしでは Developer Policy 上禁止されているため、V1 では扱わない。

---

# 4. 基本設計思想

## 4.1 評価イベントを正本とする

Anagnorisis の学習済みモデルを正本とはしない。

正本は、

```text
「いつ」
「何を」
「何点と評価したか」
```

というイベントである。

```text
rating_event

2026-08-23
youtube
video=abc123
rating=5
```

を永久的なユーザー所有データとする。

学習済みモデルは、

```text
rating events
      ↓
training
      ↓
preference model
```

によっていつでも再構築可能な派生データとして扱う。

---

## 4.2 Cloudflare と Runpod の責務を分離する

```text
Cloudflare

- UI
- API
- 認証
- 評価履歴
- YouTube API
- 動画候補
- Recommendation Feed
- Job管理


Runpod

- Anagnorisis
- Embedding
- Descriptor
- Preference Model Training
- Batch Scoring
```

GPU を必要としない処理では Runpod を呼び出さない。

---

# 5. システム構成

```text
                           User
                             │
                             ▼
                 ┌──────────────────────┐
                 │ Cloudflare Access    │
                 └──────────┬───────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────┐
│                  Cloudflare                         │
│                                                     │
│  React SPA                                          │
│       │                                             │
│       ▼                                             │
│  Cloudflare Worker API                              │
│       │                                             │
│       ├─────────────── D1                           │
│       │                 │                           │
│       │                 ├─ videos                   │
│       │                 ├─ channels                 │
│       │                 ├─ ratings                  │
│       │                 ├─ model_scores             │
│       │                 ├─ interests                │
│       │                 └─ jobs                     │
│       │                                             │
│       ├─────────────── R2                           │
│       │                 │                           │
│       │                 └─ export / backup          │
│       │                                             │
│       └─────────────── YouTube Data API             │
│                                                     │
└────────────────────────┬────────────────────────────┘
                         │
                         │ GPU Job
                         ▼
              ┌───────────────────────┐
              │ Runpod Serverless     │
              │                       │
              │ workersMin = 0        │
              │ workersMax = 1        │
              │                       │
              │ Anagnorisis Adapter   │
              │         │             │
              │         ▼             │
              │ Anagnorisis Core      │
              │                       │
              │ embed                 │
              │ train                 │
              │ score                 │
              │ describe              │
              │                       │
              └───────────┬───────────┘
                          │
                          ▼
                   Network Volume

                    /models
                    /cache
                    /trained
                    /project_config
```

Cloudflare Workers は React SPA と Worker API を同一デプロイメントとして配信可能なので、UI と API を1プロジェクトにまとめる。

---

# 6. 使用技術

| レイヤー           | 技術                        |
| -------------- | ------------------------- |
| Frontend       | React + TypeScript + Vite |
| UI             | Tailwind CSS 等            |
| API            | Cloudflare Workers        |
| Authentication | Cloudflare Access         |
| Application DB | Cloudflare D1             |
| Backup         | Cloudflare R2             |
| Scheduler      | Cloudflare Cron Triggers  |
| Video Source   | YouTube Data API v3       |
| GPU Compute    | Runpod Serverless         |
| Recommendation | Anagnorisis               |
| ML             | PyTorch / Transformers    |
| GPU Storage    | Runpod Network Volume     |
| Container      | Docker                    |
| CI/CD          | GitHub Actions            |

D1 は Paid で1 DB最大10GBであり、個人向け動画メタデータ・評価履歴用途には十分な余裕がある。

---

# 7. Repository 構成

```text
personal-recommender/
│
├── apps/
│   └── web/
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   ├── api/
│       │   └── domain/
│       │
│       ├── worker/
│       │   ├── routes/
│       │   ├── services/
│       │   │   ├── youtube/
│       │   │   ├── recommendation/
│       │   │   └── runpod/
│       │   └── scheduled/
│       │
│       └── wrangler.jsonc
│
├── services/
│   └── anagnorisis-worker/
│       ├── Dockerfile
│       ├── handler.py
│       ├── adapter/
│       └── anagnorisis/
│
├── packages/
│   └── domain/
│
├── migrations/
│
└── docs/
    └── architecture.md
```

---

# 8. ドメインモデル

YouTube 固有 ID をプライマリモデルにしない。

基本モデルは、

```text
source
external_id
```

の組み合わせとする。

例：

```json
{
  "source": "youtube",
  "externalId": "dQw4w9WgXcQ"
}
```

将来的には、

```text
youtube
vimeo
podcast
web
rss
```

を同じデータ構造で扱える。

---

# 9. D1 Schema

## 9.1 profiles

```sql
CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
```

個人利用でも `profile_id` を導入する。

初期値：

```text
profile_id = default
```

---

## 9.2 channels

```sql
CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT,
    thumbnail_url TEXT,
    subscribed INTEGER NOT NULL DEFAULT 0,
    last_fetched_at INTEGER,

    UNIQUE(source, external_id)
);
```

---

## 9.3 videos

```sql
CREATE TABLE videos (
    id TEXT PRIMARY KEY,

    source TEXT NOT NULL,
    external_id TEXT NOT NULL,

    channel_id TEXT,

    title TEXT NOT NULL,
    description TEXT,

    thumbnail_url TEXT,
    published_at INTEGER,
    duration_seconds INTEGER,

    view_count INTEGER,

    metadata_json TEXT,

    discovered_at INTEGER NOT NULL,
    refreshed_at INTEGER,

    UNIQUE(source, external_id)
);
```

---

# 10. 評価イベント

## 10.1 rating_events

```sql
CREATE TABLE rating_events (
    id TEXT PRIMARY KEY,

    profile_id TEXT NOT NULL,
    video_id TEXT NOT NULL,

    rating REAL NOT NULL,

    created_at INTEGER NOT NULL,

    disabled_at INTEGER,

    FOREIGN KEY(video_id)
        REFERENCES videos(id)
);
```

Rating は UI 上、

```text
0
1
2
3
4
5
```

とする。

Anagnorisis の 0〜10 に渡す際は、

```text
anagnorisis_rating = rating * 2
```

と変換する。

---

# 11. rating_events を UPDATE しない

基本的に過去イベントは変更しない。

例：

```text
8/01
video-A
★★★★★

8/20
video-A
★★☆☆☆
```

なら、

```text
rating_event #1 = 5
rating_event #2 = 2
```

の両方を残す。

最新評価を現在値として扱う。

これにより将来的に、

```text
興味の変化
飽き
再興味
```

を分析できる。

---

# 12. Interest Control

Anagnorisis の学習結果とは別に、ユーザーが明示的に興味を操作できる。

```sql
CREATE TABLE interest_controls (
    id TEXT PRIMARY KEY,

    profile_id TEXT NOT NULL,

    keyword TEXT NOT NULL,

    weight REAL NOT NULL DEFAULT 1.0,

    mute_until INTEGER,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

例えば、

```text
Linux Kernel      1.0
Firefox           1.4
AI Agents         0.4
Investment        0.0
```

とする。

この値はモデルを再学習しなくても推薦結果に即座に反映する。

---

# 13. モデル管理

```sql
CREATE TABLE model_versions (
    id TEXT PRIMARY KEY,

    profile_id TEXT NOT NULL,

    version INTEGER NOT NULL,

    training_event_count INTEGER,

    status TEXT NOT NULL,

    created_at INTEGER NOT NULL,

    activated_at INTEGER,

    metadata_json TEXT
);
```

状態：

```text
training
ready
active
failed
superseded
```

---

# 14. 動画ごとの予測スコア

```sql
CREATE TABLE recommendation_scores (
    profile_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    model_version TEXT NOT NULL,

    score REAL NOT NULL,

    scored_at INTEGER NOT NULL,

    PRIMARY KEY (
        profile_id,
        video_id,
        model_version
    )
);
```

GPU 推論結果をキャッシュする。

---

# 15. Runpod Job

```sql
CREATE TABLE gpu_jobs (
    id TEXT PRIMARY KEY,

    type TEXT NOT NULL,

    runpod_job_id TEXT,

    status TEXT NOT NULL,

    payload_hash TEXT,

    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,

    error TEXT
);
```

Job Type：

```text
embed_batch
describe_batch
train
score_batch
```

---

# 16. YouTube 認証

登録チャンネルを取得するため YouTube OAuth を利用する。

YouTube Data API の `subscriptions.list(mine=true)` により、認証ユーザー自身の subscription を取得できる。

OAuth token をブラウザへ永続保存しない。

```text
Google OAuth

    ↓

Cloudflare Worker

    ↓

AES-GCM encryption

    ↓

D1
```

暗号化キーのみ Worker Secret に保存する。

Runpod には Google OAuth Token を渡さない。

---

# 17. Candidate Discovery

候補生成は3系統に分ける。

```text
Subscription
Related
Explore
```

初期比率：

```text
Subscription     50%
Related          30%
Explore          20%
```

---

# 18. Subscription Candidate

登録チャンネルの新着動画を収集する。

```text
subscriptions
      ↓
channel
      ↓
recent videos
      ↓
videos table
```

ここは最優先候補とする。

---

# 19. Related Candidate

現在高評価されているコンテンツから、

```text
Linux kernel
Firefox internals
browser engine
OS architecture
```

等の探索キーワードを生成する。

YouTube `search.list` を利用して候補を取得する。

2026年8月現在、`search.list` は標準で1日100 callsの独立した Search Queries quota を持つため、全件クローリングではなく限られた探索クエリを定期実行する。

---

# 20. Explore Candidate

興味ベクトルそのものではなく、

```text
related but different
```

な探索を行う。

例：

```text
Browser Engine
    ↓
Operating System
    ↓
Computer Architecture
    ↓
CPU History
```

のような隣接トピックを探索する。

V1では簡易的なカテゴリ・キーワードルールでも構わない。

将来的には embedding nearest-neighbor を利用する。

---

# 21. Anagnorisis Adapter

Anagnorisis 本体の Flask UI を外部公開しない。

Runpod 用に Thin Adapter を作成する。

```text
Runpod Handler
       │
       ▼
AnagnorisisAdapter
       │
       ├─ train()
       ├─ score()
       ├─ embed()
       └─ describe()
```

Anagnorisis の現在の設計自体も、検索処理と GPU background task を分離しており、GPUを必要とする処理を切り出す方向と相性が良い。

---

# 22. Runpod API

外部 API は1 Endpointとし、operation で分ける。

```json
{
  "input": {
    "operation": "score_batch",
    "payload": {}
  }
}
```

---

# 23. score_batch

Request：

```json
{
  "input": {
    "operation": "score_batch",

    "modelVersion": "model-12",

    "items": [
      {
        "id": "video-1",
        "text": "title + description + channel"
      }
    ]
  }
}
```

Response：

```json
{
  "items": [
    {
      "id": "video-1",
      "score": 8.73
    }
  ]
}
```

---

# 24. train

```json
{
  "input": {
    "operation": "train",

    "profile": "default",

    "events": [
      {
        "itemId": "video-1",
        "rating": 10,
        "description": "..."
      },
      {
        "itemId": "video-2",
        "rating": 2,
        "description": "..."
      }
    ]
  }
}
```

---

# 25. Runpod Serverless 設定

初期設定：

```text
workersMin    0
workersMax    1

idleTimeout   300 sec

FlashBoot     enabled

GPU
16GB または 24GB
```

Runpod Serverless は `workersMin=0` で scale-to-zero でき、Flex Worker は利用時のみ起動する。

Anagnorisis は最低8GB VRAMを想定しているため、最初は16GB GPUを使用する。

---

# 26. workersMax = 1 とする理由

Runpod Network Volume は複数 worker から同時書き込みするとデータ破損の可能性があるため、個人利用では並列GPU workerを使用しない。Runpod 自身も同一 Network Volume への同時書き込みについて application-side control を要求している。

したがって、

```text
workersMax = 1
```

とする。

---

# 27. Network Volume

```text
/runpod-volume/

├── models/
│   ├── embeddings/
│   └── descriptor/
│
├── trained/
│   └── default/
│
├── cache/
│
└── project_config/
```

Network Volume は worker が終了・scale-to-zeroしても保持され、Serverless worker では `/runpod-volume` に mount される。

---

# 28. GPU Job は基本 Async

小さい問い合わせだけ `/runsync` を許可する。

主処理：

```text
train
score_batch
describe_batch
embed_batch
```

は `/run` で非同期実行する。

Runpod Queue Endpoint の `/run` は非同期 job として処理され、結果は `/status` から取得できる。

---

# 29. Job Polling

Cloudflare Worker が Runpod API を同期的に長時間待たない。

```text
Cloudflare
     │
     │ POST /run
     ▼
Runpod

job_id
     │
     ▼
D1 gpu_jobs
```

Cron が定期的に、

```text
status = processing
```

の Job をチェックする。

```text
Cron
 ↓
Runpod /status
 ↓
completed?
 ↓
D1更新
```

---

# 30. 評価フロー

```text
動画閲覧

    ↓

★★★★★

    ↓

POST /api/videos/:id/rating

    ↓

rating_events

    ↓

即座にUI更新
```

この時点ではGPUを起動しない。

---

# 31. 学習トリガー

例えば、

```text
新規評価 20件

または

最後の学習から7日

または

ユーザーが「再学習」を押す
```

のいずれかで実行する。

```text
rating events
     ↓
training dataset
     ↓
Runpod
     ↓
Anagnorisis train
     ↓
model_version++
```

---

# 32. 学習後の再スコアリング

新しいモデル生成後、

```text
未視聴候補
直近30日
最大500〜2000件
```

について一括推論する。

```text
Runpod
  ↓
score_batch
  ↓
recommendation_scores
```

その後 Runpod は停止する。

---

# 33. Feed生成

Feedアクセス時にGPUを呼ばない。

```text
GET /api/feed
```

は D1 の既存スコアから返す。

基本的なランキング：

```text
final_score =

0.65 * preference_score

+ subscription_bonus

+ freshness_bonus

+ explicit_interest_bonus

+ exploration_bonus

- seen_penalty

- muted_interest_penalty
```

GPUは `preference_score` の事前生成だけを担当する。

---

# 34. 3レーン方式

単一スコア順に並べず、

```text
Subscription
Related
Explore
```

を別々に選ぶ。

例：

```text
50件Feed

Subscription
25件

Related
15件

Explore
10件
```

各レーン内部を Anagnorisis score で並べる。

これにより、

```text
Anagnorisis が予測しやすい動画だけ
```

が Feed 全体を占領するのを防ぐ。

---

# 35. Diversity

同一チャンネルを連続表示しない。

例：

```text
maximum same channel
3 / 20 videos
```

同じトピックについても連続表示数を制限する。

---

# 36. UI

## Home

```text
┌───────────────────────────────────────────────┐
│ PersonalTube                    Preferences   │
├───────────────────────────────────────────────┤
│ For You | Subscriptions | Discover           │
│                                               │
│ ┌───────────┐ ┌───────────┐ ┌───────────┐    │
│ │ Thumbnail │ │ Thumbnail │ │ Thumbnail │    │
│ └───────────┘ └───────────┘ └───────────┘    │
│                                               │
│ Linux       Browser      CPU History          │
│ ★★★★★      ★★★★☆        未評価                │
└───────────────────────────────────────────────┘
```

---

# 37. Video View

YouTube iframe player を利用する。

```text
┌──────────────────────────────────────────┐
│ YouTube Player                           │
│                                          │
└──────────────────────────────────────────┘

Why recommended

Browser Engine
OS Internals
Subscribed Channel


今後このような動画を見たいですか？

0  ☆☆☆☆☆
1  ★☆☆☆☆
2  ★★☆☆☆
3  ★★★☆☆
4  ★★★★☆
5  ★★★★★
```

「動画そのものの品質」ではなく、

> 今後同じようなコンテンツをどの程度見たいか

を評価対象とする。

---

# 38. Preference UI

```text
Interests

Firefox Internals     █████████      +30%
Linux                 ████████
AI Agents             ████           -50%
Investment            muted

Discovery

Known ◀──────●──────────▶ Explore
```

ユーザー操作：

```text
もっと増やす
少し減らす
30日ミュート
完全ミュート
通常に戻す
```

---

# 39. Recommendation Explainability

各動画に簡単な推薦理由を出す。

例：

```text
おすすめ理由

・登録中のチャンネル
・Firefox関連動画を最近高評価
・OS Internalsとの類似度が高い
```

LLMは使用せず、ranking signals から生成する。

---

# 40. Cloudflare API

主要Endpoint：

```text
GET    /api/feed

GET    /api/videos/:id

POST   /api/videos/:id/rating

GET    /api/preferences

PUT    /api/preferences/:id

POST   /api/model/train

GET    /api/model

POST   /api/discovery/run

GET    /api/jobs

GET    /api/auth/youtube

GET    /api/auth/youtube/callback
```

---

# 41. Cron

例：

```text
00:00 UTC

subscriptions refresh


06:00 UTC

interest-based discovery


12:00 UTC

subscriptions refresh


18:00 UTC

Runpod pending job check


weekly

model retraining check
```

実際の運用時刻は使用パターンに合わせて変更する。

---

# 42. YouTube Search Quota対策

`search.list` は現在100 calls/dayなので、探索数を制御する。

例えば、

```text
10 interest clusters

× 3 queries

= 30 calls/day
```

程度から開始する。

残りを手動検索・再探索用として残す。

---

# 43. Security

## Cloudflare

Web UI 全体を Cloudflare Access で保護する。

```text
allow:
user@example.com only
```

---

## Secrets

Worker Secret：

```text
GOOGLE_CLIENT_SECRET

OAUTH_ENCRYPTION_KEY

RUNPOD_API_KEY

RUNPOD_ENDPOINT_ID
```

ブラウザへ送らない。

---

## Runpod

ブラウザから Runpod を直接呼び出さない。

```text
Browser
 ↓
Cloudflare Worker
 ↓
Runpod
```

Runpod API Key は Cloudflare Worker だけが保持する。

---

# 44. Runpod に送る情報

Runpodへは必要最小限だけ送る。

許可：

```text
video title
description
channel name
rating
derived metadata
```

送らない：

```text
Google OAuth token
Cloudflare Access identity
email address
browser cookie
IP
```

---

# 45. データの所有権

以下を export 可能にする。

```text
ratings.jsonl
preferences.json
subscriptions.json
settings.json
```

学習済みモデルは必須 export 対象ではない。

モデルは評価履歴から再構築できるからである。

---

# 46. Backup

定期的に、

```text
D1
 ↓
JSONL
 ↓
R2
```

へバックアップする。

例：

```text
backup/
  2026-08-23/
    ratings.jsonl
    preferences.json
```

---

# 47. Idempotency

Runpod job は必ず `payload_hash` を持つ。

```text
SHA256(
 profile
 + model_version
 + input IDs
)
```

同じ batch が再送されても二重処理しない。

---

# 48. Retry

```text
queued
processing
completed
failed
```

`failed` は最大3回まで再送する。

Training は同じ `model_version` に上書きせず、

```text
model-15.tmp
      ↓
training success
      ↓
model-15
```

のように atomic switch する。

---

# 49. Runpod障害時

Runpodが停止しても、

```text
既存 recommendation_scores
```

を使い続ける。

つまりUIは利用可能。

新規学習・新規スコアだけ遅延する。

---

# 50. Cloudflare障害時

ユーザー嗜好の最新BackupをR2へ定期保存する。

D1 の Time Travel も Paid では30日利用可能である。

---

# 51. Anagnorisis 更新

Anagnorisis repository を直接改造しすぎない。

```text
upstream Anagnorisis

       │
       ▼

AnagnorisisAdapter
```

というレイヤーを挟む。

```python
class PreferenceEngine:

    def train(self, events):
        ...

    def score(self, items):
        ...

    def embed(self, items):
        ...
```

将来的に、

```text
Anagnorisis
      ↓
独自モデル
```

へ交換可能にする。

---

# 52. Source Adapter

同様にYouTube依存を閉じ込める。

```ts
interface ContentSource {

  getSubscriptions(): Promise<Channel[]>;

  discover(
    query: DiscoveryQuery
  ): Promise<ContentItem[]>;

  getItem(
    id: string
  ): Promise<ContentItem>;
}
```

実装：

```text
YouTubeSource
```

将来：

```text
WebSource
PodcastSource
VimeoSource
RSSSource
```

---

# 53. V1ではVectorizeを使わない

最初のバージョンでは Cloudflare Vectorize は導入しない。

理由：

```text
YouTube search
+
Anagnorisis score
+
D1
```

だけで必要機能を実現できるため。

システムを使って、

```text
候補動画不足
類似検索精度不足
```

が発生した段階で Vectorize を追加する。

---

# 54. V2 Vectorize

将来的には、

```text
Video Metadata
      ↓
embedding
      ↓
Vectorize
```

とする。

その場合も、

```text
public content embedding
```

のみをVectorizeに保存する。

個人 preference embedding は別管理する。

---

# 55. 初期導入フェーズ

## Phase 0

Anagnorisis をローカルDockerで起動し、YouTube moduleを試験する。

目的：

```text
Anagnorisis自体の推薦品質確認
```

---

## Phase 1

Runpod Serverless化。

実装：

```text
Docker
Runpod handler
Network Volume
train
score_batch
```

この段階ではCLIから呼べればよい。

---

## Phase 2

Cloudflare UI。

実装：

```text
React
Workers
D1
Cloudflare Access
```

手動登録した動画に対し、

```text
表示
評価
学習
score
```

まで通す。

---

## Phase 3

YouTube OAuth。

```text
subscriptions.list
videos.list
```

を利用して登録チャンネルを取得する。

---

## Phase 4

Discovery。

```text
Subscription
Related
Explore
```

3レーンFeedを実装する。

---

## Phase 5

Preference Control。

```text
boost
reduce
mute
discovery level
```

を追加する。

---

## Phase 6

自動運用。

```text
Cron
Runpod async jobs
auto retrain
batch scoring
backup
```

を追加する。

---

# 56. MVP完成条件

以下を満たした時点を MVP とする。

```text
Cloudflare URLへアクセスできる

↓

YouTube登録チャンネルが表示される

↓

おすすめ動画が30件以上出る

↓

各動画を0〜5で評価できる

↓

評価がD1へ保存される

↓

RunpodでAnagnorisisを学習できる

↓

候補動画に予測scoreが付く

↓

score順のFeedが生成される

↓

興味を減らす・ミュートできる
```

---

# 57. Runpod費用目安

2026年8月時点の Runpod Serverless は、

```text
16GB GPU
約 $0.58 / hour

24GB GPU
約 $0.69 / hour
```

から提供されている。

例えばGPU利用が、

```text
1日 10分

× 30日

= 5 GPU hours
```

なら、

```text
16GB

約 $2.90 / month
```

程度。

---

# 58. Storage費用

Runpod Network Volume は現在、

```text
$0.07 / GB / month
```

である。

Anagnorisis は現在 Docker・モデル・キャッシュを含めて約40GB程度の空き容量を推奨しているため、40GBなら、

```text
$2.80 / month
```

程度になる。

---

# 59. 概算

個人利用であれば、

```text
Runpod GPU
$3〜10

Runpod Volume
約 $3

Cloudflare
Free〜Workers Paid

YouTube API
通常quota内
```

程度から開始できると想定する。

---

# 60. 最終的な責務

```text
YouTube

「動画を持っている」


Cloudflare

「どんな動画候補があるか知っている」


Anagnorisis

「自分がどんな動画を好みそうか予測する」


D1

「自分が実際に何を評価したか覚えている」


User

「最終的な嗜好を決める」
```

---

# 61. 最重要設計原則

本システムでは、

```text
rating_events
```

だけは特定の推薦モデルに依存させない。

```text
Anagnorisis
Runpod
Cloudflare
YouTube
```

のいずれを将来交換しても、

```text
自分が
いつ
何に
何点を付けたか
```

という嗜好の履歴は残る。

これをシステムにおける最も重要なデータとして扱う。
