# Plans, limits and usage

Paid plans are sold through Robokassa (`docs/ROBOKASSA.md`). The plan an account actually has is
read from the paid subscription by `accountPlanFor` (`server/src/billing/store.ts`); the catalog in
`server/src/account/plans.ts` describes what each plan gives. The catalog sells only what the
platform really does — projects, model tokens, storage, integrations — and never promises
publishing or team roles, because those features do not exist.

## Plans

| | Старт (free) | Плюс (pro, 990 ₽/mo) | Премиум (team, 2 990 ₽/mo) |
|---|---|---|---|
| Projects | 3 | 15 | 50 |
| Model tokens per month | — (daily run limit) | 50 млн | 250 млн |
| Agent runs/day | 10 | 100 | 500 |
| Browser checks/day | 5 | 50 | 250 |
| Web searches/day | 25 | 200 | 500 |
| Storage | 700 MB | 10 GB | 50 GB |
| Repository import | up to 100 MB | no limit | no limit |
| Integrations | 1 cloud, 1 registrar, 3 services | no limit | no limit |

Storage is one quota per account, shared by every project, not a per-project allowance. The
per-plan number is the ceiling the whole account can use; `node_modules` and build output count.
The free plan's 700 MB is stored as 734,003,200 bytes (700 MiB) so the UI, which divides by 1024,
shows exactly «700 МБ».

## The monthly token pool

The pool is the main limit of a paid plan. It is counted from what the model actually reported —
`model_usage` rows written by `recordRunUsage` — not from button presses, so the number on the
subscription page and the number the check uses cannot drift apart. Only runs on the **built-in
platform model** are written there: `agent-runtime.ts` skips the journal when the project has its
own provider, so a user's key never consumes the platform pool (the same rows feed the cost
estimate, which is platform spend for the same reason).

- `getTokenBudget(userId, plan)` sums `prompt_tokens + completion_tokens` of the current UTC
  calendar month and returns `{ month, used, limit, remaining }`.
- `limit: 0` means “this plan has no pool”: the free plan counts daily runs instead, and the UI
  draws no token bar for it.
- `consumeAgentRun` checks the pool for a paid plan before counting the run and throws
  `TokenBudgetError` (`code: "TOKEN_BUDGET_EXHAUSTED"`, HTTP 429) when it is used up. The agent
  panel turns that into «Пул токенов исчерпан» with the reset date instead of the daily-quota text,
  and does not offer «Продолжить».
- The pool does not roll over: unused tokens are not carried into the next month.
- A project with its own AI provider spends the user's key and the user's tokens, so those runs
  neither count nor are blocked — neither by the pool nor by the daily run limit. `routes/agent-ws.ts`
  asks once whether the project has its own provider and passes the answer to `consumeAgentRun`.
- The number is a calibration constant (`limits.agentTokensPerMonth` in the catalog), not a stored
  entitlement: changing it after a few weeks of `model_usage` needs no data migration.

`GET /api/billing` returns `tokens` next to `usage` and `storage`; the subscription page shows it as
a monthly meter with the reset note, and the plan comparison table lists the pool per plan.

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
- Agent runs consume one daily unit at the authenticated WebSocket run boundary; paid plans check the
  monthly token pool first.
- `browser.runtime`, `browser.scenario` and `browser.screenshot` consume one daily browser-check unit
  each, including checks invoked automatically after agent changes.
- `GET /api/billing` returns the plan catalog, the limits of the account's plan, the UTC-day usage
  counters, the monthly token pool, the account's storage usage and the model cost snapshot. The
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

## API

- `GET /api/account/settings`, `PUT /api/account/settings`
- `GET /api/billing`
- `POST /api/billing/checkout`, `POST /api/billing/subscription`, `POST /api/billing/robokassa/result`

All account/billing endpoints require authentication. Limits are checked on the server; client UI
values are informational only.
