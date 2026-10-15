# Plans, limits and usage

There is no payment provider yet: no card collection, charge, invoice or webhook integration.
Until one is connected, plans cannot be bought and the free plan is the only plan an account runs on.

## Plans
- Free — 3 projects, 10 agent runs/day, 5 browser checks/day, 1 GB storage. This is the plan every account uses.
- Pro — 15 projects, 100 agent runs/day, 50 browser checks/day, 10 GB storage.
- Team — 50 projects, 500 agent runs/day, 250 browser checks/day, 50 GB storage.

Pro and Team are described on the pricing screens with the price «Скоро». They are not purchasable:
the picker only records a wish.

- Choosing a plan writes it to the browser (`src/lib/plan-choice.ts`) and nothing else. The choice is
  shown in the top bar, on the home rail and in the settings, and it is what a future checkout would use.
- `FREE_PLAN` in `server/src/account/plans.ts` is the single place that names the plan accounts run on;
  limits, usage counters and the storage quota all read it.

## Enforcement and usage
- Project creation checks the authenticated user's current plan and project count.
- Agent runs consume one daily unit at the authenticated WebSocket run boundary.
- `browser.runtime` and `browser.scenario` consume one daily browser-check unit each, including checks invoked automatically after agent changes.
- `GET /api/billing` returns the plan catalog, the limits of the account's plan, the UTC-day usage counters, the account's storage usage and the model cost snapshot. The settings screen shows usage.
- Usage is stored as append-only daily events plus per-user/day/kind counters in YDB. Counter updates and usage-event inserts are committed in one serializable read-write transaction; retryable transaction conflicts are retried by the YDB query SDK.
- YDB project creation reserves a per-user project counter and inserts the project in one serializable transaction. Existing projects are counted when the per-user counter is first initialized.
- JSON mode serializes quota writes and project creation only within one server process. Do not use JSON storage on multiple replicas or shared deployments; use YDB for multi-instance operation.
- The code and CI builds are covered by unit tests, but a live YDB integration/load test still needs to run against an actual configured YDB database before calling multi-replica quota enforcement production-verified.

## API
- `GET /api/account/settings`, `PUT /api/account/settings`
- `GET /api/billing`

All account/billing endpoints require authentication. Limits are checked on the server; client UI values are informational only. Payment integration is explicitly out of scope until quota enforcement and storage semantics are production-safe — when it lands, the plan picker becomes the entry point to checkout.
