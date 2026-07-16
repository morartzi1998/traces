# traces — Tripo backend (Cloudflare Worker)

This tiny worker turns an uploaded photo into a 3D model using the Tripo API,
while keeping your API key secret. The static site never sees the key.

## What you need
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- Node.js installed
- Your Tripo API key from https://platform.tripo3d.ai (API Keys page)

## Deploy (about 5 minutes)

From this `backend/` folder:

```bash
# 1. install the Cloudflare CLI (one-time)
npm install -g wrangler

# 2. log in to your Cloudflare account (opens a browser)
wrangler login

# 3. store your Tripo key as a SECRET (paste the key when prompted —
#    it is NOT written to any file)
wrangler secret put TRIPO_API_KEY

# 4. deploy
wrangler deploy
```

`wrangler deploy` prints a URL like:

```
https://traces-tripo.<your-subdomain>.workers.dev
```

## Turn it on in the site

Put that URL into `js/config.js` at the repo root:

```js
window.TRACES_API = "https://traces-tripo.<your-subdomain>.workers.dev";
```

Commit and push. Now the capture flow is live: **Upload a photo → Proceed →
the processing screen shows Tripo's real progress → the finished 3D model lands
in your archive.** With `TRACES_API` empty, the flow stays in its simulated form.

## Turn on "scan with your phone"

The upload screen's "Connect your phone" section shows a QR code; scanning it
opens a small page on the phone that takes a photo with the phone's own
camera and sends it to Tripo directly, then drops the resulting task off for
the desktop to pick up. That hand-off needs a tiny key-value store:

```bash
# from this backend/ folder
npx wrangler kv namespace create SESSIONS
```

This prints an id — paste it into `wrangler.toml`, uncommenting the
`[[kv_namespaces]]` block:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "the-id-it-printed"
```

Then redeploy:

```bash
wrangler deploy
```

Without this, the QR code still shows, but the desktop side will show an
error once the phone finishes (the relay has nowhere to store the hand-off).

## Notes
- Tripo model URLs are time-limited signed links. A capture stored in the
  archive references that URL; if it expires the model would need regenerating.
  (Fine for a demo; for permanence the worker could be extended to rehost the
  GLB in Cloudflare R2.)
- Every Tripo response is passed through in the worker's JSON as `raw`, so if
  Tripo changes an endpoint or field name it's visible immediately and only the
  constants at the top of `tripo-worker.js` need adjusting.
- Costs: Tripo charges credits per generation (free credits on signup);
  Cloudflare Workers has a generous free tier.
