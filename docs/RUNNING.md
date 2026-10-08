# Running WebNestDev

WebNestDev has two launch modes.

## Universal deployment: Docker

The recommended deployment contract is the repository Dockerfile:

```bash
docker build -t webnestdev .
docker run --rm -p 8787:8787 webnestdev
```

The application is then available at `http://localhost:8787`.

This is the portable runtime for Docker-capable hosts. The container owns the Node runtime and dependencies, so the host does not need Node or npm.

## Local development

For source-level development with Vite hot reload:

```bash
npm run dev
```

The development UI runs on `http://localhost:5173` and the API on `http://localhost:8787`.

## Cloud platforms

For a Docker-capable service, point the deployment at the repository and use the root `Dockerfile`. The platform should expose the container's HTTP port `8787`.

If the platform requires a dynamically assigned `PORT`, set `PORT` and configure the service's port mapping accordingly. The application already reads `PORT` from the environment.

The agent's Docker sandbox is a separate capability from running the WebNestDev application itself. A cloud host that does not provide Docker access can still serve the application, but sandboxed agent execution will require a remote/managed sandbox backend.

## Why this split exists

- Docker is the deployment/runtime contract.
- npm is only a development/build implementation detail.
- The agent sandbox is an infrastructure dependency, not a requirement of the frontend/API HTTP server.
