# WebNestDev account and production-readiness plan

## Phase 1 — Local production-like accounts
- Real email/password registration.
- Passwords stored as salted scrypt hashes, never plaintext.
- HTTP-only session cookie with a 30-day local session.
- Login, logout and current-session checks.
- Workspace is inaccessible until authenticated.
- Projects and conversations are owned by the authenticated user.
- Local data stays under `.webnestdev`.

## Phase 2 — User-scoped integrations
- Store GitHub OAuth credentials per WebNestDev user.
- Bind GitHub OAuth state to the authenticated session.
- Import repositories into that user's projects.
- Prevent cross-user access to repositories, projects and conversations.

## Phase 3 — Production storage
- Move users/sessions/projects/conversations from local JSON storage to a managed database.
- Move secrets to managed secret storage.
- Keep the application-level auth interfaces stable so the UI does not need a second authentication flow.

## Phase 4 — Cloud deployment
- Containerize the WebNestDev application.
- Separate the WebNestDev service from Preview/Sandbox worker containers.
- Put production routing for frontend, `/api` and `/ws` at the infrastructure layer.
- Configure Yandex Cloud environment variables and domains.

## Phone login (Russian numbers)

The sign-in screen offers three methods: e-mail + password, e-mail registration, and
**sign-in by phone number**, which sends a one-time code by SMS. Only Russian numbers
are accepted (`8XXXXXXXXXX`, `7XXXXXXXXXX` and the bare 10 digits all normalise to
`+7XXXXXXXXXX`); anything else is rejected before a code exists.

Internally a phone account is a normal user record: the number maps to a synthetic
e-mail (`79991234567@phone.webnestdev.local`) and a random password nobody knows, so
the SMS code is the only way in. The mapping lives in the `phone_accounts` table (YDB)
or `phones.json` (local JSON). Codes themselves are short-lived, in-memory, hashed
values with a 5-minute TTL, a 45-second resend cooldown and a bounded number of sends
per 15-minute window, so the endpoint cannot be used as an SMS bomb.

### Which Russian SMS providers are supported

Set **one** of these blocks in the environment and real messages are sent; the first
provider whose credentials are present wins (Yandex Cloud is checked first), or force
one with `SMS_PROVIDER`:

| Provider | Variables | Notes |
| --- | --- | --- |
| **Yandex Cloud Notification Service** | `YANDEX_NOTIFY_IAM_TOKEN` **or** `YANDEX_SA_KEY`/`YANDEX_SA_KEY_FILE`, plus `YANDEX_CLOUD_ID` | Keeps everything inside Yandex Cloud; SNS-compatible API. Constraints below |
| SMS.RU | `SMS_RU_API_ID` | Per-SMS pricing; has a test mode (`test=1`) |
| SMSC.ru | `SMSC_LOGIN`, `SMSC_PASSWORD` | Per-SMS pricing, well-known in RU |
| МТС Exolve | `EXOLVE_API_KEY` | Per-SMS pricing, MTS infrastructure |
| SMS Aero | `SMSAERO_EMAIL`, `SMSAERO_API_KEY` | Per-SMS pricing, small free trial |

`SMS_SENDER` (or `YANDEX_SMS_SENDER`) is the registered sender name (empty = provider
default). None of these gateways is free for volume: every one charges per message, and
Russian operators require a registered sender name for transactional SMS. There is no
free Russian SMS gateway for production traffic.

### Yandex Cloud Notification Service (the Yandex path)

`server/src/auth/yandex-notify.ts` talks to CNS over its Amazon SNS-compatible HTTP API:
a form-urlencoded `POST https://notifications.yandexcloud.net/` with `Action=Publish`
and `Authorization: Bearer <IAM-токен>`. The IAM token is either supplied directly or
minted from a service account authorized key — the same PS256 JWT exchange the Yandex
integration card uses (`server/src/yandex/yandex-api.ts`), reused instead of duplicated.

Environment:

| Variable | Meaning |
| --- | --- |
| `YANDEX_NOTIFY_IAM_TOKEN` | A ready IAM token (simplest; expires, so prefer the key in production) |
| `YANDEX_SA_KEY` | Service account authorized key JSON (whole file contents) |
| `YANDEX_SA_KEY_FILE` | Path to the authorized key JSON instead of inlining it |
| `YANDEX_CLOUD_ID` | Cloud id — CNS needs it as `Account` when authenticating with an IAM token |
| `YANDEX_FOLDER_ID` | Folder id (needed to create the SMS channel in the console) |
| `YANDEX_SMS_SENDER` | Text sender name; required only for an individual sender channel |
| `YANDEX_NOTIFY_ENDPOINT` | Override the endpoint (default `https://notifications.yandexcloud.net/`) |

The service account needs the `editor` role on the folder (the documented minimum).

**Two constraints come from CNS itself, and both are surfaced as readable errors rather
than generic failures:**

- SMS is delivered **only to Russian numbers** in E.164 format (`InvalidPhoneNumberRegion`).
- With the **common sender** (`cns.shared`) the channel is in the **sandbox**, where only
  **verified test numbers** receive messages (`SMSSandboxNumberNotVerified`). To reach
  arbitrary numbers you must register an **individual sender** — legal entities or ИП
  only, requested via support, roughly 10 166 ₽/month — and then **exit the sandbox** from
  the console. That registration takes time (and SMS templates take 2–4 weeks), so plan it
  before launch; until then the phone login works end-to-end against sandbox numbers.

`Transactional` is sent as the SMS type, which is the correct type for a one-time code
once a matching template is registered; without a template the message bills as
promotional.

### Demo number (sign-in without SMS)

The sign-in screen is phone-only, and a **demo number** lets the flow be used before an SMS
provider exists. It defaults to `+7 999 000-00-00` and is let straight in — no code, no
SMS, an ordinary session. It follows the same convention as the demo e-mail account:
enabled outside production, opt-in in production via `WEBNESTDEV_DEMO_PHONE_ENABLED=1`,
and off with `WEBNESTDEV_DEMO_PHONE_ENABLED=0`. The number is configurable with
`WEBNESTDEV_DEMO_PHONE`. It is rate limited like the rest of the flow, just generously.
The sign-in screen shows no provider or demo notes — the number is entered like any
other; `GET /api/auth/phone/status` still reports it for API clients.

### Test mode

With no provider credentials (or `WEBNESTDEV_SMS_TEST_MODE=1`) the server sends
nothing. The code is written to the server log and, outside production, returned in
the API response as `devCode`, so the whole flow can be tested before the SMS account
exists. `GET /api/auth/phone/status` reports the active provider and whether the server
is in test mode.

### Why not VK ID / Yandex ID / Госуслуги

These are identity providers, not SMS gateways, and they change what the user has to do:

- **VK ID** — free OAuth/SDK, supports phone-login inside the VK flow, but the user must
  log in *through VK*, not by typing a code we send. Good as an extra button, not as a
  standalone phone-code login.
- **Yandex ID** — same story: a free OAuth app, but the phone verification is Yandex's.
- **ЕСИА / Госуслуги** — available only to government bodies and registered organisations
  with an agreement, not to ordinary developers, so it is not an option here.
- **Telegram / MAX / Sber ID** — usable as additional identity buttons, subject to the
  same "login through their flow" caveat.

If one of those "login with VK/Yandex" buttons is wanted later it is an additive OAuth
flow; the current SMS-code login stays the passwordless phone option.

## Phase 5 — Security hardening
- CSRF protection where required by the final cookie architecture.
- Rate limiting for registration/login.
- Password reset and email verification.
- Session revocation and rotation.
- Audit logging and abuse controls.

## Current milestone

Phase 1 is implemented locally, plus passwordless **phone login for Russian numbers**
(see above). The flow is intentionally production-like at the user-flow level while
remaining independent of Yandex Cloud. Phone login runs in test mode until one of the
SMS provider blocks is filled in; the e-mail/password flow needs no external service.

Phone login is covered by tests:

- `server/src/auth/phone-store.test.ts` — number normalisation, code hashing, cooldown,
  window limit, single-use and expiry.
- `server/src/routes/phone-auth.test.ts` — the full HTTP flow through Fastify `inject`:
  test-mode status, code issue, wrong-code rejection, session cookie, account reuse and
  rejection of non-Russian numbers.
- `server/src/auth/yandex-notify.test.ts` — provider selection, the SNS-compatible
  `Publish` request (endpoint, bearer token, `Account`, SMS attributes), and the
  readable errors for sandbox/region/authorization failures.
