# Connecting the extension to the YouTube Data API

The extension runs without any credentials: it falls back to a built-in fixture catalog so
the preference model, the interest editor and the ranker can all be exercised offline.
Follow this document only when you want it reading your real subscriptions.

Nothing here sends preference data anywhere. The credentials below are used to talk to
Google and to nobody else (design section 1).

## 1. Google Cloud project

1. Create a project at <https://console.cloud.google.com/>.
2. Enable **YouTube Data API v3** under *APIs & Services → Library*.

## 2. OAuth consent screen

1. *APIs & Services → OAuth consent screen*.
2. User type **External** is fine for personal use.
3. Add the scope `https://www.googleapis.com/auth/youtube.readonly`.
4. Add your own Google account under **Test users**. Without this the sign-in is refused
   while the app is unpublished.

## 3. OAuth client

1. *APIs & Services → Credentials → Create credentials → OAuth client ID*.
2. Application type: **Web application**.
   Not "Chrome extension" — this project uses `identity.launchWebAuthFlow`, which
   redirects to an https URI, so that the same code works in Firefox.
3. Under **Authorised redirect URIs**, add the value the extension shows on
   *Settings → Redirect URI to register*. It looks like:

   - Chrome: `https://<extension-id>.chromiumapp.org/`
   - Firefox: `https://<uuid>.extensions.allizom.org/`

   The id is derived from the unpacked extension's directory, so it stays the same as long
   as you load it from the same path. Loading it from a different folder changes the id and
   the redirect URI has to be added again.

## 4. API key

1. *Create credentials → API key*.
2. Restrict it to **YouTube Data API v3**.

The API key covers the calls that do not act on your behalf (`search.list`, `videos.list`);
the OAuth token covers the ones that do (`subscriptions.list`, `playlistItems.list`).

## 5. Load the extension

```bash
pnpm --filter @ypr/extension build
```

Then in Chrome: *chrome://extensions* → enable **Developer mode** → **Load unpacked** →
select `packages/extension/.output/chrome-mv3`.

In Firefox: *about:debugging → This Firefox → Load Temporary Add-on* → select
`packages/extension/.output/firefox-mv2/manifest.json`.

## 6. Enter the credentials

Open the extension, go to **Settings**, paste the client id and API key, press *Save*, then
*Connect* and complete the Google consent screen. **Status** should now show `live` instead
of `fixture`.

### Alternative: a build-time file

For a development build you can skip the UI by creating
`packages/extension/.env.local`:

```
VITE_YT_CLIENT_ID=000000000000-xxxxxxxx.apps.googleusercontent.com
VITE_YT_API_KEY=AIza...
```

The file is git-ignored. Values entered in the UI take precedence over it.

## Daily budget

The extension caps itself at 60 `search.list` calls per day and accounts general units
against a 10,000 unit budget (design section 6.1). Usage is shown on the **Status** tab and
resets on the US Pacific day boundary, which is when the API quota actually resets.

If a budget runs out, ingestion degrades rather than failing: the subscription lane keeps
working because it does not use `search.list` at all.
