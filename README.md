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

Sign-in has no automatic app expiration. A persistent cookie is renewed for 400 days whenever the user returns to the app. Browsers may cap retention or clear cookies, so indefinite sign-in cannot be guaranteed after prolonged inactivity or in private browsing. Signing out, clearing cookies, or using a different browser requires signing in again. Still-valid older sessions are upgraded on the next visit; expired sessions require a fresh login. Rotating either auth secret invalidates all sessions. Signing out clears the browser cookie and in-memory batch; a copied session token remains valid until either authentication secret is rotated. Shared-password access has no individual audit trail. Remembering sign-in does not save uploaded files: reloading still clears the batch.

Combine automatically looks up missing business details through short, paced server requests. API errors never overwrite rows. Source files are processed in a worker and never uploaded; company names and locations needing enrichment are sent to Google Maps when Combine is pressed.

## Security maintenance

Run `npm audit` during updates; keep the lockfile current and rerun tests/build. The current dependency override is explained in the review document. Do not add real client files, `.env` files, API keys or exported CSVs to source control.

Reference docs: [Netlify Functions](https://docs.netlify.com/build/functions/overview/), [Netlify rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/), [Google Places Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search).

## Fixed import rules

All 13 columns are always exported. `is doorpull` is fixed to `true` for every row, including when an input says otherwise. It is the only required field and is read-only in the editor. There is no required-field selector or default state. Missing contact and location fields stay blank unless supplied by the source, entered manually, or filled from an automatic matched business lookup or a manually accepted suggestion. Failed lookups do not block exporting incomplete rows. Format, formula-safety and conflicting-value checks still apply to populated fields.

## Automatic business enrichment

Press **Combine & fill missing details** to normalize the files, look up missing business fields, and prepare a single CRM CSV. Successful batches automatically start a download; the download button remains available if the browser blocks automatic downloads or further edits are needed. Existing format and conflict errors still require correction before CRM export.

Google Places can fill business name, company domain, business phone, address, city, state and ZIP. It does not supply individual contact names, email addresses, contact owners or door-pull dates. Existing source values are never overwritten; unknown values remain blank and `is doorpull` remains true.

Every row missing any of the 13 output values is eligible for a lookup. Search precedence is a custom business domain from the email, then an existing company domain, then the company/account name. Common personal-email providers are excluded. Available street address, city and ZIP are added to the query; every query includes Arizona. With only a name, the query is `{company name} in Arizona`. With neither a name nor a usable domain, the row is retained without a lookup.

Each eligible row uses one Google Text Search request, with no fallback search by a different identifier. Duplicate queries reuse the batch result. A retry after Netlify rate-limits a request does not introduce a second Google query: the first request was blocked before reaching the function. Results outside Arizona are discarded by the server. Automatic filling requires one Arizona candidate matching the preferred domain, or matching the normalized company name when no domain is available, and agreeing with supplied location fields. Name-only searches can fill a unique matching Arizona business; multiple matches stay blank for review. Existing supplied values are never overwritten, even if the email domain differs from a supplied domain. Google source details appear beside enriched rows and are excluded from CRM columns.

Requests run sequentially at most about 19 per minute to respect the server's 20/minute per-IP limit. Duplicate company/location queries reuse results within the batch. A rate-limited call retries once after about a minute. Missing API configuration stops further network calls for that batch; temporary failures do not prevent subsequent rows from being processed. Large batches can take time: keep the tab open. **Stop lookup & review** cancels further work and retains completed enrichment. Changing files/mappings cancels the old batch and prevents late responses from changing the new batch.

Verification: 34 automated tests passed, including automatic enrichment, source-value preservation, duplicate queries, incomplete exports, ambiguous matches, API errors, retries and cancellation. Google responses in automated tests are mocked; live API credentials still need verification on Netlify.

US numeric CSV dates (`M/D/YYYY`) are converted to ISO `YYYY-MM-DD` during import. Invalid dates remain flagged for review.
