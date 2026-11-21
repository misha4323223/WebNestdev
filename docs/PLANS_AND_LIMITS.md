# Plans, limits and usage

Paid plans are sold through Robokassa (`docs/ROBOKASSA.md`). The plan an account actually has is
read from the paid subscription by `accountPlanFor` (`server/src/billing/store.ts`); the catalog in
`server/src/account/plans.ts` describes what each plan gives. The catalog sells only what the
platform really does — projects, model credits, storage, databases, integrations — and never promises
publishing or team roles, because those features do not exist.

## Plans

| | Старт (free) | Плюс (pro, 1 500 ₽/mo, сейчас 990 ₽) | Премиум (team, 2 500 ₽/mo, сейчас 2 000 ₽) |
|---|---|---|---|
| Projects | 3 | 6 | 9 |
| Agent credits per agent/month | — (weekly run limit) | 5 000 | 10 000 |
| Agent runs/week | 10 | no limit | no limit |
| Web searches/day | 25 | 200 | 500 |
| Generated images/day | 5 | 20 | 20 |
| HTTP functions per site | — | 5 | 25 |
| Storage | 500 MB | 2 GB | 10 GB |
| Built-in PostgreSQL database | — | 128 MB | 1 GB |
| Repository import | up to 50 MB | up to 600 MB | up to 1 GB |
| Integrations | one cloud, one registrar, databases and S3 | no limit | no limit |
| Static hosting | yes | yes | yes |
| Serverless functions | no | yes | yes |
| Background jobs | no | no | yes |
| Interactive terminal | no | no | yes |
| Container / hybrid preview | no | no | yes |

Paid plan prices are base prices before the current promo discount: the catalog defaults are 34%
for «Плюс» (1 500 ₽ → 990 ₽) and 20% for «Премиум» (2 500 ₽ → 2 000 ₽). The server applies the
discount to the showcase, invoice and receipt; the admin section «Тарифы и скидки» can override
both the base price and the percentage.

Storage is one quota per account, shared by every project, not a per-project allowance. The
per-plan number is the ceiling the whole account can use; `node_modules` and build output count.
The built-in database is a separate PostgreSQL schema per account. Its quota is the data size of
that schema; the connection URL lives in the project's encrypted secrets. The account overview in
settings shows used and free space next to storage, and the «База данных» tab manages the project
connection.

The tier capabilities are a separate matrix in `server/src/account/entitlements.ts`, not a
rewording of `features`. Static hosting is open on every plan. Serverless functions start on
«Плюс». Background jobs, the interactive terminal and container/hybrid preview start on «Премиум».
Production hosting accepts static files and short-lived serverless functions only; a container runs
for development preview and is not a production hosting target.
Background jobs are declared in the `jobs` array of `nestdev.functions.json`, enqueued from an HTTP
function response and run after it in the same isolated executor (60 seconds, 512 MB maximum).
They are not a permanent worker: video, OCR and long-running polling still need a separate service.
The contract and limits are in [BACKGROUND_JOBS.md](BACKGROUND_JOBS.md). The terminal in
this matrix is the panel's own terminal (`POST /api/projects/:id/terminal`); the agent's internal
`terminal.exec`/`terminal.start` and package installs are build tools and stay available on «Плюс»,
otherwise the agent could not build or verify a static site or a function. Those tools refuse a
build/start command for a project whose deployment profile is a permanent server on a plan without
container preview: otherwise «Плюс» would spend a build on something it cannot run. Tests, linters,
installs and static builds are not refused. Static preview remains available on every plan; a
container is never started for an account that is not allowed one. The API checks the
same rule as the UI and returns HTTP 403 `PLAN_FEATURE_REQUIRED` with `feature` and `requiredPlan`.
The architecture and phased serverless plan are in [PLAN_TIERS_SERVERLESS.md](PLAN_TIERS_SERVERLESS.md).

On the free plan `server/src/account/connector-access.ts` is the single policy for connectors:
repositories (GitHub, GitLab, GitVerse, SourceCraft), databases and S3 services are open; clouds,
domain registrars, Yandex Cloud and every other service are closed in both the integration routes
and the agent tools. Connections made on a paid plan are kept, not deleted, and simply unavailable
while the account is on «Старт».
The free plan's 500 MB is stored as 524,288,000 bytes (500 MiB) so the UI, which divides by 1024,
shows exactly «500 МБ».

Browser checks are not a plan quota. «Браузерная проверка» is a switch in the «Режимы» menu,
off by default; when it is off, `browser.runtime`, `browser.scenario`, `browser.screenshot` and the
automatic Chromium QA are skipped. When it is on, the checks are counted for analytics but have no
daily cap: the run's step limit and the model credits are the limit. The plan cards and the billing
screens therefore mention neither browser checks nor support.

## The monthly credit pool

The credit pool is the main limit of a paid plan. A credit is a unit of **model cost**, not a fixed
number of tokens: the same work on Max can cost more credits than on NestDev, and Mini can cost less.
The balance is counted from what the model actually reported — `model_usage` rows written by
`recordRunUsage` — not from button presses, so the number on the subscription page and the number the
check uses cannot drift apart. Only runs on the **built-in platform model** are written there:
`agent-runtime.ts` skips the journal when the project has its own provider, so a user's key never
consumes platform credits (the same rows feed the cost estimate, which is platform spend for the same
reason).

Rates live in `server/src/account/credits.ts`. The base model starts at 50 credits per 1M input and
510 per 1M output, with a minimum of 1 credit per run: at a typical 90/10 mix this is about 10 000
tokens per credit and 5 000 credits ≈ 50M tokens. Max starts at 250 / 2 550 with a 2-credit minimum,
Mini at 25 / 255 with a 1-credit minimum. The main model can be tuned with
`PLATFORM_AI_CREDITS_INPUT_PER_MILLION`, `PLATFORM_AI_CREDITS_OUTPUT_PER_MILLION` and
`PLATFORM_AI_CREDITS_MINIMUM_PER_RUN`, or through `POST /api/admin/ai` (the saved value wins over
environment); catalog models store `creditRates` and are edited through `/api/admin/ai/models`.

```text
credits = ceil(
  prompt_tokens / 1 000 000 × input_per_million
  + completion_tokens / 1 000 000 × output_per_million
)
credits = max(credits, minimum_per_run)
```

- `getCreditBudget(userId, plan)` sums the stored `credits` for the current UTC calendar month and
  returns `{ month, used, planLimit, limit, bonus, purchased, remaining }`. Rows written before
  credit accounting are estimated at 10 000 tokens = 1 credit; rows of the free `free-model` are not
  converted.
- Plan budgets are `limits.agentCreditsPerMonth`: 5 000 on Pro, 10 000 on Team. `limit: 0` means
  “this plan has no credit pool”: the free plan counts weekly runs instead, and the UI draws no credit
  bar for it.
- `consumeAgentRun` checks the credit pool for a paid plan before counting the run and throws
  `CreditBudgetError` (`code: "CREDIT_BUDGET_EXHAUSTED"`, HTTP 429) when it is used up. The agent
  panel turns that into «Кредиты исчерпаны» with the reset date instead of the weekly-quota text, and
  does not offer «Продолжить».
- The monthly pool does not roll over: unused plan credits are not carried into the next month.
  Purchased credits are different — they have their own ledger and do not expire; see below.
- On a paid plan, a project with its own AI provider spends the user's key and the user's tokens,
  so those runs neither count nor are blocked — neither by credits nor by the weekly run limit.
  `routes/agent-ws.ts` checks the plan and passes the answer to `consumeAgentRun`; the free plan
  always uses the built-in model and its weekly limit, even if an old provider is still stored.
- Administrator token grants still work for compatibility: 10 000 granted tokens become 1 credit in
  `getCreditBudget`. The admin route also returns the new `credits` budget next to the legacy token
  budget.

`GET /api/billing` returns `credits` next to `usage` and `storage`; the subscription page shows the
plan meter with the reset note, and the plan comparison table lists credits per plan. `tokens`
remains in the payload only as raw model-usage analytics for the owner/admin screens.

## Purchased credits

Paid accounts can buy any amount of credits from 1 000 without changing their subscription.
The owner sets one rate per 1 000 credits (290 ₽ by default) plus the minimum and maximum amount
through `POST /api/admin/billing/credits`; the browser sends only the number of credits.
`POST /api/billing/credits/checkout` calculates the amount on the server, creates a separate
Robokassa invoice and `POST /api/billing/robokassa/result` credits the account after the signed
payment notification.

| Credits | Price at the default 290 ₽ / 1 000 |
|---:|---:|
| 1 000 | 290 ₽ |
| 5 000 | 1 450 ₽ |
| 15 000 | 4 350 ₽ |

Amounts are whole rubles, rounded up: `ceil(credits × pricePer1000 / 1000)`. Legacy `packId`
requests still work, but their price is calculated from the same current rate instead of a frozen
catalogue price. Already issued invoices keep their amount.

Purchased credits are stored in the append-only `credit_ledger`, not in the monthly `model_usage`
sum. `recordRunUsage` writes a negative ledger entry only for the part of a run that exceeded the
plan's monthly limit, keyed by `run_id`, so a repeated run cannot debit twice. Purchased credits do
not expire, are spent after the monthly plan credits, and become available again after a downgrade
if the account returns to a paid plan. The account balance is never allowed to go below zero.

`GET /api/billing` returns the top-up settings in `creditTopUp`, legacy presets in `creditPacks`
and the account's invoices in `creditPurchases`; both the subscription page and settings expose the
top-up block. The UI labels `planLimit` as the monthly allowance and `purchased` as the non-expiring
balance.

## Integration limits

`integrationLimitFor(plan, kind)` limits `cloud`, `domains` and `services` connections on the free
plan (1 / 1 / 3). `assertIntegrationSlot` (`server/src/account/integration-limits.ts`) is called by
`POST /api/cloud/:provider`, `POST /api/domains/:provider` and `POST /api/services/:service`
**before** the credential is verified, so a reached limit is reported as the reason and no pointless
request is sent to the provider. The answer is `403` with `code: "PLAN_LIMIT_REACHED"` and a sentence
naming the plan and the limit.

Only a new connection is checked: re-saving the same provider replaces a slot (`replacing: true`),
and connections that already exist keep working after a downgrade — nobody loses their cloud because
a subscription ended.

## Host resource limits (5.2)

Plans also bound what one account can take from the single VM, independently of token credits:

| | Старт (free) | Плюс (pro) | Премиум (team) |
|---|---|---|---|
| Sandbox container minutes per UTC day | 120 | 600 | 1 800 |
| Concurrent sandbox containers per account | 1 | 1 | 1 |

Sandbox minutes are the wall-clock life of command containers (agent `terminal.exec`, package installs,
builds, preview builds), stored per user/day as `sandboxSeconds` in `usage_counters`. A container is
charged at least one second. When the budget is used up, the next command fails with HTTP 429
`SANDBOX_QUOTA_EXCEEDED` and a message naming the used minutes, the reset time (00:00 UTC) and support.
Concurrent containers are **one per account on every plan**: the agent runs one at a time anyway, so a
parallel build only takes a host slot without speeding anything up. The per-account queue is separate
from the host ceiling `SANDBOX_MAX_CONCURRENT`: a second container of the same account waits without
taking a host place, so another account is not slowed down. `SANDBOX_MAX_PER_USER` overrides the number
(`0` disables the per-account queue).

There is **no permanent per-IP account cap**. IP is a network, not a person: a permanent cap would
block CGNAT, offices and families, so a second account from the same address is allowed. The short
rate-limit window in `auth-rate-limit.ts` still throttles bursts, but it never decides whether an
account may exist. For the window, IPv6 addresses are collapsed to their `/64`: one subscriber cannot
rotate addresses inside the prefix for fresh attempts. CGNAT addresses get no IP bucket at all, because
one bucket would punish unrelated customers behind the same carrier NAT; the account/email buckets
remain.

Project creation is not limited per IP address: the plan's project count is per account, and a
shared address (CGNAT, office, family) must not stop a legitimate project. Weekly runs are the
anti-farm limit.

A container of one project above `ABUSE_CPU_PERCENT` (95% by default) for `ABUSE_SUSTAINED_MS`
(45 minutes) blocks its account with the reason «контейнер проекта … держал загрузку CPU» and an audit
entry `security.abuse.blocked`; the containers are stopped. The threshold is deliberately above the
longest build/install timeout (30 minutes), so a legitimate cold install cannot trip it. Containers
labelled `webnestdev.load=command` (one-off commands and builds) are not counted; `preview`, `job` and
unknown workloads are. `ABUSE_WATCH=0` disables the watchdog.

## Enforcement and usage

- Project creation checks the authenticated user's current plan and project count.
- Agent runs consume one weekly unit at the authenticated WebSocket run boundary on the free plan;
  the week is the UTC calendar week starting Monday 00:00. Paid plans have no weekly run cap and
  check the monthly credit pool instead. The daily counter is still recorded for history and
  analytics, but `agentRunsPerDay: null` and `agentRunsPerWeek: null` mean it does not block.
- `browser.runtime`, `browser.scenario` and `browser.screenshot` are available only while the
  «Браузерная проверка» switch is on for the run; the switch is off by default. An off run skips
  both explicit Chromium tools and automatic browser QA. The usage counter remains for analytics,
  but there is no daily plan cap: credits and the agent step limit bound the work.
- The plan catalog and saved `PLAN_SETTINGS` no longer promise daily browser checks, daily paid runs
  or support. The saved plan features are migrated on read, so a deploy does not bring the old
  wording back.
- `GET /api/billing` returns the plan catalog, the limits of the account's plan, today's usage,
  the current UTC week and weekly agent-run counter, the monthly credit pool, the account's storage
  usage and the model cost snapshot. The settings screen shows usage, the per-project storage
  breakdown and the 80%/100% state.
- Storage sizes are reconciled after startup and once a day (one replica at a time), and the account
  can refresh them from settings. The schedule, thresholds and known gaps are in [STORAGE.md](STORAGE.md).
- Usage is stored as append-only daily events plus per-user/day/kind counters in YDB. The free
  agent-run limit also keeps a per-user/week counter (`agentRunsWeek`) in the same table, so the
  Monday reset needs no cleanup job. Counter updates and usage-event inserts are committed in one
  serializable read-write transaction; retryable transaction conflicts are retried by the YDB query
  SDK. JSON mode derives the week from daily events.
- YDB project creation reserves a per-user project counter and inserts the project in one
  serializable transaction. Existing projects are counted when the per-user counter is first
  initialized.
- JSON mode serializes quota writes and project creation only within one server process. Do not use
  JSON storage on multiple replicas or shared deployments; use YDB for multi-instance operation.
- The code and CI builds are covered by unit tests, but a live YDB integration/load test still needs
  to run against an actual configured YDB database before calling multi-replica quota enforcement
  production-verified.

## Choosing a price from measured cost

`GET /api/admin/stats/costs` and `/api/admin/stats/economics` (`docs/ADMIN_API.md`, разделы 7.2–7.4)
turn `model_usage` and paid invoices into actual cost, revenue, margin and a suggested price per plan.
The suggestion includes the model cost of the plan, a share of fixed infrastructure
(`PLATFORM_INFRA_COST_PER_MONTH`) and the cost of the free plan divided between paying subscribers,
then rounds up to 10 ₽ at the target margin (default 70 %). Model rates come from
`PLATFORM_AI_MODEL_PRICES` (fallback: `PLATFORM_AI_PRICE_*`); the current plan price is read from the
live `ROBOKASSA_PRICE_*` setting, so MRR matches what the shop actually charges.

## API

- `GET /api/account/settings`, `PUT /api/account/settings`
- `GET /api/billing`
- `POST /api/billing/checkout`, `POST /api/billing/subscription`, `POST /api/billing/robokassa/result`

All account/billing endpoints require authentication. Limits are checked on the server; client UI
values are informational only.
