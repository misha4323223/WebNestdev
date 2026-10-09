# Demo subscriptions and quota enforcement

Billing remains demo-only: there is no payment provider, card collection, charge, invoice, or webhook integration.

## Demo plans
- Free: 3 projects, 10 agent runs/day, 5 browser checks/day.
- Pro demo: 15 projects, 100 agent runs/day, 50 browser checks/day.
- Team demo: 50 projects, 500 agent runs/day, 250 browser checks/day.

## Enforcement and usage
- Project creation checks the authenticated user's current plan and project count.
- Agent runs consume one daily unit at the authenticated WebSocket run boundary.
- `browser.runtime` and `browser.scenario` consume one daily browser-check unit each, including checks invoked automatically after agent changes.
- `GET /api/billing` returns the current plan limits and UTC-day usage counters. The settings screen shows usage.
- Usage is stored as append-only daily events plus per-user/day/kind counters in YDB. Counter updates and usage-event inserts are committed in one serializable read-write transaction; retryable transaction conflicts are retried by the YDB query SDK.
- YDB project creation reserves a per-user project counter and inserts the project in one serializable transaction. Existing projects are counted when the per-user counter is first initialized.
- JSON mode serializes quota writes and project creation only within one server process. Do not use JSON storage on multiple replicas or shared deployments; use YDB for multi-instance operation.
- The code and CI builds are covered by unit tests, but a live YDB integration/load test still needs to run against an actual configured YDB database before calling multi-replica quota enforcement production-verified.

## API
- `GET /api/account/settings`, `PUT /api/account/settings`
- `GET /api/billing`
- `POST /api/billing/demo/activate` with `{ "plan": "pro" | "team" }`
- `POST /api/billing/demo/cancel`

All account/billing endpoints require authentication. Limits are checked on the server; client UI values are informational only. Payment integration is explicitly out of scope until quota enforcement and storage semantics are production-safe.
