# Demo subscriptions

WebNestdev currently runs subscriptions in **demo-only mode**. This is not a payment integration.

## Demo plans

| Plan | Demo project limit | Agent runs/day | Browser checks/day |
| --- | ---: | ---: | ---: |
| Free | 3 | 10 | 5 |
| Pro | 15 | 100 | 50 |
| Team | 50 | 500 | 250 |

The current catalog exposes these values for product/UI development. End-to-end enforcement of agent and browser quotas is a separate implementation stage and must be completed before presenting the limits as production guarantees.

## Available API

All endpoints require an authenticated WebNestdev session:

- `GET /api/account/settings` — account profile and preferences.
- `PUT /api/account/settings` — persist preferences.
- `GET /api/billing` — current demo subscription and plan catalog.
- `POST /api/billing/demo/activate` with `{"plan":"pro"}` or `{"plan":"team"}` — activate a 30-day demo subscription.
- `POST /api/billing/demo/cancel` — cancel demo access and return to Free.

There are deliberately no checkout, payment-method, charge, invoice, or webhook routes. Activation changes only the subscription record. No card details are requested and no money is charged.

## Storage

Account preferences and subscription state are stored per user, using the configured JSON store in local development and YDB when `WEBNESTDEV_STORAGE=ydb`. Demo activation is not proof of payment and must never be treated as one by future payment code.

## Before enabling real payments

1. Enforce every plan quota server-side at project creation and agent/browser execution boundaries.
2. Add idempotent payment-provider webhook handling and reconcile subscription state only from verified provider events.
3. Add audit events, cancellation/refund handling, billing support flows, and tests for expiry, replayed webhooks, and cross-user isolation.
4. Keep demo mode as a separate configuration and test environment.
