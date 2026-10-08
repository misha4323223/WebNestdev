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

The real headless-browser worker is now implemented as `browser.runtime`. It executes the Preview in Chromium, captures console messages, page errors, failed network requests, HTTP errors, page title, rendered HTML size, and a bounded PNG screenshot. The worker is protected by a 20-second runtime limit and a 2 MB screenshot limit. After mutating tools such as `fs.write`, `fs.rename`, `fs.delete`, `terminal.exec`, and `npm.install`, Agent Runtime automatically starts Preview and runs `project.verify`; for relevant web changes it also runs `browser.runtime`. This automatic verification is bounded to three attempts per agent run, and failures are returned to the model as actionable diagnostics for the next fix.

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

See docs/AUTH_PRODUCTION_PLAN.md for the staged rollout. Credential encryption, legacy-token migration, and key rotation are documented in docs/SECRET_ENCRYPTION.md.
