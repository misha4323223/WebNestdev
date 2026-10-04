# WebNestdev

Web-native evolution of the NestDev agent architecture.

## Architecture

Browser -> Fastify API/WebSocket -> Agent Runtime -> Provider -> Tool Registry -> Project Sandbox -> Preview/Deployment

The Electron NestDev project remains separate and is not modified.

## Security boundary

Agent commands run through a Docker sandbox by default.

Each command gets only the project workspace, a read-only container root, isolated network by default, CPU/memory/PID limits, a timeout, and bounded output. Provider credentials are not passed into the sandbox.

## Roadmap

- persistent projects and conversations
- Git/GitHub integration
- live preview workers
- browser worker
- Yandex Cloud resource/deployment tools
- authentication and secrets
- sponsor service with privacy isolation
- usage limits, moderation and abuse protection
