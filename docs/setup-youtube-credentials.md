# Connecting to the YouTube Data API

The application runs without any credentials — the feed, the ratings, the preferences
screen and the export all work against whatever is in the database. Follow this only
when you want it reading your real subscriptions and discovering new videos.

Nothing here sends preference data anywhere. These credentials are used to talk to
Google and to nobody else; the GPU service is never given a token (design section 44).

## 1. Google Cloud project

1. Create a project at <https://console.cloud.google.com/>.
2. Enable **YouTube Data API v3** under *APIs & Services → Library*.

## 2. OAuth consent screen

1. *APIs & Services → OAuth consent screen*.
2. User type **External** is fine for personal use.
3. Add the scope `https://www.googleapis.com/auth/youtube.readonly`. That is the
   narrowest scope covering `subscriptions.list(mine=true)`, and the system asks for no
   write scope because it never uploads, comments or edits anything.
4. Add your own Google account under **Test users**. Without this the sign-in is refused
   while the app is unpublished.

## 3. OAuth client

1. *APIs & Services → Credentials → Create credentials → OAuth client ID*.
2. Application type: **Web application**.
3. Under **Authorised redirect URIs**, add your deployment's callback:

   ```text
   https://<your-worker-host>/api/auth/youtube/callback
   ```

   For local development, `http://127.0.0.1:8787/api/auth/youtube/callback`.

   The redirect lands on the Worker, not on the browser. The browser never sees a token
   at any point in this flow (design section 16).

## 4. API key

1. *Create credentials → API key*.
2. Restrict it to **YouTube Data API v3**.

The API key covers the calls that act as nobody in particular — `videos.list`,
`playlistItems.list`, `search.list`. The OAuth token covers the one call that acts as
you, `subscriptions.list`. Using the token where the key would do would attach your
identity to requests that had no need of it, so the two are kept apart.

## 5. Set the secrets

```bash
cd apps/web

npx wrangler secret put YOUTUBE_API_KEY
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put OAUTH_REDIRECT_URI       # the URI from step 3

# 32 random bytes, base64. This wraps the stored token, so a copy of the database is
# not a copy of your account. Losing it means reconnecting; leaking it means the
# encryption bought you nothing.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))" \
  | npx wrangler secret put OAUTH_ENCRYPTION_KEY
```

For local development, put the same values in `apps/web/.dev.vars` (git-ignored):

```text
YOUTUBE_API_KEY="AIza..."
GOOGLE_CLIENT_ID="000000000000-xxxxxxxx.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-..."
OAUTH_REDIRECT_URI="http://127.0.0.1:8787/api/auth/youtube/callback"
OAUTH_ENCRYPTION_KEY="..."
```

## 6. Connect

Open **Settings** and press *Connect YouTube*. The subscription list is pulled
immediately; new uploads from those channels arrive on the next scheduled run, or when
you press *Fetch new uploads*.

## Daily budget

`search.list` has an allowance of a hundred calls a day, separate from the main quota,
and there is no way to ask what is left of it. A discovery run therefore spends at most
thirty, counted before each call rather than after (design section 42), leaving the rest
for manual searching and for a second run on a day when the first found nothing.

Everything else costs one unit per call against a ten-thousand unit allowance. Walking
forty channels' uploads twice a day is eighty units, so it is not the constraint.

When the search budget runs out, discovery degrades rather than failing: the
subscription lane keeps working, because it does not use `search.list` at all. Usage for
the day is shown on the **Settings** screen.
