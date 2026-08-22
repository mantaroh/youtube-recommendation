# Public catalog worker

Answers one question — "what videos exist?" — and is never told who is asking or what they
like. There is no request shape here that accepts an interest, a vector or a user id, which
is what makes it acceptable for this part to run off the user's machine
(design section 1.1).

The extension works without it. This service only saves every installation from crawling
the same public catalog and from holding an API key.

## Deployed instance

| | |
|---|---|
| URL | <https://ypr-catalog.mantaroh.workers.dev> |
| Account | `mantaroh` / `c7f367f80a06a20bf88b383b39f78539` |
| D1 database | `catalog` / `4fb1fd09-19d9-4066-a94c-abd868aaa77d` (APAC) |
| Schedule | `0 */6 * * *` |
| Deployed | 2026-08-22 (JST) |

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | Liveness, plus how many items are stored |
| `GET /catalog/since?updatedAt=&externalId=&limit=` | Incremental sync by cursor |
| `POST /admin/crawl` | Manual crawl. Requires `Authorization: Bearer $ADMIN_TOKEN` |

## Secrets

Neither secret is set yet. Until `YOUTUBE_API_KEY` exists the scheduled run only sweeps
expired rows, which is a safe state to be deployed in — the catalog simply stays empty.

Set them yourself so the values never pass through a chat log:

```bash
cd packages/worker
npx wrangler secret put YOUTUBE_API_KEY   # a YouTube Data API v3 key
npx wrangler secret put ADMIN_TOKEN       # any long random string
```

With `ADMIN_TOKEN` unset, `/admin/crawl` refuses every request rather than falling open.

## Cost

One scheduled run issues one `videos.list` call per region and category — with the
default `JP,US` × `28,27,26,24` that is 8 units, or about 32 units a day against a 10,000
unit allowance. `chart=mostPopular` is a `videos.list` call, so it never touches the
separate `search.list` budget the extension uses for interest searches.

## Connecting the extension

Paste the URL into the extension's **Settings → Shared catalog**. Requests carry a paging
cursor and nothing else. Leaving it empty is a supported configuration.

A catalog on a custom domain also needs its origin added to `host_permissions` in
`packages/extension/wxt.config.ts`; `*.workers.dev` is already covered.

## Local development

```bash
pnpm --filter @ypr/worker test           # runs the real migration against SQLite
pnpm --filter @ypr/worker migrate:local
pnpm --filter @ypr/worker dev
```
