# WebNestdev

Web-native evolution of the NestDev agent architecture.

## Architecture

Browser -> Fastify API/WebSocket -> Agent Runtime -> OpenAI-compatible Provider -> Tool Registry -> Project Sandbox -> Preview/Deployment

The Electron NestDev project remains separate and is not modified.

## AI provider

The web version uses an OpenAI-compatible API. Configure the provider with a Base URL, optional API key, and model. This supports hosted providers and compatible gateways without requiring a local model runtime.

## Security boundary

Agent commands run through a Docker sandbox by default.

Each command gets only the project workspace, a read-only container root, isolated network by default, CPU/memory/PID limits, a timeout, and bounded output. Provider credentials are not passed into the sandbox.

## Current implementation status

The agent can start a Docker-based project Preview and inspect the running service with `project.verify`, `browser.open`, and `browser.inspect`.

Preview inspection uses the actual host port assigned to the project, rather than assuming port 3000. This matters because different projects may expose different ports.

`browser.open` returns the HTTP status, status text, response headers, content type, a bounded response body, and basic HTML diagnostics when the response is HTML.

`browser.inspect` provides a compact HTML diagnostic view: page title, script/style/link/image references, resource counts, and common error strings found in server-rendered HTML. It deliberately does not claim to execute client-side JavaScript.

`project.verify` uses the same Preview state and performs an HTTP-level readiness check. The Agent Runtime is instructed to treat verification failures and tool errors as actionable diagnostics and retry after making fixes.

The next browser milestone is a real headless-browser worker for client-side console/runtime errors, failed network requests, DOM inspection after JavaScript execution, and screenshots. Those signals can then feed a bounded automatic fix/retry loop.

## CI

GitHub Actions runs the server and web builds for pull requests targeting `main` and pushes to `main`. The current verification branch has a successful CI run on its latest verified commit.

## Roadmap

- persistent projects and conversations
- Git/GitHub integration
- live preview workers
- browser worker
- Yandex Cloud resource/deployment tools
- authentication and secrets
- sponsor service with privacy isolation
- usage limits, moderation and abuse protection

## Local development

The repository uses npm workspaces, so the frontend and backend dependencies are installed from the repository root.

```bash
npm install
npm run dev
```

The development UI runs on port 5173 and the API on port 8787. Vite proxies /api and /ws to the API during local development.

## Local accounts

WebNestDev now uses a real local authentication flow before opening the workspace:

- register with email and password;
- login and logout;
- HTTP-only session cookie;
- password hashing with salted scrypt;
- projects and conversations are scoped to the authenticated user.

Local account data is stored under .webnestdev/auth. This is a development storage layer; production storage will move to managed infrastructure without changing the user-facing flow.

See docs/AUTH_PRODUCTION_PLAN.md for the staged rollout.
