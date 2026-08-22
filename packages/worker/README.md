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

### ADMIN_TOKEN — set

Generated locally and held in `packages/worker/.admin-token`, which is git-ignored.
Cloudflare cannot read a secret back, so **that file is the only copy**: lose it and the
token has to be regenerated and re-set.

To rotate it:

```bash
cd packages/worker
pnpm token -- --force                          # writes a new .admin-token
npx wrangler secret put ADMIN_TOKEN < .admin-token
```

With `ADMIN_TOKEN` unset the admin route refuses every request rather than falling open.

### YOUTUBE_API_KEY — not set

This one cannot be generated: it comes from a Google Cloud project with the YouTube Data
API v3 enabled. Until it exists the scheduled run only sweeps expired rows, which is a
safe state to be deployed in — the catalog simply stays empty.

```bash
npx wrangler secret put YOUTUBE_API_KEY
```

Set it yourself so the value never passes through a log.

## Using the token

`tools/admin.mjs` reads the token from disk and sends it in an `Authorization` header. It
is never printed and never passed as an argument, so it stays out of shell history and
process listings.

```bash
cd packages/worker
pnpm admin health              # liveness and item count (no token needed)
pnpm admin catalog -- --limit 5
pnpm admin crawl               # authenticated: triggers a crawl now
```

Both `--url <origin>` and `--token <path>` are accepted, so a second deployment or a
token kept elsewhere needs no code change. A token that does not match the deployed
secret produces a `401` and instructions rather than a stack trace.

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
