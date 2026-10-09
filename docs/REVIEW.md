# Code review and Netlify migration

Reviewed October 9, 2026. Original code baseline: `a4026ea`.

## Findings in the Streamlit application

These references identify the original Python implementation, which remains unchanged for reference. Fixes described below apply to the new Netlify implementation, not to the currently hosted Streamlit app.

| Priority | Finding and impact | Original location | Netlify implementation |
| --- | --- | --- | --- |
| High | Password embedded in query strings and bookmark links. Anyone with that URL can log in; browser history and URL logs can retain the credential. | `app.py:22–25,49–51` | Server-side password verification; signed, eight-hour, HttpOnly/Secure/SameSite cookies. No password URLs. Rotate the original password before cutover. |
| High | First Google/search result is accepted without checking business identity. Wrong branch/company contact details can be imported. Scraper can select unrelated domains. | `google_client.py:33–38`; `scraper.py:28–35`; `data_processor.py:166–184` | Remove search scraping; show up to three Google matches with location and require explicit selection. Fill empty fields only. Business phone is labeled as a business number. |
| High | No required-field validation or formula protection before export. Incomplete records reach the CRM; formula-like cells may execute when opened in spreadsheets. | `app.py:79–91` | Configurable required fields; format/conflict checks block CRM export. Formula-like inputs blocked, except numeric international phone strings. Separate formula-safe review download. |
| Medium | CSV/Excel type inference drops leading zeros in ZIP/phone fields. Casting later cannot restore them. | `app.py:60–63`; `data_processor.py:131–134` | CSV remains text; Excel zero-padded number formats are preserved. Values already damaged in the source cannot be reconstructed. |
| Medium | A last-name-only input has its last name overwritten with an empty string. | `data_processor.py:107–109` | Initialize fields independently; preserve supplied names. |
| Medium | Duplicate headers cause DataFrame construction failure; conflicting alias columns are silently resolved in favor of the first column. | `data_processor.py:65–84` | Map columns by position, coalesce blanks, flag conflicting nonblank values for review. |
| Medium | Enrichment runs only if domain is blank. Known-domain rows with missing phone/address never get enriched. | `data_processor.py:145–146` | Any named company may be looked up, regardless of existing domain. |
| Medium | A missing domain represented as NaN is truthy, so scraper fallback is skipped. | `data_processor.py:182` | Normalize blanks consistently; remove unreliable automatic scraping. |
| Medium | Processed data stays in session after uploads change, so a prior batch can be downloaded accidentally. | `app.py:74,79–91` | Replacing uploads, mappings, or defaults clears the old review/export. |
| Medium | Google HTTP requests have no timeouts. Batch processing can hang indefinitely; failures are logged with company names and possibly request URLs. | `google_client.py:30,48,89–92` | Ten-second timeout, bounded requests and safe generic errors; no customer/credential logging. |
| Medium | Password has no attempt limit. | `app.py:31–38` | Netlify rate limits on session and lookup functions. Deployment behavior must be smoke-tested on the selected plan. |
| Medium | Excel reads only the first worksheet; input sizes, schema conflicts and unmapped fields have no specific review workflow. | `app.py:53–66` | All nonempty worksheets listed with include/exclude choices, explicit mappings, worker parsing, size limits, and pagination. |
| Low | Search always adds Arizona, even if the record has a different state. | `google_client.py:20` | Use the row's company, street, city, state, and ZIP. AZ remains an editable default for blank states. |
| Low | Dependencies are unpinned and there are no tests. | `requirements.txt` | Exact direct JavaScript dependencies, lockfile, regression/security tests and npm audit. Legacy Python dependency risk has not been exhaustively audited. |

The last-name loss, duplicate-header crash, leading-zero loss, missing-domain NaN behavior and skipped enrichment with existing domains were reproduced with synthetic inputs and mocked external calls. The other findings derive from source inspection. This is a source review and targeted verification, not a penetration test or a certification of the live deployment.

## Existing CRM schema

Exact output order and spelling:

1. `Date of last door pull`
2. `contact owner`
3. `company name`
4. `address`
5. `city`
6. `State`
7. `zip`
8. `First name`
9. `last name`
10. `email`
11. `Company domain`
12. `phone`
13. `is doorpull`

Original defaults: missing State → AZ; missing is doorpull → True. The migrated CSV uses `true`/`false` strings. Confirm this with a small HubSpot import during cutover. The original code does not specify which values are mandatory. Accordingly, the UI allows the manager to select required fields, initially none. All 13 headers are always present. Verify the exact HubSpot property mappings and owner identifiers during the pilot; they cannot be inferred from header names alone.

## Intentional changes

- Browser-only table processing and editing. No server-side file storage, analytics or localStorage persistence. Reloading/signing out loses the batch.
- Shared password protects server-side business lookup. Public static frontend files contain no credentials or lead data. Shared credentials do not provide individual attribution or per-person revocation.
- Missing information is flagged, then entered manually or filled from an explicitly accepted Google business match. No individual email address is guessed. Automatic email-domain inference was removed because a contact's employer/domain may not identify the client company.
- Required fields are selected each session. Duplicate contacts are warnings and never silently merged/deleted. Conflicting mapped values block export until edited or explicitly accepted.
- Dates must be real ISO `YYYY-MM-DD` dates. Excel date cells are converted; ambiguous text dates require review.
- CSV is UTF-8 (optional BOM). XLSX is supported; XLS is not. First nonempty row must contain headers. Formula cells must be pasted as values first. Hidden worksheets are listed too; deselect any that do not belong in the import.
- Limits: 20 files, 20 MB combined, 10 MB per file, 10,000 combined rows, 100 columns and 150,000 cells per sheet, 40 MB declared expanded ZIP content and 2,000 ZIP entries. Worker timeout: 30 seconds per file. Limits reduce resource abuse; parsing hostile files is still subject to browser memory limits.
- Netlify lookup sends only the selected business/location to Google Places API (New), not the workbook, contact names or email addresses. Google configuration and paid API access remain to be verified.

## Verification

Run `npm ci`, `npm test`, `npm run build`, and `npm audit`.

Tests cover CSV round trips, schema, leading zeros, partial names, duplicate header conflicts, boolean/default preservation, validation, formula-like cells, XLSX dates/multiple sheets/formulas, session tampering/expiry/rotation, origin checks, unauthenticated lookup, request-size bounds, and missing authentication configuration.

Dependency note: ExcelJS 4.4.0 uses UUID v4 in its conditional-formatting code. Its UUID dependency is overridden to 11.1.1 (CommonJS-compatible) to remove an advisory in old UUID releases. The application uses workbook reading; tests also generate sample workbooks. ExcelJS still includes deprecated transitive packages; zero current npm advisories does not guarantee future safety.

No production deployment, live Google lookup, real-client-file comparison, or HubSpot import has been performed. Netlify's actual edge rate limits and secure-cookie behavior require deployment verification. The original Streamlit installation has not been modified remotely.

Final local verification: 16 automated tests passed; production build passed; npm audit reported zero known vulnerabilities. Browser smoke test passed for shared-password sign-in, combined CSV/XLSX parsing, required-field blocking, immediate edit validation, download and sign-out. The actual downloaded file was parsed and checked for exact headers, all three synthetic rows, leading-zero ZIP preservation and edited email values. A local UI issue discovered during testing was fixed by updating validation on input rather than waiting for blur. Screenshots: `preview.jpg` and `login-preview.jpg`.
