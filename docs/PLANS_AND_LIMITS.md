# Plans, limits and usage

Paid plans are sold through Robokassa (`docs/ROBOKASSA.md`). The plan an account actually has is
read from the paid subscription by `accountPlanFor` (`server/src/billing/store.ts`); the catalog in
`server/src/account/plans.ts` describes what each plan gives. The catalog sells only what the
platform really does — projects, model credits, storage, integrations — and never promises
publishing or team roles, because those features do not exist.

## Plans

| | Старт (free) | Плюс (pro, 1 500 ₽/mo, сейчас 990 ₽) | Премиум (team, 2 500 ₽/mo, сейчас 2 000 ₽) |
|---|---|---|---|
| Projects | 3 | 9 | 15 |
| Agent credits per agent/month | — (daily run limit) | 5 000 | 10 000 |
| Agent runs/day | 10 | no limit | no limit |
| Web searches/day | 25 | 200 | 500 |
| Storage | 500 MB | 10 GB | 50 GB |
| Repository import | up to 50 MB | no limit | no limit |
| Integrations | databases and S3 only | no limit | no limit |

Paid plan prices are base prices before the current promo discount: the catalog defaults are 34%
for «Плюс» (1 500 ₽ → 990 ₽) and 20% for «Премиум» (2 500 ₽ → 2 000 ₽). The server applies the
discount to the showcase, invoice and receipt; the admin section «Тарифы и скидки» can override
both the base price and the percentage.

Storage is one quota per account, shared by every project, not a per-project allowance. The
per-plan number is the ceiling the whole account can use; `node_modules` and build output count.

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
  “this plan has no credit pool”: the free plan counts daily runs instead, and the UI draws no credit
  bar for it.
- `consumeAgentRun` checks the credit pool for a paid plan before counting the run and throws
  `CreditBudgetError` (`code: "CREDIT_BUDGET_EXHAUSTED"`, HTTP 429) when it is used up. The agent
  panel turns that into «Кредиты исчерпаны» with the reset date instead of the daily-quota text, and
  does not offer «Продолжить».
- The monthly pool does not roll over: unused plan credits are not carried into the next month.
  Purchased credits are different — they have their own ledger and do not expire; see below.
- A project with its own AI provider spends the user's key and the user's tokens, so those runs
  neither count nor are blocked — neither by credits nor by the daily run limit. `routes/agent-ws.ts`
  asks once whether the project has its own provider and passes the answer to `consumeAgentRun`.
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

## Enforcement and usage

- Project creation checks the authenticated user's current plan and project count.
- Agent runs consume one daily unit at the authenticated WebSocket run boundary on the free plan;
  paid plans have no daily run cap and check the monthly credit pool instead. The run counter is
  still recorded for history and analytics, but `agentRunsPerDay: null` means it does not block.
- `browser.runtime`, `browser.scenario` and `browser.screenshot` are available only while the
  «Браузерная проверка» switch is on for the run; the switch is off by default. An off run skips
  both explicit Chromium tools and automatic browser QA. The usage counter remains for analytics,
  but there is no daily plan cap: credits and the agent step limit bound the work.
- The plan catalog and saved `PLAN_SETTINGS` no longer promise daily browser checks, daily paid runs
  or support. The saved plan features are migrated on read, so a deploy does not bring the old
  wording back.
- `GET /api/billing` returns the plan catalog, the limits of the account's plan, the UTC-day usage
  counters, the monthly credit pool, the account's storage usage and the model cost snapshot. The
  settings screen shows usage, the per-project storage breakdown and the 80%/100% state.
- Storage sizes are reconciled after startup and once a day (one replica at a time), and the account
  can refresh them from settings. The schedule, thresholds and known gaps are in [STORAGE.md](STORAGE.md).
- Usage is stored as append-only daily events plus per-user/day/kind counters in YDB. Counter updates
  and usage-event inserts are committed in one serializable read-write transaction; retryable
  transaction conflicts are retried by the YDB query SDK.
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
