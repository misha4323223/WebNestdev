# Browser Tool runtime verification gate

## Current implementation

`browser.open` is registered by `server/src/index.ts` and uses the current project's Preview state. It requests the Preview container over HTTP and returns status, headers, content type, and a bounded response body.

## Verification gate

Do not mark the Browser Tool complete until these runtime checks pass in an actual running environment:

1. Build the server with `npm --prefix server run build`.
2. Start a real project Preview.
3. Call `browser.open` for `/` and confirm a successful HTTP response and HTML body.
4. Call `browser.open` for a missing path and confirm the expected `404` response is returned instead of a tool failure.
5. If either check fails, feed the diagnostic back through the agent's fix-and-rerun loop.

## Repository limitation

The currently available GitHub operations can read and write repository files, commits, and workflow metadata, but they do not provide a generic shell execution channel. Therefore a repository edit alone is not evidence that the TypeScript build or Docker Preview runtime has passed.

## Completion rule

Only report runtime verification as complete after the commands above have actually executed successfully against the current code.
