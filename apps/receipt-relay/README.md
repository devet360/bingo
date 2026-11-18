# Receipt relay (Telebirr + M-Pesa)

A small, public PHP API that runs on Ethio Telecom hosting and fetches receipts
from the two banks that only answer Ethiopian IPs:

- Telebirr — `https://transactioninfo.ethiotelecom.et/receipt/{reference}`
- M-Pesa — `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo={reference}`

It returns the bank's **raw answer** (HTML for Telebirr, the JSON envelope with
the base64 PDF for M-Pesa). Parsing and the verification gate stay in
`apps/api`, which consumes this relay through `RECEIPT_RELAY_URL` and records
the result with source `RELAY`.

The relay is not an open proxy: the caller only supplies a reference, never a
URL, and the two endpoint templates are fixed in `src/config.php`.

## Requirements

- PHP 8.1+
- The `curl` extension
- Apache with `mod_rewrite` (the included `.htaccess` files)

## Deploy (cPanel / shared hosting)

1. Upload this folder. Set the domain's (or subdomain's) **document root to
   `public/`**. The root `.htaccess` also works if the panel will not let you
   move the document root, but `public/` is preferred.
2. Confirm PHP selects 8.1 or newer for the domain (MultiPHP Manager).
3. Run the pure-function tests once:

   ```sh
   php tests/run.php
   ```

4. Smoke test from a browser or curl:

   ```sh
   curl -s https://YOUR-HOST/health
   curl -s https://YOUR-HOST/receipts/telebirr/DGXXXXXXXX
   curl -s https://YOUR-HOST/receipts/mpesa/XXXXXXXXXX
   ```

   A success is `{ "ok": true, ..., "bodyBase64": "..." }`. The raw bank answer
   is base64 in `bodyBase64`; `sourceUrl` is the page a person can open.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/health` | App name, version, supported providers |
| GET | `/receipts/{provider}/{reference}` | Raw bank answer, base64-encoded |

`provider` is `telebirr` or `mpesa`. `reference` is the receipt/transaction
reference; a full receipt link is accepted too and the reference is extracted
from it.

Errors are `{ "ok": false, "code": "...", "message": "..." }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REFERENCE` | Not a plausible reference for that provider |
| 404 | `UNKNOWN_PROVIDER` | Only `telebirr` and `mpesa` are served |
| 405 | `METHOD_NOT_ALLOWED` | GET only |
| 429 | `RATE_LIMITED` | More than 30 requests per minute from one IP |
| 502 | `UPSTREAM_ERROR` / `TOO_LARGE` | Bank unreachable or answer too large |
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
- No secrets are stored here; keep it that way. When authentication is needed
  later, put a shared token in `config.php` and check the `Authorization`
  header in `handle_request()`.

## Config

Edit `src/config.php` for timeouts, byte caps, the throttle, or to add another
provider (with its own fixed template and link pattern). The User-Agent is the
same browser string `apps/api` uses.
