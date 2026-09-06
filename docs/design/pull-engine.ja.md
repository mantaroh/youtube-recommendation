# ローカル PC でジョブを処理する（pull 型エンジン）

- 作成日: 2026-09-06 (JST)
- 状態: 承認済み・実装完了（2026-09-06 JST）。本番への適用は未実施
- 関連: `docs/design/personal-recommender-v2.ja.md` 22〜29節（ジョブ受け渡し）、41節（定期実行）、43節（シークレット）

---

## 0. 何を解決するか

GPU の担当は、スコア式7項のうち `preference_score` 1項だけ。
いまは RunPod も `PREFERENCE_ENGINE_URL` も未設定なので、その項は候補集合の平均で代替されている。

RunPod を契約せずに、**自分の PC が空いている時間帯だけ**学習と採点を回したい。

### いまの受け渡しの向き

```text
Worker ──[POST /run]──▶ エンジン        ジョブ投入
Worker ──[GET /status]─▶ エンジン        結果の取り込み
```

Worker が発信側なので、エンジンは Worker から到達できる場所にいなければならない。
ローカル PC を Tunnel で公開すれば動くが、2つ問題がある。

**PC を外部に晒すことになる。** `serve.py` は README にあるとおり認証を持たず、リクエストで学習を実行する。

**タイミングを PC 側が決められない。** 起きていれば処理し、寝ていれば失敗する。
「空いているときに」ではなく「起きていれば」になる。

### 向きを逆にする

```text
PC ──[POST /api/engine/claim]──▶ Worker    仕事を取りに行く
PC ──[POST .../result]─────────▶ Worker    終わったら返す
```

PC は発信するだけになり、公開が要らなくなる。
いつ取りに行くかは PC が決める。これが今回入れたい性質。

---

## 1. ジョブ台帳は既にある

`gpu_jobs`（マイグレーション 0004）は queued / processing / completed / failed を持ち、
`payload_hash` による冪等性チェックと `attempts` による再試行上限も実装済み。

**足りないのは「誰かが処理中である」ことの期限だけ。**
push 型では外部に状態を問い合わせれば分かるが、pull 型では PC が黙って落ちた場合に
`processing` のまま残る。

## 2. ペイロードは保存しない

現状、ペイロードは組み立てて即 POST され、DB には残らない。
残っているのは `context_json` の `profileId` / `modelVersion` / `videoIds` だけ。

**claim されたときに組み立てる。** 理由は2つ。

学習ペイロードは評価件数ぶんの本文を含むので、D1 に貯めると行が肥大化する。

再構築の経路が既にある。`reconcile.ts` の再試行が `context_json` から
`submitScoring` を呼び直しており、同じことをすればいい。

`payload_hash` は profile / modelVersion / 入力 id から作られていて本文を含まないので、
投入時に payload なしで計算できる。冪等性はそのまま維持される。

---

## 3. 変更するファイル

### Worker 側

| ファイル | 変更 |
|---|---|
| `migrations/0007_job_lease.sql` | **新規**。`gpu_jobs` に `lease_expires_at` を追加 |
| `apps/web/worker/routes/engine.ts` | **新規**。claim / result / fail の3ルート |
| `apps/web/worker/db/jobs.ts` | 原子的な claim、リース期限切れの回収 |
| `apps/web/worker/services/runpod/engine.ts` | pull モードの判定を追加 |
| `apps/web/worker/services/model/train.ts` | pull モードなら投入だけして POST しない |
| `apps/web/worker/services/model/score.ts` | 同上 |
| `apps/web/worker/services/model/reconcile.ts` | pull モードでは外部に問い合わせず、リース切れを戻す |
| `apps/web/worker/services/model/payload.ts` | **新規**。ペイロード組み立てを submit から切り出し、claim と共用 |
| `apps/web/worker/index.ts` | `/api/engine/*` を Access ミドルウェアの対象外にし、トークン検証に差し替え |
| `apps/web/worker/env.ts` | `ENGINE_PULL_TOKEN` を追加 |
| `packages/domain/src/runpod.ts` | claim / result の型 |

### ローカル側

| ファイル | 変更 |
|---|---|
| `services/anagnorisis-worker/tools/pull_runner.py` | **新規**。時間帯を見て claim → 実行 → 返却 |

`adapter/dispatch.py` は「operation を受けて result を返す」形になっているので、そのまま使える。
`serve.py` は残す（HTTP で叩けるほうが手元の確認には便利なため）。

---

## 4. 受け渡しの仕様

### POST /api/engine/claim

```json
{ "runner": "desktop" }
```

最も古い `queued` を1件だけ `processing` にして返す。無ければ `{ "job": null }`。

```json
{
  "job": {
    "id": "job_...",
    "operation": "score_batch",
    "payload": { "profile": "default", "modelVersion": "model-3", "items": [...] },
    "leaseExpiresAt": 1788400000000
  }
}
```

**取得は1文の UPDATE で行う。**

```sql
UPDATE gpu_jobs
   SET status = 'processing', started_at = ?1, lease_expires_at = ?2
 WHERE id = (SELECT id FROM gpu_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1)
   AND status = 'queued'
RETURNING *
```

D1 には行ロックが無い。SELECT してから UPDATE すると、2つのランナーが同じジョブを掴む窓ができる。
1文にまとめれば SQLite の文単位の原子性でそれが消える。

### POST /api/engine/jobs/:id/result

本文は operation ごとの結果（`ScoreBatchResult` / 学習結果）。
既存の `applyResult` をそのまま呼び、スコア書き込みとモデルの切り替えを行って `completed` にする。

`processing` 以外のジョブに対する result は 409 で拒否する。
リースが切れて別のランナーに渡った後に、古いランナーが遅れて返してくるケースがあるため。

### POST /api/engine/jobs/:id/fail

`{ "error": "..." }` を記録し、`attempts` を増やして `failed` にする。
上限（`MAX_JOB_ATTEMPTS`）までは既存の再試行経路が拾う。

---

## 5. リース

claim 時に `lease_expires_at = now + 30分` を書く。

`reconcileJobs`（毎日 18:00 UTC）が期限切れの `processing` を `queued` に戻す。
PC が学習の途中で落ちても、翌日には別の機会に回る。

30分は学習1回の想定上限より長く取っている。
足りない場合は `POST /api/engine/jobs/:id/heartbeat` を足せばよいが、**今回は入れない**。
評価が0件の段階で必要な長さを見積もっても当たらないので、実測してから決める。

---

## 6. 認証

`/api/engine/*` を Access の対象外にし、Worker が `Authorization: Bearer <ENGINE_PULL_TOKEN>` を検証する。

- トークンは32バイトのランダム値（base64url）
- 比較は定数時間で行う
- 失敗時は理由を返さず 403

> ⚠️ **重要:** これは Access の保護範囲に意図的に穴を開ける。
> claim のレスポンスには、評価した動画のタイトルと説明文が含まれる。
> **トークンが漏れれば、その内容が読まれる。**
> Access サービストークンを使えば穴は開かないが、今回はダッシュボード作業を減らす判断を優先した。

緩和として、engine ルートは3つだけに限定する。
フィードも評価履歴も設定も、このパスからは読めない。

ローテーション手順は `docs/setup-youtube-credentials.md` と同じ形にする
（生成してファイルに書き、値を表示せずに `wrangler secret put` へ渡す）。

---

## 7. モードの判定

`engineConfigured` は今2通り。3つ目を足す。

| 条件 | モード | 動作 |
|---|---|---|
| `ENGINE_PULL_TOKEN` あり | **pull** | 投入だけして待つ |
| `PREFERENCE_ENGINE_URL` あり | push (local) | 従来どおり |
| `RUNPOD_API_KEY` + `RUNPOD_ENDPOINT_ID` | push (runpod) | 従来どおり |
| いずれも無し | 未設定 | 現状。採点は飛ばされ、フィードは6項で動く |

両方設定された場合は **pull を優先**する。
`/api/status` にどちらで動いているかを出し、取り違えに気づけるようにする。

---

## 8. ローカルランナー

```bash
python tools/pull_runner.py \
  --url https://yt.mantaroh.com \
  --window 01:00-07:00 \
  --poll 300
```

トークンは `ENGINE_PULL_TOKEN` 環境変数から読む（引数にすると履歴とプロセス一覧に残るため）。

時間帯は **ローカル時刻（JST）** で判定する。UTC にすると、指定した深夜が昼になる。
時間帯外は claim せず眠る。日をまたぐ指定（`23:00-05:00`）も扱う。

---

## 9. 却下した代替案

| 代替案 | 却下理由 |
|---|---|
| Cloudflare Tunnel で `serve.py` を公開 | PC を外部に晒す。認証が無いエンジンで学習が実行できてしまう。実行タイミングも PC 側で決められない |
| ペイロードを D1 に保存して claim で読む | 学習ペイロードは評価件数ぶんの本文を含み肥大化する。`context_json` から再構築できる |
| Access サービストークン | 穴を開けずに済むが、ダッシュボード作業が増える。今回は採用しない（リスクは6節に明記） |
| SELECT してから UPDATE で claim | D1 に行ロックが無く、2つのランナーが同じジョブを掴む窓ができる |
| ハートビートで長いジョブを延命 | 必要な長さが実測できていない。まずリース30分で運用し、足りなければ足す |
| push を pull で置き換える | RunPod を使いたくなったときに戻せなくなる。両方残す |

---

## 10. 影響範囲

**未設定なら現状のまま。** `ENGINE_PULL_TOKEN` を置かない限り、既存の動作は変わらない。

**push 経路は変更しない。** RunPod と `PREFERENCE_ENGINE_URL` は共存する。

**本番 D1 にマイグレーション 0007 の適用が必要。** カラム追加のみで、既存行には影響しない。

**Access に bypass ポリシーの追加が必要**（ダッシュボード作業）。

**フィードの見え方は変わらない。** スコアが入れば `preference_score` が平均値から実際の予測に変わるだけで、
UI もスコア式も変更しない。

---

## 11. 確認方法

1. `python tools/pull_runner.py --once` で1件だけ処理し、`/api/status` の `activeModel` が変わることを確認
2. 途中で強制終了し、リース切れ後に `queued` へ戻ることを確認
3. 誤ったトークンで 403 になることを確認
4. 同じジョブを2つのランナーで同時に claim して、片方だけが取れることを確認

単体テストは `apps/web/worker/test/engine-pull.test.ts` に置く。
claim の排他、リース回収、result の適用、トークン検証を対象にする。

---

## 12. 未決事項

1. **リース30分が妥当かは実測前**。評価が貯まって学習が走ってから調整する。
2. **CPU で学習が現実的かは未確認**。GPU が要るかどうかはこの実装とは独立に判断できる。
3. 複数ランナー（デスクトップとノート）を同時に走らせる想定は入れていないが、claim が排他なので動くはず。

---

## ターン数

| フェーズ | 予定ターン数 | 実際のターン数 |
|---|---:|---:|
| 設計（本ドキュメント） | 2 | 2 |
| 実装 | 未定 | 1（設計承認後の1ターンで完了） |

実装で足したもの: Worker 側18テスト、Python 側4テスト。

設計時に読み違えていたのは既存関数のシグネチャ2つ（`activateModel` と `appendRating`）だけで、
方式そのものは変更なく実装できた。
