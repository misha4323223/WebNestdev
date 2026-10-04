# WebNestdev

WebNestdev is the web-native evolution of the NestDev agent.

## Principle

NestDev Electron remains untouched and is used only as the reference implementation.

WebNestdev will reimplement the useful agent capabilities for the web:

- AI agent and streaming
- project workspace
- isolated sandbox
- filesystem and terminal tools
- Git/GitHub
- browser automation in isolated workers
- Yandex Cloud
- live preview and deployment
- project memory
- sponsor/advertising infrastructure

## Current status

Phase 1 establishes the web application shell and workspace UI.

The next layer is the server-side Agent Runtime: provider transport, tool registry, execution policy, project persistence, WebSocket events, and sandbox boundaries.

## Architecture

Browser -> Web API/WebSocket -> Agent Runtime -> isolated Sandbox

No arbitrary project code should execute on the WebNestdev host.
