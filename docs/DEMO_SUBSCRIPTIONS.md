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
- Usage is stored as append-only daily events in JSON mode and in the `usage_events` YDB table in YDB mode.
- JSON-mode writes are serialized within one server process. YDB usage writes are serialized per user within one process; project-count checks and this demo's quota reservations are not yet atomic across multiple requests or server replicas, so simultaneous requests can overshoot a limit. Before production or multi-replica deployment, enforce project creation and usage consumption with database transactions/atomic conditional updates and add integration tests against YDB.

## API
- `GET /api/account/settings`, `PUT /api/account/settings`
- `GET /api/billing`
- `POST /api/billing/demo/activate` with `{ "plan": "pro" | "team" }`
- `POST /api/billing/demo/cancel`

All account/billing endpoints require authentication. Limits are checked on the server; client UI values are informational only. Payment integration is explicitly out of scope until quota enforcement and storage semantics are production-safe.
