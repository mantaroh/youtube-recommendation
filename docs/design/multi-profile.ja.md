# 複数 YouTube アカウントを1つのデプロイで扱う

- 状態: 承認済み・実装完了（2026-09-09 JST）
- 日付: 2026-09-09 (JST)
- 前提: `docs/design/personal-preference-model-youtube-recommender-v1.en.md`、`docs/design/pull-engine.ja.md`

## 何をしたいか

同じ人が持つ複数の YouTube アカウントを、それぞれ別の好みとして学習させる。
登録チャンネルも視聴履歴も違うので、混ぜると片方の推薦がもう片方に引きずられる。

入口はサブドメインで分ける。

```
yt.mantaroh.com       → profile "default"
yt-<name>.mantaroh.com → profile "<name>"
```

見る人は1人なので、Access のポリシーは分ける必要がない。
分けるのは YouTube の認証、評価、モデル、推薦スコア。

## 結論から言うと、ほとんど作らなくて済む

データ層は最初から複数対応の形になっている。

| 対象 | 現状 | 必要な作業 |
|---|---|---|
| `profiles` テーブル | ある（`id`, `name`, `created_at`） | なし |
| 評価・興味・スコア・モデル | 全テーブルに `profile_id` | なし |
| 購読チャンネル | **`channels.subscribed` が全プロファイル共有だった** | **移行が必要だった（0008）** |
| OAuth トークン | `accessTokenFor(db, profileId, 'youtube', …)` で**プロファイル別に保存済み** | なし |
| エンジンのボリューム | `project_config/<profile>/` で分離済み | なし |
| 埋め込みモデルの重み | ボリューム直下で共有（3.4GB×1のまま） | なし |

足りないのは入口だけ。`profileId` が `DEFAULT_PROFILE_ID` 固定で埋まっている箇所が4つある。

### 訂正（2026-09-09）

**上の「ほとんど作らなくて済む」は誤りだった。** テーブルを数えるときに `channels` を見落とし、
購読が個人のものだという点を落としていた。実際に起きたことは次の2つ。

1. `channels.subscribed` が全プロファイル共有で、**`private` のフィードが `default` の購読54件から作られた。**
   報告された「`yt.mantaroh.com` の内容がサジェストされる」はこれ。
2. `setSubscribed` がプロファイルを見ずに全解除していたので、
   **`private` で YouTube を繋いだ時点で `default` の購読が消えるところだった。**

さらに `youtubeCredentials` の呼び出し4箇所すべてが `profileId` を渡しておらず、
既定値の `default` に落ちていた。**探索も購読同期も `default` のトークンを使っていた。**

対応は `migrations/0008_profile_subscriptions.sql` と、
購読を `profile_subscriptions` に出す変更。詳細は下の「購読の分離」を参照。

## 購読の分離

`channels` に `profile_id` を足すのではなく、関係だけを別テーブルに出す。
題名やサムネイルはカタログの事実で、プロファイルごとに複製する意味がない。

```sql
CREATE TABLE profile_subscriptions (
  profile_id, channel_id, subscribed_at,
  PRIMARY KEY (profile_id, channel_id)
);
```

`channels.subscribed` は残さず削除した。**更新されない列が妥当な値を持ったままだと、
次に `channels` に対して書かれるクエリが黙って間違う。** この不具合が戻ってくる経路そのもの。

`listChannelsToRefresh` だけは全プロファイルの和集合で回す。
取得した動画は共有カタログに入るので、プロファイルごとに歩くと同じ動画に同じクォータを二重に払うことになる。

## 候補プールの分離（2026-09-09、2度目の差し戻し）

購読を分けたあと、**逆向きの漏れが出た。**
`private` の購読チャンネルから130本がカタログに入り、それが `default` の explore レーンに現れた。
`default` 由来の3097本も同様に `private` の候補になっていた。

カタログを共有にしたこと自体は正しい。同じ動画を二重に持つ意味も、
メタデータを二度取る意味もない。**誤っていたのはその次で、
「カタログにある動画はすべてのプロファイルの候補である」と暗に決めていたこと。**

好みが混ざらないようにアカウントを分けている以上、その前提は成り立たない。

`profile_candidates (profile_id, video_id, discovered_at)` を追加した。
行は共有のまま、候補としての関係だけを分ける。購読と同じ形。
2つのプロファイルが独立に同じ動画を見つけたなら、単に両方の候補になる。

| 却下した案 | 理由 |
|---|---|
| `videos` に `discovered_for` 列を1つ足す | 2つのプロファイルが同じ動画を見つけたときに表現できない |
| チャンネルの購読関係だけで判定 | 探索で見つけた3097本を分けられない。最も多い部分が扱えない |
| カタログをプロファイル別に複製 | 同じメタデータを二重に持ち、クォータも二重に払う |

移行では、購読チャンネル由来の動画をその購読者に、
残り3097本を `default` に割り当てた。**`private` はまだ探索を1度も走らせていないので、
これは推測ではなく事実。**

## 巡回の帰属（2026-09-10、3度目の差し戻し）

候補プールを分けたあとも漏れていた。`default` の候補に、
**`private` だけが購読するチャンネルの動画が195本**入っていた。逆方向も同様。

原因は帰属先。`listChannelsToRefresh` は全プロファイルの購読の和集合を歩く。
同じチャンネルを2回取らないためで、これは正しい。
**誤っていたのは、取得した動画を「巡回を走らせたプロファイル」の候補にしていたこと。**

```ts
summary.stored = await store(env, profileId, items, 'subscription')
//                                ↑ 走らせた側。購読者ではない
```

`addSubscriptionCandidates` で、**チャンネルを購読しているプロファイル全員**に記録するよう変えた。
巡回は和集合のまま。帰属さえ正しければ漏れないので、クォータの節約を捨てる理由がない。

### 同じ見落としを3回した

購読（0008）、候補プール（0010）、そして帰属。
いずれも **「テーブルに `profile_id` があるか」だけを確認して、
「その値がどう決まるか」を追わなかった。** 3度目は列があり、入れる値が誤っていた。

そこで、事例ではなく**性質**を検証するテストを置いた。

> あるプロファイルの候補に、他プロファイルだけが購読するチャンネルの動画が含まれない

### 本番の監査

同じ条件を本番で数えられる。探索まわりを変えたら実行する。

```sql
SELECT pc.profile_id, COUNT(*) AS leaked
  FROM profile_candidates pc
  JOIN videos v ON v.id = pc.video_id
 WHERE EXISTS (SELECT 1 FROM profile_subscriptions s
                WHERE s.channel_id = v.channel_id AND s.profile_id <> pc.profile_id)
   AND NOT EXISTS (SELECT 1 FROM profile_subscriptions t
                    WHERE t.channel_id = v.channel_id AND t.profile_id = pc.profile_id)
 GROUP BY pc.profile_id;
```

**0 でなければ漏れている。**

### 検証

`worker/test/profile-isolation.test.ts` を追加した。
**「片方に他方のものが出ない」という不在の検証**にしてある。
今回の不具合は何も失敗せず、ただ間違ったフィードが出ただけだったので、
存在を確かめる検証では捕まらない。

## 変更するファイル

| ファイル | 変更 |
|---|---|
| `apps/web/worker/profile.ts` | 新規。ホスト名 → プロファイル の解決 |
| `apps/web/worker/index.ts` | ミドルウェアでホストから `profileId` を決める |
| `apps/web/worker/scheduled/index.ts` | cron を全プロファイルで回す |
| `apps/web/worker/services/youtube/credentials.ts` | リダイレクト URI をリクエスト元から導出 |
| `apps/web/worker/routes/auth.ts` | 同上の受け渡し |
| `apps/web/worker/routes/engine.ts` | `/engine/status` の固定値を外す |
| `apps/web/wrangler.jsonc` | 2つ目のカスタムドメインを追加 |
| `apps/web/src/pages/SettingsPage.tsx` | いまどのアカウントを見ているかを表示 |

## ホスト名からプロファイルを決める

環境変数に明示的な対応表を持つ。

```jsonc
// wrangler.jsonc の vars
"PROFILE_HOSTS": "{\"yt.mantaroh.com\":\"default\",\"yt-sub.mantaroh.com\":\"sub\"}"
```

### サブドメインから機械的に導出しない

`yt-work.mantaroh.com` から `work` を切り出す方式は却下する。

`ensureProfile` は `INSERT OR IGNORE` なので、**未知のホストで来たリクエストが新しいプロファイルを勝手に作る。**
`workers.dev` のサブドメイン、プレビュー URL、設定を間違えた CNAME —
どれも「空の好みを持つ新しいアカウント」を生む。静かに増えるので気づきにくい。

対応表にないホストは `default` にする。
拒否ではなく `default` にするのは、`workers.dev` の URL が今も動いていて、それを壊す理由がないから。

### 却下した代替案

| 案 | 却下理由 |
|---|---|
| パスで分ける（`/work`, `/home`） | Access はアプリ単位でポリシーを持つ。人を分ける必要が出たときに作り直しになる |
| Worker と D1 をアカウントごとに立てる | デプロイとマイグレーションがアカウント数だけ増える。共有したい埋め込み重みも二重に持つ |
| ヘッダやクッキーで切り替える | ブックマークできない。どちらを見ているか URL から分からない |

## OAuth リダイレクトをリクエスト元から導出する

いまは `OAUTH_REDIRECT_URI` という単一の秘密値。ホストが2つになると足りない。

`refreshToken` は `redirect_uri` を使わない（使うのは `exchangeCode` だけ）ので、
**リクエストのオリジンから組み立てて構わない。** cron からのトークン更新は影響を受けない。

```ts
// 認可開始と callback は必ず同じホストで起きるので、そのホストを使う
const redirectUri = new URL(request.url).origin + '/api/auth/youtube/callback'
```

`OAUTH_REDIRECT_URI` は残す。リクエストがない経路のための既定値として使う。

> ⚠️ **Google Cloud Console 側の登録が必要。** 承認済みリダイレクト URI に
> 新しいホストの分を足さないと、認可の時点で `redirect_uri_mismatch` で止まる。
> これはコードでは解決できない手作業。

## cron を全プロファイルで回す

`runScheduled` は `profileId` を1つ持っている。`profiles` を読んで回す形に変える。

### クォータは共有される

`api_quota_usage` の主キーは `(day, source, operation)` で、プロファイル別ではない。
これは正しい。**YouTube のクォータは API キーに属するもので、プロファイルとは無関係。**

ただし結果として、1日の探索予算 `DISCOVERY_SEARCH_BUDGET = 30` を
プロファイル間で分け合うことになる。

| 選択肢 | 内容 |
|---|---|
| そのまま共有 | 先に回ったプロファイルが30回使い切ると、後のプロファイルは探索をしない |
| プロファイル数で割る | 2つなら各15回。どちらも毎日少しずつ進む |

**後者を採る。** 「毎日どちらかだけが進む」より「両方が半分ずつ進む」ほうが、
片方だけ推薦が育つ状態を避けられる。`search.list` の実際の上限は100回/日なので、
プロファイルが増えても合計30回を超えない限り安全側にいる。

## 影響範囲

| 対象 | 影響 |
|---|---|
| 既存の `default` プロファイル | なし。対応表に載せるだけで挙動は変わらない |
| ランナー | なし。ジョブの `profile` を見て動くので、既に対応済み |
| 学習・採点の所要時間 | **プロファイル数に比例して増える**。1アカウント約20時間なので、2つで約40時間 |
| Cloudflare Access | 新しいホストを既存アプリに追加する手作業が必要 |
| DNS | 新しいホストの CNAME をカスタムドメインとして追加（wrangler が作る） |

## やらないこと

- **人を分けること。** 見る人は1人という前提で作る。他人に見せるなら Access の
  ポリシーとデータの可視性を別に設計する必要があり、それはこの変更の範囲を超える。
- **プロファイルを UI から作ること。** 対応表と Access の設定が手作業で必要なので、
  画面から作れるようにしても片手落ちになる。

## ターン数

- 予定: 設計 1 / 実装 2
- 実績: 設計 1 / 実装 4（購読・候補プール・巡回の帰属、3度の分離漏れによる差し戻しを含む）
