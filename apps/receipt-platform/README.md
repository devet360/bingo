# Verity receipt verification platform

This receipt-verification product lives in the Bingo monorepo at `apps/receipt-platform` but remains an independently deployable service. It does not import Bingo runtime code, use the Bingo database, credit Bingo ledgers, or inherit Bingo deployment secrets. Its presence in this repository does not create a runtime integration; any future integration must use an explicit, authenticated network contract.

## Current delivery status

- `web/`: Angular 22.3 standalone app with the marketing overview, customer/admin readiness pages, API documentation, a local JSON request builder, Telegram Mini App shell, and a camera/upload receipt scanner. The scanner runs OCR in the browser, extracts editable candidates, and never uploads the image. The request builder intentionally does not send live calls because the server-side playground proxy is not yet implemented.
- `provider-coverage.md`: audited matrix distinguishing existing Bingo parser source from integrations actually enabled in this product. Nothing is enabled yet.
- `api/`: independent Spring Boot 3.5 / PostgreSQL foundation with Flyway schema, API-key verification middleware, tenant-scoped lookup, idempotent verification creation, audit writes, generated OpenAPI/Swagger UI, and a fail-closed provider registry. Persisted verification rows retain only a reference fingerprint, not the submitted reference. The API has no provisioned keys or enabled providers yet; it is not ready for customer traffic.
- CBE’s legacy branch-receipt adapter and parser are implemented behind `CBE_ENABLED=false` by default. It has deterministic parser/URL/suffix tests but no live endpoint smoke test; do not enable it for customer traffic until access and endpoint behavior are revalidated.
- `mobile/`: Flutter scanner package with camera/gallery capture and native ML Kit OCR for Android/iOS. Native platform scaffolding and Flutter builds have not been validated in this workspace.
- `api/`: Telegram webhook command handler and server-side Mini App `initData` signature/age validation are implemented behind server-only bot token and webhook-secret settings. Account linking, user sessions, entitlement-aware verification actions, and outbound status notifications are not yet implemented.
- Billing, admin RBAC/workflows, production identity/key management, Telebirr/M-Pesa relay integration, other provider adapters, complete SDK packages, and CI are not yet implemented. Do not use the overview page as evidence that the API is live.

## Deployment boundaries

| Project | Directory | Owns | Release/deployment |
| --- | --- | --- | --- |
| API | `api/` | Spring Boot, PostgreSQL schema, provider registry, API authentication, verification core | Independent Java container and database |
| Web | `web/` | Angular marketing, customer dashboard, admin, docs/playground, Telegram Mini App | Independent Angular build/deployment |
| Mobile | `mobile/` | Flutter receipt capture and on-device OCR client; account/session features pending | Independent Flutter release |
| SDKs | `sdks/{go,java,python,rust,node,php}/` (planned) | Independently versioned client packages | Package-specific releases |

The legacy PHP relay remains `apps/receipt-relay/`, deployed separately. Only the API may call it, over HTTPS, with server-side relay credentials. The relay is limited to Telebirr and M-Pesa and is never exposed as the customer API.

## Local development

The Angular app and Spring Boot API are separately runnable; PostgreSQL is provisioned by the product's Docker Compose file. The Flutter package contains the app and OCR source, but Android/iOS project scaffolding and native builds remain to be generated and verified with a Flutter toolchain. From this product directory:

```sh
cd apps/receipt-platform/web
npm ci
npm start -- --host 0.0.0.0 --port 4200
```

Start the API and its dedicated PostgreSQL database from the repository root with `docker compose -f apps/receipt-platform/compose.yaml up --build`. The only default credentials in `compose.yaml` are local-development values; replace them for any shared environment. Never point `RECEIPT_DATABASE_URL` at Bingo’s database or load Bingo `.env` files.

The API currently requires a registered API key in the `api_keys` table and has no public key-provisioning flow yet. It uses one-way digests for bearer-key validation; timestamped HMAC signing and managed encryption/key rotation are still required before production use. Provider adapters are not enabled, so verification requests fail closed with `UNSUPPORTED` until a tested authoritative integration is added. Do not report provider support based only on the audit matrix.

Telegram setup is opt-in. Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and an HTTPS `TELEGRAM_MINI_APP_URL` in the API deployment's secret manager. Register the Telegram webhook at `https://<api-host>/telegram/webhook` with Telegram's `secret_token` equal to `TELEGRAM_WEBHOOK_SECRET`. Route `/telegram/mini-app/auth` through the web app's same-origin API proxy. Cross-origin API access is not enabled. Never expose the bot token in the Angular bundle. The webhook supports `/start` and `/help`; verification commands explicitly state that account linking is not enabled.

## Phased implementation

1. Repository and requirements audit — complete; see the delivery note in the v0 conversation and `provider-coverage.md`.
2. Spring API, schema, tenant/API-key security, idempotency, provider contract, CBE and relay integrations — not complete.
3. Customer dashboard, docs/playground, plan enforcement, separate manual-payment billing, admin operations — not complete.
4. Flutter and Telegram channels with backend-enforced entitlements — not complete.
5. Additional tested providers and independently released SDKs — not complete.
