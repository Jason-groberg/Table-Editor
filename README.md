# Keepers lead import

Netlify-ready replacement for the original Streamlit table editor. Combine CSV/XLSX files, map inconsistent headers, review missing/conflicting values, and download one CSV using the existing 13 HubSpot column names. Shared team password; no permanent lead storage.

The Python files remain as the legacy Streamlit version. The Netlify app is in `web/`, with two server functions in `netlify/functions/`.

See [code review](docs/REVIEW.md) for findings, exact schema, behavior changes and limitations. Hosting upload/cutover is deferred at the owner's request.

## Development

Node 22 or later:

```sh
npm ci
npm test
npm run build
```

For a full local preview, create an ignored `.env` using `.env.example` and set `APP_PASSWORD` (16+ characters) and `SESSION_SECRET` (32+ random characters). `GOOGLE_API_KEY` is optional for manual processing. Then:

```sh
node --env-file=.env scripts/preview.mjs
```

Open `http://localhost:4173` (use localhost for the secure-cookie exception supported by modern browsers). The preview binds only to 127.0.0.1. It exercises real function handlers but does not emulate Netlify rate limits or static headers. Alternatively run Netlify Dev with the Netlify CLI. `npm run dev` alone serves the UI but does not serve the authentication functions.

## Netlify setup — for the later deployment walkthrough

1. Create/select the site in the paid Netlify team and connect this repository, or deploy using the Netlify CLI. A static folder drag-and-drop alone is insufficient: this app needs server functions.
2. Use Node 22, build command `npm run build`, publish directory `dist`, and functions directory `netlify/functions` (already in `netlify.toml`). Commit the lockfile for reproducible installs.
3. In Netlify environment variables, set a **new** `APP_PASSWORD` (16+ characters) and random `SESSION_SECRET` (32+ characters), scoped to Functions. Never use a `VITE_` prefix for secrets. Do not reuse the exposed Streamlit bookmark password. Missing/short secrets fail closed with a configuration message.
4. Optional: add `GOOGLE_API_KEY` for Google Places API (New), with that API enabled and suitable billing, API restrictions and quota configured in Google Cloud. Without it, imports, manual edits and downloads still work; lookups show a configuration message. Keys for the legacy Places API may need project changes.
5. Deploy the full app, including both functions. Use the HTTPS site URL and team password. No password appears in the URL.
6. Verify wrong-password rejection, correct login, refresh, sign-out, protected lookup, Netlify rate limits, expired sessions, CSP/headers and a small synthetic CSV/XLSX batch. Check real Google matches before accepting any business. Confirm functions are not cached.
7. Pilot representative salesperson files; verify all 13 HubSpot property mappings, owner values, dates, booleans, international phone numbers and the resulting CRM import. Only then change the manager's bookmark and retire Streamlit.

Use the **CRM CSV** for direct CRM upload. Use the separate **review copy** if opening the data in Excel: it neutralizes formula-leading characters, which may alter displayed values and should not be uploaded to the CRM.

Sessions expire after eight hours. Rotating either auth secret invalidates all sessions. Signing out clears the browser cookie and in-memory batch; this stateless design does not revoke a previously stolen cookie until expiry or secret rotation. Shared-password access has no individual audit trail.

Business suggestions are reviewed one row at a time, avoiding long serverless batch jobs. API errors never overwrite rows. Source files are processed in a worker and never uploaded; only explicitly requested business searches leave the browser.

## Security maintenance

Run `npm audit` during updates; keep the lockfile current and rerun tests/build. The current dependency override is explained in the review document. Do not add real client files, `.env` files, API keys or exported CSVs to source control.

Reference docs: [Netlify Functions](https://docs.netlify.com/build/functions/overview/), [Netlify rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/), [Google Places Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search).
