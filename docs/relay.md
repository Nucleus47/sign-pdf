# Relay

The relay is an optional server that passes a document from the first signer (A) to the second signer (B) by email. It stores only an encrypted copy. The app works without it: the [hand-off PDF](handoff-pdf.md) stays available as the fallback. The relay is the Cloudflare Worker in `packages/relay`, on the same origin as the web app, under `/relay/*`.

Design and decisions: issue #65.

## Feature flag

The relay is off unless the Worker var `RELAY_MODE` is `on` (`packages/relay/wrangler.jsonc`; the production value is `off` for now). While off, every `/relay` path answers 404 `not-found`, the same as an unknown path, so the Worker cannot store a blob or send mail. The web app asks `GET /relay/config` before it mentions email: the start page then describes only the download flow, and the end-of-turn choices show no "Email it". A link from an earlier email (`#relay=...`) fails to open while the relay is off. Tests, `pnpm dev` and the CI relay job set `RELAY_MODE=on`.

To turn it on: do the operator setup below, set `RELAY_MODE` to `on` in `wrangler.jsonc`, and deploy.

## Flow

1. A finishes their fields and chooses to email the document to B.
2. A enters their own email address and gets a 6-digit code. A enters the code. The session lasts 24 hours.
3. A's browser encrypts the hand-off packet with a new random key, uploads the ciphertext, and asks the relay to email B a link. The key is only in the link's `#fragment`. When A sets a passphrase, the browser also wraps the key with it and sends the wrapped key with the same request (see [Collect on any device](#collect-on-any-device)).
4. B opens the link and taps **Open**, after entering the password if A set one. Nothing is fetched before the tap. B's browser downloads and decrypts the packet and resumes the sign view at B's turn. B signs.
5. B's browser encrypts the signed PDF with the same key and uploads it, and B downloads their own copy. The relay deletes the hand-off and emails A a link and a 6-digit code.
6. A opens the link (`#relay=<id>`, no key) on the device that sent the document and enters the code, and the password if A set one. Nothing is fetched before A submits the code. A's browser fetches and decrypts the signed PDF with the key it kept in `localStorage`, downloads it, then deletes the document from the relay (`DELETE`; a failed delete is ignored, the expiry removes it) and removes the kept key. On another device, A enters the code and the passphrase: the browser unwraps the key that comes back with the signed PDF. Without a passphrase, another device cannot open the signed PDF, and the card says to ask B for it. The screens: [collect the signed document](signing.md#collect-the-signed-document).

Two signers only in v1. The browser enforces this: the relay cannot see the packet.

## Send it again

The first signer can send a hand-off again without signing again (issue #98). No new route: a new send is a new document.

- When the email flow makes its relay id, before the upload, the browser keeps the ciphertext it uploads in IndexedDB (`sign-pdf` / `sent-handoffs`, key = the relay id), with the document name, the next signer's name, the file names and the expiry (the start + 7 days, then the relay's `expiresAt`). It never keeps the packet in plain form.
- The key goes into the `localStorage` entry of that id at the same time ([collect](signing.md#collect-the-signed-document)), and again with the relay's expiry after `/send` succeeds. When IndexedDB cannot keep the copy, the key of an unsent document is removed.
- "Email it again" and "Download the PDF for <next signer>" decrypt the copy in memory with the kept key, as B's browser does (the original id in the AAD, purpose `handoff`). A copy sent with a password needs that password. "Email it again" then encrypts the packet under a new id and a new key, uploads it and sends it. The new entry replaces the old one only after `/send` succeeds; the old id moves to the entry's `prev`. The old link works until it expires, and its key stays in `localStorage`, so A can collect from either link.
- Keys and copies stay 7 days after the link expired (`RELAY_KEEP_AFTER_EXPIRY_DAYS`), so an expired send can go out again.
- When A collects the signed PDF of any of these ids, the browser removes the entry.
- At start-up the app removes copies past their keep time, damaged copies, and copies whose key is gone from `localStorage`: without the key a copy cannot be opened.
- Without IndexedDB the app works; only the retry in the open tab exists.
- Someone with access to A's browser profile gets the key and the ciphertext, so the document: the same as the key kept for collecting. "Remove" in "Documents you sent" deletes the copy.

## Protocol

Same origin as the app. JSON unless noted. Every error is `{error, code}`. Every `/relay` response has `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The request and response schemas are in `packages/spec/src/relay.ts`.

| Method and path | Auth | Request → response |
|---|---|---|
| `POST /relay/login` | Turnstile token, when Turnstile is on | `{email, turnstile}` → `{ok:true}`. The answer is the same when Turnstile fails, a rate limit or a daily cap hits, or the mail fails. Emails a 6-digit code, valid 10 minutes. |
| `POST /relay/login/verify` | – | `{email, code}` → `{session, expiresAt}`. 401 `bad-code` for a wrong, expired, used or locked code. 5 wrong attempts lock the address until the code expires. |
| `GET /relay/config` | – | `{turnstileSiteKey}`; empty when `TURNSTILE_MODE=off`, and the page then shows no widget. |
| `PUT /relay/docs/:id` | `Authorization: Bearer <session>`; `X-Relay-To` (B's address), `X-Relay-Password: 0` or `1`, `Content-Length` | raw ciphertext → `{id, expiresAt}`. The browser chooses the id. Create-only: 409 `id-taken` when any object of that id exists (hand-off, `sent`, final or its gate). 411 without `Content-Length`, 413 `too-large` over 40 MiB. |
| `POST /relay/docs/:id/send` | Bearer, the uploader only | `{key, wrappedKey?}` → `{ok:true}`. `wrappedKey` is 80 base64url characters. It is required when the upload sent `X-Relay-Password: 1` and refused when it sent `0`: 400 `bad-wrapped-key` in both cases and for a malformed one, and no email goes out. Emails B once; 409 `already-sent` after that, and 409 `send-pending` while another `/send` for the same document is still running. 502 `email-failed` lets A try again. |
| `GET /relay/docs/:id` | the id | raw ciphertext, header `X-Relay-Password`. 404 when missing, expired or already signed. |
| `PUT /relay/docs/:id/final` | the id; `Content-Length` | raw ciphertext → `{ok:true}`. Create-only: 409 `final-exists`. Deletes the hand-off and emails A. |
| `GET /relay/docs/:id/final` | header `X-Relay-Code` | raw ciphertext, and header `X-Relay-Wrapped-Key` when A set a passphrase. 401 `bad-code`; 5 wrong attempts delete the document. A wrong code never gets the wrapped key. |
| `DELETE /relay/docs/:id` | the id | 204 always. Anyone with the id can delete: denial only, no disclosure. |
| `GET /relay/dev/outbox` | dev mode only | `{messages:[{to, from, replyTo?, subject, text, at}]}`. 404 unless `MAIL_TRANSPORT=dev-outbox`. |

Other codes: 400 `bad-request`, 400 `bad-wrapped-key`, 401 `unauthorized` (no valid session), 404 `not-found`, 429 `rate-limited`, 500 `server-error`.

Upload and send are two requests, so no single request holds both the ciphertext and the key. The wrapped key goes with `/send` rather than a route of its own: `/send` already checks A's session and that A is the uploader, and the relay stores the wrapped key exactly when B's email goes out.

The browser chooses the document id (128 random bits) because the encryption binds the blob to its id before the upload: the id is in the AAD and in the password's PBKDF2 salt. The relay checks the id's form and refuses one that is in use, so an upload never replaces or revives another document.

Without a Turnstile site key the page sends the fixed token `none`: the login body needs a non-empty token, and the relay does not check it when `TURNSTILE_MODE=off`.

## Collect on any device

The return email has no key, so only the device that sent can open the signed PDF with the kept key. A passphrase lets A collect on any device (issue #105).

1. At send time, A's browser derives a wrapping key from the passphrase: PBKDF2-SHA256 (NFC, salt `sign-pdf-relay/wrap/` + id, 600,000 iterations), then HKDF-SHA256 (info `sign-pdf-relay/v1/wrap-key`).
2. It wraps the document key with AES-256-GCM: a 12-byte random nonce, AAD `sign-pdf-relay/v1|` + id + `|wrap`. The result is 60 bytes, sent as 80 base64url characters in the `/send` body.
3. The relay keeps the wrapped key with the `sent` marker, then in `final.json`. It returns the wrapped key in `X-Relay-Wrapped-Key` only with the right code. The code check, the attempt limit and the deletion rules are the same as without it.
4. On a device with no kept key, the browser asks for the code and the passphrase. It unwraps the key on the device, then decrypts the signed PDF with the key and the same passphrase. A wrong passphrase fails on the device and uses no code attempt.

The passphrase must have at least `RELAY_PASSPHRASE_MIN` (8) characters (`packages/spec/src/relay.ts`). Only the browser can check this rule: the server never receives the passphrase. The server checks what it can: a wrapped key comes exactly when the password flag is 1. The passphrase and the key never reach the server. The crypto: `wrapKey` and `unwrapKey` in `packages/web/src/lib/relayCrypto.ts`.

## State and lifetimes

R2 only, no database.

| Object | Holds | Lifetime |
|---|---|---|
| `relay/<id>/handoff.bin` | ciphertext; metadata `from`, `to`, `password`, `expiresAt` | 7 days after upload, or until the final is uploaded |
| `relay/<id>/sent` | `{state, at, wrappedKey?}`: `pending` while B's email goes out, then `sent` (create-only) | with the hand-off |
| `relay/<id>/final.bin` | ciphertext of the signed PDF (create-only) | the sooner of upload + 7 days and the final upload + 5 days |
| `relay/<id>/final.json` | `{to, codeHash, attempts, expiresAt, wrappedKey?}`; the final upload copies `wrappedKey` from `sent` | with the final |
| `relay/login/<sha256(email)>.json` | `{codeHash, attempts, expiresAt}` | 10 minutes after the last code, or until used |
| `relay/quota/login-address/<yyyy-mm-dd>/<sha256(email)>.json` | `{count}`: login codes sent to one address that UTC day | the lifecycle rule |
| `relay/quota/login/<yyyy-mm-dd>` | `{count}`: login emails sent that UTC day, all addresses | the lifecycle rule |
| `relay/dev-outbox/*.json` | mail, dev mode only | the lifecycle rule |

- R2 cannot change an object's metadata in place. The `sent` flag and the code attempts are small separate objects, so the relay never rewrites a 40 MiB blob.
- Every read checks `expiresAt`. An expired object is a 404 and is deleted in the background. An R2 lifecycle rule deletes everything under `relay/` after 8 days as the backstop.
- `id` is 128 random bits (22 base64url characters), chosen by the browser. The relay checks it before it builds any key.
- `codeHash` is `HMAC-SHA256(RELAY_SESSION_SECRET, scope|code)`, where the scope is `login:<sha256(email)>` or `final:<id>`.
- Each code attempt is counted before the code is compared, with a compare-and-swap on the record's etag. Parallel guesses cannot pass the 5-attempt limit.
- A new login code keeps the failed attempts of the live one. After 5 wrong attempts the record stays locked until it expires, so asking for new codes never buys more guesses. An attacker can lock an address for 10 minutes; that is the cost.
- The final code works for every attempt until the final is deleted. The app deletes the final (`DELETE`) after it decrypts and saves the PDF.
- A pending `sent` claim older than 60 seconds belongs to a request that died, and the next `/send` takes it over.
- A failed upload leaves no object. When R2 stores the declared bytes and more bytes follow, the relay deletes that object, and only an object tagged with its own upload nonce.
- Create-only writes use `put` with `onlyIf: {etagDoesNotMatch: "*"}`. The Worker tests check this in the local R2 emulator.
- The session token is `base64url(payload).base64url(HMAC-SHA256(secret, "session|" + payload))`, payload `{e, exp, v: 1}`, 24 hours. Nothing is stored.

## What the server can see

The server learns both email addresses, blob sizes, times, IP addresses and the password flag. It sees the key only in transit, while `/send` composes B's email. It never stores or logs the key, and the `/send` handler has no logging (a test checks the source). It never learns the PDF, its title, names, values, signatures or the password. With a passphrase, it stores the wrapped key and never logs it; the wrapped key does not open without the passphrase.

Browser crypto: `packages/web/src/lib/relayCrypto.ts`. AES-256-GCM, a per-blob key from HKDF, and AAD that binds each blob to its id and role. The optional password goes through PBKDF2 (after Unicode NFC normalization) into the key, so nothing the server or the mail path saw can decrypt.

## Threat model

| Attacker | Gets | Stopped by |
|---|---|---|
| Server admin reading logs or R2 | emails, sizes, times, ciphertext | the key is never at rest; no logging on `/send`; the password option voids the in-transit view |
| Someone reading B's inbox | the id and key, so the packet; can sign as B | the password option; 7-day expiry; the final is create-only; A sees who signed in the audit |
| Id guesser | 2⁻¹²⁸ per try; ciphertext at best | random id, rate limit, the same 404 for every miss |
| Link prefetcher or scanner | index.html only | the fragment is never sent; no GET changes state; Open needs a tap |
| Spammer using the sender | mail to victims | rate limits, daily caps, verified sender, fixed templates; Turnstile when on |
| Malicious B uploads garbage | A cannot decrypt | GCM tag and AAD; A is told to ask B for the file |
| Operator, or anyone with R2 access, when A set a passphrase | the wrapped key and the ciphertext: they can try passphrases offline | PBKDF2-SHA256 at 600,000 iterations per guess and the 8-character minimum make that slow; documents sent with no passphrase keep the strict guarantee (no wrapped key is stored) |
| Someone with A's return email, when A set a passphrase | the code, so the wrapped key and the signed ciphertext | the passphrase, which is not in any email; 5 code attempts; the final's expiry |

## Abuse controls

- `POST /relay/login` is the only unauthenticated path that sends email. `/send` needs a session and `/final` needs a valid id, and each emails once per document.
- Daily caps on `POST /relay/login`, counted in R2 per UTC day:
  - 5 login codes per address (`relay/quota/login-address/<day>/<sha256(email)>.json`).
  - 300 login emails for all addresses together (`relay/quota/login/<day>`). This is a bot and abuse cap: Email Service includes 3,000 messages a month, and one attack must not spend them.
  - Each counter is `{count}`, updated with a compare-and-swap on its etag (`onlyIf: {etagMatches}`, or create-only for a new day). A lost race is retried 3 times. When the counter cannot be updated, no email goes out (fail closed).
  - The address count goes up before the global one and before the mail, so a request stopped later (the global cap, a lost race on the code record, a mail failure) still uses one of the address's 5 codes. A capped request does not replace the code already sent.
  - Anyone can name any address, so 5 requests lock that address out of new codes until the next UTC day, and 300 addresses stop every login for the day. That is the cost of having no Turnstile; turn it on (below) if it happens.
  - R2 accepts about one write per second to one key. A burst of parallel logins can lose the race more than 3 times; those requests send no email.
  - A capped request gets the same `{ok:true}` and no email. The log line names the cap only: `relay: login cap-address` or `relay: login cap-global` (`-unavailable` when the counter could not be updated or does not parse). It never holds the address.
  - The constants are in `packages/relay/src/quota.ts`.
- Turnstile is optional and off by default (`TURNSTILE_MODE=off`). It stays off until there is real traffic; the rate limits and the daily caps hold meanwhile. With Turnstile off, the server ignores the `turnstile` field; the app sends the fixed token `none` and shows no widget. When Turnstile is on, the page loads the widget from `https://challenges.cloudflare.com` only on the sign-in step; the CSP allows that origin in `script-src` and `frame-src` and nowhere else.
- Rate Limiting bindings per IP: login 5, verify 10, upload, send and final upload 10, reads and deletes 60, each per 60 seconds. Per `sha256(email)`: login 3, verify 10, upload 10. The limits are per Cloudflare location and approximate.
- `Content-Length` is required and must be 40 MiB or less. The body goes through a counting stream that stops the upload past the declared length.
- One email to B and one to A per document.
- No per-sender storage quota in v1: a signed-in sender can upload 10 blobs of 40 MiB per minute per location, kept up to 7 days. Add a quota if abuse shows up.
- Fixed plain-text templates. The only variable parts are the two validated addresses, the link, a code and a date.
- An Email Service error is a 502 `email-failed`. Login and final log the error code only; `/send` logs nothing.

## Operator setup

You need a Cloudflare account on Workers Paid with Email Service on. Do these steps before the first deploy that includes the relay, because `wrangler deploy` fails when the bucket does not exist.

1. Create the R2 bucket: `wrangler r2 bucket create sign-pdf-relay`.
2. Add a lifecycle rule that deletes objects with prefix `relay/` 8 days after upload: `wrangler r2 bucket lifecycle add sign-pdf-relay relay-backstop relay/ --expire-days 8`.
3. Set the session secret, at least 32 random characters: `openssl rand -base64 48 | wrangler secret put RELAY_SESSION_SECRET`. A new secret signs everyone out and voids the open codes. This is the only required secret.
4. Onboard the sending domain in Email Service (SPF, DKIM, DMARC) and set `MAIL_FROM` to an address on it. The display name is "sign-pdf".
5. Set `PUBLIC_ORIGIN` to the app's origin. Emailed links start with it.

Self-hosting: change the bucket name, `MAIL_FROM` and `PUBLIC_ORIGIN` in `packages/relay/wrangler.jsonc`.

Vars: `RELAY_MODE` (`off`, the default, or `on`), `TURNSTILE_MODE` (`off`, the default, or `on`), `TURNSTILE_SITE_KEY` (empty while Turnstile is off), `MAIL_TRANSPORT` (`cloudflare` or `dev-outbox`), `PUBLIC_ORIGIN`, `MAIL_FROM`. Secrets: `RELAY_SESSION_SECRET`; `TURNSTILE_SECRET` only when Turnstile is on. Without the session secret every relay route answers 500.

`MAIL_TRANSPORT=dev-outbox` and a session secret that starts with `dev-only-` (the one `pnpm dev` passes) work only when `PUBLIC_ORIGIN` is `http://127.0.0.1` or `http://localhost` (any port). With any other origin every relay route answers 500, because the outbox shows every link and key to anyone, and the dev secret is public. `TURNSTILE_MODE=off` works on any origin.

### Turn Turnstile on

Do this when bots get past the rate limits and the daily caps, or when the caps start to stop real users.

1. Create a Turnstile widget for the app's hostname in the Cloudflare dashboard.
2. Store its secret: `wrangler secret put TURNSTILE_SECRET` (in `packages/relay`).
3. In `packages/relay/wrangler.jsonc`, set `TURNSTILE_SITE_KEY` to the widget's site key and `TURNSTILE_MODE` to `on`. Deploy.

Set all three together. With `on` and no site key, the app shows no widget and every login is refused without a word. With `on` and no secret, every login is refused and the log says `relay: turnstile-misconfigured`.

## Static assets and edge caching

The Worker serves `packages/web/dist` with Workers Static Assets (`packages/relay/wrangler.jsonc`).

- `not_found_handling` is `"none"`. The web app uses `#request=`, `#relay=`, and `#session=` hash fragments on `/`, so `GET /` serves `index.html` and any missing path returns `404 Not Found` instead of falling back to `index.html`.
- Without an explicit `Cache-Control` rule in `packages/web/public/_headers`, Workers Static Assets sends `Cache-Control: public, max-age=0, must-revalidate`. On the `silv.app` Cloudflare zone, the zone-level `http_request_cache_settings` ruleset caches `public` responses at the edge (`cf-cache-status: HIT`), which kept unhashed files stale for minutes after a deploy (issue #20).
- `packages/web/public/_headers` sets `Cache-Control: no-cache, no-store, must-revalidate` on `/`, `/index.html`, `/*.md`, `/*.txt`, `/*.json`, `/*.pdf`, and `/*.webmanifest` so Cloudflare never stores them at the edge. Hashed bundles under `/assets/*`, `/*.worker.*.js`, and `/fonts/*` stay `public, max-age=31536000, immutable`.
- `.github/workflows/deploy.yml` verifies after every deploy that `/demo-request.json` and `/skill.md` match the built files and that a missing path returns `404`.

## Local development

`pnpm --filter @sign-pdf/relay dev` runs `wrangler dev` with `RELAY_MODE=on`, `TURNSTILE_MODE=off`, `MAIL_TRANSPORT=dev-outbox` and a dev-only session secret. Mail goes to the local R2 emulator; read it at `GET /relay/dev/outbox`. The default origin is `http://127.0.0.1:8787`; on another port, pass `--port <port> --var PUBLIC_ORIGIN:http://127.0.0.1:<port>` so emailed links point at the local server. A bare `wrangler dev` uses the production vars, so every relay path answers 404 until you pass `--var RELAY_MODE:on`.

End to end: `packages/web/e2e/relay-worker.spec.ts` runs the whole loop (A emails, B signs, A collects, the final is gone) against a running Worker. Build the web app (`pnpm --filter @sign-pdf/web build`), start the Worker as above, then run `RELAY_E2E_URL=http://127.0.0.1:<port> pnpm --filter @sign-pdf/web exec playwright test -c playwright.relay.config.ts`. The `relay-e2e` CI job does the same.

Tests: `pnpm --filter @sign-pdf/relay test` runs the Worker in workerd with `@cloudflare/vitest-plugin` (emulated R2, rate limits and mail).
