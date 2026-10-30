# Deploying the admin site to Cloudflare Pages

The admin panel is a static React site: `dist/index.html`, `dist/assets/`, `dist/config.js` and `dist/_headers`. Cloudflare Pages only hosts those files. All data and logic stay in the Supabase Edge Function, which the page calls over HTTPS.

## What the build produces

`npm run build` runs `tools/build.js`, which runs the Vite build of `web/` into `dist/` and then writes:

- `index.html` and `assets/`: the admin panel (React bundle, CSS and the self-hosted Fraunces, Bricolage Grotesque, JetBrains Mono and Noto Sans Bengali fonts). `src/core/util.js` is bundled in.
- `theme-init.js`: sets the light or dark class before first paint (an external file so the CSP can forbid inline scripts).
- `config.js`: one line, `window.API_BASE_URL = "<url>";`, which `index.html` loads before the app.
- `_headers`: security headers, including a Content-Security-Policy that allows scripts from the site itself and API calls only to the Edge Function's origin.

The build also removes known stale files from older builds.

## Setting the API address

`config.js` gets its URL from the `API_BASE_URL` environment variable at build time. If the variable is not set, the build uses the default Edge Function URL, `https://snntvqrnakfdellwcsbs.supabase.co/functions/v1/api`.

```bash
# default URL
npm run build

# a different Edge Function URL
API_BASE_URL="https://example.test/functions/v1/api" npm run build
```

In PowerShell, set the variable first with `$env:API_BASE_URL = "https://example.test/functions/v1/api"` and then run `npm run build`. The URL is baked into `dist/config.js`, so rebuild whenever it changes.

## Prerequisites

1. A Cloudflare account.
2. The Wrangler CLI (`npm install -g wrangler`), signed in with `wrangler login`.

## Deploy

```bash
npm run build
wrangler pages deploy dist --project-name sales-tracker
```

`wrangler.toml` in the project root names the project (`sales-tracker`) and sets `pages_build_output_dir = "dist"`. It has no build command, so always run `npm run build` yourself before deploying.

To preview the built site locally with Wrangler, run `npm run preview` (it runs `wrangler pages dev dist`).

## Using the site

Set `ALLOWED_ORIGIN` on the function to this Pages site's URL, otherwise the browser blocks the panel's API calls. The function needs `APP_SECRET` and the panel must know the secret. It sends the value stored in the browser's local storage under `sales_tracker_secret` as the `X-App-Secret` header. The secret is never part of the built files.

## Troubleshooting

- **A "Not Found" page after deploy**: confirm `dist/index.html` exists after `npm run build`, and that you deployed the `dist` folder.
- **"API URL not configured." in the panel**: `dist/config.js` is missing or empty. Rebuild and redeploy.
- **Requests fail or return Unauthorized**: check that `API_BASE_URL` points at the deployed function and that the stored secret matches the function's `APP_SECRET`. The browser's developer tools show the failing request.
