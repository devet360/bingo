# Receipt platform provider coverage

This matrix is an audit of the Bingo source checkout, not a statement that these integrations are enabled or production-supported by the new receipt platform. The separate product currently has no provider adapter deployed.

| Provider | Region / currency | Bingo source evidence | New product status | Next verification work |
| --- | --- | --- | --- | --- |
| CBE | Ethiopia / ETB | Legacy branch-receipt PDF parser, fixed HTTPS host allowlist, parser and checker tests; requires receiving account suffix | Adapter/parser port implemented but disabled by default; no live-access smoke test | Run isolated Java tests, validate DNS/TLS/HTTP behavior and current endpoint policy, verify capped PDF response parsing against deterministic fixtures, and only then decide whether to enable |
| Telebirr | Ethiopia / ETB | Receipt page parser, shared verification gate, relay path and tests | Not enabled; relay-dependent | Configure the private HTTPS relay, port parser/gate, verify relay output locally, and test relay outage and fallback |
| M-Pesa Ethiopia | Ethiopia / ETB | JSON/PDF receipt parser, shared gate, relay path and tests | Not enabled; relay-dependent | Same as Telebirr; include PDF envelope and non-zero response-code fixtures |
| Bank of Abyssinia | Ethiopia / ETB | Parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| Dashen Bank | Ethiopia / ETB | Parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| Awash Bank | Ethiopia / ETB | Share-link parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| CBE Birr | Ethiopia / ETB | Phone-dependent parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| eBirr family (Nib, Wegagen, Ahadu, KAAFI) | Ethiopia / ETB | Shared parser; some tenants are disabled in Bingo's seeded catalogue | Not enabled | Verify tenant-specific receipt semantics and availability individually |
| Siinqee Bank | Ethiopia / ETB | Shared eBirr parser and allowlisted endpoint | Not enabled | Isolated adapter port and current live-response evidence |
| Bunna International Bank | Ethiopia / ETB | Parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| ZamZam Bank | Ethiopia / ETB | Parser and allowlisted endpoint in Bingo catalogue | Not enabled | Isolated adapter port and current live-response evidence |
| Zemen Bank | Ethiopia / ETB | Parser exists, but Bingo seed disables it | Not enabled | Determine current endpoint access and complete isolated tests before enabling |
| PayPal | Global | No authoritative integration found in the repository | Unsupported | Official business API/OAuth or verified webhook integration required |
| Crypto | Per configured chain | No integration found in the repository | Unsupported | Explicit chain/indexer/RPC configuration and finality/reorg policy required |

## Outcome policy

A source parser or catalog entry is not sufficient to enable a provider. A provider remains disabled until its source is confirmed, its adapter is tested with deterministic fixtures, expectations are enforced independently from parsing, duplicate-reference and outage behavior are tested, and operational access is configured. A screenshot or client-submitted relay payload alone can never produce `VERIFIED`.

## Roadmap

1. Port CBE as the initial direct bank adapter and establish the adapter contract and conformance fixtures.
2. Add Telebirr and M-Pesa using only the separate internal PHP relay. Keep relay credentials server-side, treat relay output as untrusted, parse and gate it in the API, and preserve `UNREACHABLE` behavior during relay failure.
3. Port other existing Ethiopian parsers one at a time after source verification and provider-access checks.
4. Add PayPal and explicitly configured crypto networks only when authoritative sources and operational credentials are available.
