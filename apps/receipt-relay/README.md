# Receipt relay (Telebirr + M-Pesa)

A small PHP API that runs on Ethio Telecom hosting and fetches receipts
from the two banks that only answer Ethiopian IPs:

- Telebirr — `https://transactioninfo.ethiotelecom.et/receipt/{reference}`
- M-Pesa — `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo={reference}`

It returns the bank's **raw answer** (HTML for Telebirr, the JSON envelope with
the base64 PDF for M-Pesa). Parsing and the verification gate stay in
`apps/api`, which consumes this relay through `RECEIPT_RELAY_URL` and records
the result with source `RELAY`.

The receipt endpoints require a dashboard-managed API key and secret over
HTTPS. The API reports its final verification status back to the relay, so the
dashboard can show verified counts by provider. The relay stores aggregate
events only; it does not store receipt references or the API secret in
plaintext.

For bandwidth, `?format=text` asks the relay to flatten the answer on the
Ethiopian host and return only the receipt's text lines — a few KB instead of a
26 KB page or a 350 KB envelope. Telebirr's page is reduced with the API's own
`htmlToLines` rules; M-Pesa's PDF is read with the vendored
[smalot/pdfparser](https://github.com/smalot/pdfparser). The API still reads the
labels and runs the gate. The API asks for text first and falls back to the raw
body when extraction is unavailable, so the raw endpoint stays the safety net.

The relay is not an open proxy: the caller only supplies a reference, never a
URL, and the two endpoint templates are fixed in `src/config.php`.

## Requirements

- PHP 8.1+ with the `curl`, `zlib`, `iconv` and `mbstring` extensions
- Apache with `mod_rewrite` (the included `.htaccess` files)
- PHP `pdo_mysql` for dashboard, authentication and analytics
- No Composer: the PDF reader is vendored under `vendor/` (see
  `vendor/README.md`)

## Deploy (Plesk / shared hosting)

1. In Plesk, create a MySQL database and database user. Grant that user access
   to the new database. Use phpMyAdmin to import `database/schema.sql`.
   If the dashboard bootstrap does not create its first account, run
   `database/create-superadmin.sql` in phpMyAdmin's SQL tab. It creates or
   resets the `id = 1` super-admin account.
2. Upload this folder and set the domain's **document root to `public/`**.
   Confirm the domain uses PHP 8.1+ and enables `curl`, `zlib`, `iconv`,
   `mbstring`, and `pdo_mysql`.
3. Copy `src/config.local.example.php` to `src/config.local.php` and enter the
   Plesk MySQL host, database name, user and password. Set a unique
   super-admin username and a randomly generated password of at least 16
   characters. Keep `config.local.php` private and never commit it.
4. Open `https://YOUR-HOST/admin` and sign in with those bootstrap credentials.
   Change the password in the dashboard, then remove the bootstrap password
   from `config.local.php`. The bootstrap user is created only once; subsequent
   changes to the config file do not reset it.
5. In the dashboard, create an API key. Copy the key and secret immediately:
   only the secret's password hash is stored and it cannot be viewed again.
   Configure the Node API with the key pair as `RECEIPT_RELAY_API_KEY` and
   `RECEIPT_RELAY_API_SECRET`, along with `RECEIPT_RELAY_URL`.
6. Run the pure-function tests once:

   ```sh
   php tests/run.php
   ```

7. Smoke test from a browser or curl:

   ```sh
   curl -s https://YOUR-HOST/health
   curl -s https://YOUR-HOST/docs
   curl -s -H "X-API-Key: YOUR_KEY" -H "X-API-Secret: YOUR_SECRET" \
     "https://YOUR-HOST/receipts/telebirr/DGXXXXXXXX"
   curl -s -H "X-API-Key: YOUR_KEY" -H "X-API-Secret: YOUR_SECRET" \
     "https://YOUR-HOST/receipts/telebirr/DGXXXXXXXX?format=text"
   ```

   A success is `{ "ok": true, ..., "bodyBase64": "..." }`. The raw bank answer
   is base64 in `bodyBase64`; `sourceUrl` is the page a person can open.
   Upload the whole folder, `vendor/` included: without it the relay still
   serves raw bodies and answers `EXTRACTION_FAILED` in text mode, and the API
   automatically falls back to the raw endpoint.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | App name, version, supported providers |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3.1 specification |
| GET | `/receipts/{provider}/{reference}` | Authenticated raw bank answer, base64-encoded |
| GET | `/receipts/{provider}?reference=...` | Authenticated fetch for a pasted receipt link |
| GET | `/receipts/{provider}/{reference}?format=text` | Authenticated receipt text lines (small answer) |
| POST | `/events/verification` | Authenticated final verification result from `apps/api` |

`provider` is `telebirr` or `mpesa`. `reference` is the receipt/transaction
reference. Pass a bare reference in the path; pass a full receipt link in
`?reference=` (URL-encoded) — web servers reject the encoded slashes a link
carries in a path. The reference is extracted from the link and checked. All
receipt and analytics requests must use both `X-API-Key` and `X-API-Secret`.
Use HTTPS only.

```sh
curl -H "X-API-Key: YOUR_KEY" -H "X-API-Secret: YOUR_SECRET" \
  "https://YOUR-HOST/receipts/telebirr?reference=https%3A%2F%2Ftransactioninfo.ethiotelecom.et%2Freceipt%2FDGXXXXXXXX"
```

With `format=text` the success is `{ "ok": true, ..., "format": "text", "text":
"..." }`; the lines are exactly what `apps/api`'s parser reads. A bank "no
receipt" answer still comes back as HTTP 200 with `"notFound": true` and a
message.

Errors are `{ "ok": false, "code": "...", "message": "..." }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REFERENCE` | Not a plausible reference for that provider |
| 400 | `INVALID_FORMAT` | `format` is neither `text` nor `raw` |
| 400 | `HTTPS_REQUIRED` | Authenticated routes require HTTPS |
| 401 | `UNAUTHORIZED` | API key or secret is missing, invalid, or revoked |
| 404 | `UNKNOWN_PROVIDER` | Only `telebirr` and `mpesa` are served |
| 405 | `METHOD_NOT_ALLOWED` | Unsupported method |
| 413 | `REQUEST_TOO_LARGE` | Verification event body exceeds its size limit |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Verification events require `application/json` |
| 422 | `EXTRACTION_FAILED` | `format=text`: the answer could not be turned into text |
| 429 | `RATE_LIMITED` | More than 30 requests per minute from one IP |
| 502 | `UPSTREAM_ERROR` / `TOO_LARGE` | Bank unreachable or answer too large |
| 503 | `SERVICE_UNAVAILABLE` | MySQL or analytics storage is unavailable |
| 504 | `TIMEOUT` | Bank did not answer in time |

The bank's own "no receipt" answers are passed through unchanged (HTTP 200, raw
body): Telebirr's "This request is not correct" page and M-Pesa's non-zero
`responseCode` envelope. `apps/api` turns those into "not found".

## Security notes

- Endpoint URLs come from `src/config.php`, never from the request.
- References are validated against a strict charset, then URL-encoded.
- Redirects are not followed; https only; 5 s connect / 20 s total; byte caps
  match the API (2 MB text, ~7 MB M-Pesa envelope).
- A file-based per-IP throttle (30/min, fails open) keeps the public endpoint
  from being used to hammer the banks. It keys on `REMOTE_ADDR` only, since a
  forwarded header is caller-controlled.
- API secrets are randomly generated, shown once and stored as password hashes
  in MySQL. Revoking a key immediately disables it.
- Super-admin passwords are also hashed. The initial account is seeded only
  when the admin table is empty, from `config.local.php`.
- Traffic analytics store event type, provider, result, API key ID and time;
  they do not store receipt references or bank payloads.
- Keep Plesk and relay connections on HTTPS; never place database or API
  credentials in source control.

## Config

Edit `src/config.php` for timeouts, byte caps, the throttle, or to add another
provider (with its own fixed template and link pattern). Put database and
bootstrap admin credentials in the ignored `src/config.local.php`, not
`src/config.php`. The User-Agent is the same browser string `apps/api` uses.
