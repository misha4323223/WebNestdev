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

The sign-in screen offers **Yandex ID** (see below) and **sign-in by phone number**,
which sends a one-time code by SMS. The e-mail/password endpoints still exist for API
clients, but the screen is built around these two passwordless methods. Only Russian
numbers are accepted (`8XXXXXXXXXX`, `7XXXXXXXXXX` and the bare 10 digits all normalise
to `+7XXXXXXXXXX`); anything else is rejected before a code exists.

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
| **Yandex Cloud Notification Service** | `YANDEX_SA_KEY`/`YANDEX_SA_KEY_FILE` (preferred) **or** `YANDEX_NOTIFY_IAM_TOKEN`, plus `YANDEX_CLOUD_ID` | Keeps everything inside Yandex Cloud; SNS-compatible API. Constraints below |
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
| `YANDEX_NOTIFY_IAM_TOKEN` | A ready IAM token — simplest to paste and **expires in about 12 hours**. Prefer the key: the key is used even when a stale token is still set, and an expired token is now reported as exactly that, with the fix, instead of a generic refusal |
| `YANDEX_SA_KEY` | Service account authorized key JSON (whole file contents) |
| `YANDEX_SA_KEY_FILE` | Path to the authorized key JSON instead of inlining it |
| `YANDEX_CLOUD_ID` | Cloud id — CNS needs it as `Account` when authenticating with an IAM token |
| `YANDEX_FOLDER_ID` | Folder id (needed to create the SMS channel in the console) |
| `YANDEX_SMS_SENDER` | Text sender name; required only for an individual sender channel |
| `YANDEX_NOTIFY_ENDPOINT` | Override the endpoint (default `https://notifications.yandexcloud.net/`) |

The service account needs the `editor` role on the folder (the documented minimum). Put the
key file under `/var/lib/webnestdev/secrets` — `docker-compose.yml` mounts that directory
into the container read-only, so `YANDEX_SA_KEY_FILE` can point at the file instead of the
whole JSON being squeezed into one `.env` line. All the provider variables are listed in
the compose file: Compose forwards only what is named there, and a key that stays in `.env`
alone never reaches the server.

What is actually configured is visible without a shell: `GET /api/auth/phone/status`
returns the provider, `testMode` and `credentialKind` (`key` or `token`), and
`GET /api/health` → `sms` repeats it for the operator. Failed sends are logged with the
provider's own message, and the sign-in screen shows the same explanation to the person
waiting for the code.

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

The phone form sits on the sign-in screen next to Yandex ID, and a **demo number** lets the
phone flow be used before an SMS provider exists. It defaults to `+7 999 000-00-00` and is let straight in — no code, no
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

## Yandex ID sign-in

The sign-in screen now offers **«Войти через Яндекс ID»** next to the phone-code form.
It is a separate OAuth flow on the server (`/api/auth/yandex/start` and the shared
`/api/yandex/callback`), and it creates or opens an ordinary WebNestdev account:

- The Yandex profile id is stored in `yandex_accounts` (PostgreSQL) or
  `auth/yandex-accounts.json` (local JSON). **The Yandex access token is never stored** —
  it is used once to read the profile and discarded.
- Every Yandex identity gets its own local account with a synthetic address
  (`yandex-…@yandex-id.webnestdev.local`). The Yandex `default_email` is stored with the
  identity and shown in the profile, but it **does not merge accounts**: e-mail/password
  registration never verifies the address, so linking by e-mail would let whoever
  pre-registered a victim's address take over the account when the victim signs in with
  Yandex. Explicit account linking (phone + Yandex) is a separate future flow.
- The callback path is the same `/api/yandex/callback` the Cloud connector already uses,
  so an existing Yandex app registration keeps working. The two flows are told apart by
  a short-lived `webnestdev_yandex_login` cookie: sign-in is public, the connector still
  requires a session and its own server-side state.
- No `scope` is sent for sign-in. Yandex then grants the permissions enabled in the app
  (at minimum **«Доступ к логину, имени и фамилии, полу» / `login:info`**). Adding
  `login:email` is what makes the real e-mail available.

Requires `YANDEX_CLIENT_ID` and `YANDEX_CLIENT_SECRET` (the same pair as the Cloud
connector). The redirect URI in the Yandex app must be exactly the callback shown by
`GET /api/auth/yandex/status` or the Yandex Cloud card.

### Yandex ID is not Yandex Cloud access

The same Yandex app is used for two different jobs, and they must not be confused:

| Goal | What it uses | What it gives |
| --- | --- | --- |
| Sign in to WebNestdev | Yandex ID OAuth (`login:info`, optional `login:email`) | Identity only: id, login, optional e-mail |
| Let the agent read the user's cloud | Service account authorized key, IAM token, or a pre-cutoff Cloud OAuth token stored by the Cloud connector | Yandex Cloud IAM roles and API access |

Since **1 June 2026 Yandex Cloud no longer accepts newly issued Yandex ID OAuth tokens**
for IAM exchange; tokens issued before that date keep working until they expire. A token
obtained just to sign a user into the site therefore cannot be reused as Cloud access.
The connector's `cloud_error` is exactly this case. For a user who needs their own Cloud
resources, use a service account key with explicit roles (the connector's main path), a
Cloud identity federation for an organisation, or a refresh token issued by the Cloud
OAuth flow. The sign-in button never silently turns into cloud access.

### Why not VK ID / Госуслуги

These are identity providers, not SMS gateways, and they change what the user has to do:

- **VK ID** — free OAuth/SDK, supports phone-login inside the VK flow, but the user must
  log in *through VK*, not by typing a code we send. Good as an extra button, not as a
  standalone phone-code login.
- **ЕСИА / Госуслуги** — available only to government bodies and registered organisations
  with an agreement, not to ordinary developers, so it is not an option here.
- **Telegram / MAX / Sber ID** — usable as additional identity buttons, subject to the
  same "login through their flow" caveat.

Yandex ID is now implemented as such an additional button; the SMS-code login stays the
passwordless phone option.

## Phase 5 — Security hardening
- CSRF protection where required by the final cookie architecture.
- Rate limiting for registration/login.
- Password reset and email verification.
- Session revocation and rotation.
- Audit logging and abuse controls.

## Current milestone

Phase 1 is implemented locally, plus passwordless **phone login for Russian numbers**
and **Yandex ID sign-in** (see above). Both open the same kind of local user: a Yandex
sign-in needs no SMS, and a phone sign-in needs no Yandex app. This is independent of
Yandex Cloud access — see the table above. Phone login runs in test mode until one of
the SMS provider blocks is filled in; Yandex ID needs only `YANDEX_CLIENT_ID` and
`YANDEX_CLIENT_SECRET`; the e-mail/password flow needs no external service.

Phone login is covered by tests:

- `server/src/auth/phone-store.test.ts` — number normalisation, code hashing, cooldown,
  window limit, single-use and expiry.
- `server/src/routes/phone-auth.test.ts` — the full HTTP flow through Fastify `inject`:
  test-mode status, code issue, wrong-code rejection, session cookie, account reuse and
  rejection of non-Russian numbers.
- `server/src/auth/yandex-notify.test.ts` — provider selection, the SNS-compatible
  `Publish` request (endpoint, bearer token, `Account`, SMS attributes), and the
  readable errors for sandbox/region/authorization failures.
- `server/src/auth/yandex-account-store.test.ts` — one Yandex identity maps to one local
  user, a Yandex e-mail never merges into a pre-registered local account, and a profile
  without e-mail still gets a readable synthetic address.
- `server/src/routes/yandex-auth.test.ts` — the public start redirect, the state cookie,
  the mocked token/profile exchange, the session cookie, `state_expired`, and the
  `not_configured` return.
