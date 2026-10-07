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

## Phase 5 — Security hardening
- CSRF protection where required by the final cookie architecture.
- Rate limiting for registration/login.
- Password reset and email verification.
- Session revocation and rotation.
- Audit logging and abuse controls.

## Current milestone

Phase 1 is implemented locally. It is intentionally production-like at the user-flow level while remaining independent of Yandex Cloud. Runtime build/start verification still needs to be executed in an environment with npm available.
