# Credential encryption and key rotation

Provider API tokens, GitHub OAuth access tokens, cloud credentials, registrar credentials, service keys from «Интеграции» and project secrets are encrypted at rest with AES-256-GCM. Each value uses a random 96-bit IV and an authentication tag; the storage format is `enc:v1:<iv>:<tag>:<ciphertext>`. Tokens are decrypted only when the server reads them for an authenticated integration operation. API responses expose only `hasToken`, never the token value.

## Project secrets

The user's application secrets (`.env.local`, `.env`, `.env.production`, …) are not stored in the project workspace. The first read migrates every secret env file into `<data directory>/project-secrets/<projectId>.json` (or the `webnestdev_project_secrets` table) as one AES-256-GCM payload and removes the files from the project. The agent never sees the values: `fs.*`, context retrieval, the file API and the panel hide the names, and command containers get an empty read-only file in place of every existing secret env file.

Preview is the only consumer. At start it writes temporary files under `<sandbox directory>/.secret-runtime/<projectId>/`, mounts each one read-only at `/workspace/<file>` in the preview or build container, and deletes them when the preview stops or the server starts. Docker needs the mount target to exist as a file, so an **empty** placeholder is left at that path; it is hidden from `fs.*`, the file API and git, and contains no value. (An empty placeholder is skipped by later migration passes, so it cannot overwrite the stored values.) The workspace itself never holds the plaintext. This also means a project archive, a git clone and a host backup cannot contain the secret values.

Migration covers `.env` and every non-template `.env.<name>` file (`.env.local`, `.env.production`, `.env.production.local`, …), including files that appear after the first read (a `git pull`, a restored file). `.env.example`, `.env.sample` and `.env.template` stay in the project: they describe variables without values and are meant to be committed.

Every write, import, delete and modal answer is recorded in the secret audit journal with the project, user, action, variable names, file and a salted IP hash — never the value. Set `WEBNESTDEV_AUDIT_SALT` to a random value in production so the hash cannot be matched against a known address; without it the encryption key is used as the salt. Audit entries live in `<data directory>/secret-audit.jsonl` or the `webnestdev_secret_audit` table.

Residual boundary: code running inside the preview is the user's application and can read the variables it is given. An agent that writes code cannot be prevented from making that code expose a value; the platform guarantees that the agent's own file and command tools, the file UI, git and project archives never contain it.

## Configure the key

Set `WEBNESTDEV_ENCRYPTION_KEY` to a cryptographically random 32-byte key encoded as 64 hexadecimal characters or base64. Generate a hexadecimal key with:

```sh
openssl rand -hex 32
```

Store it in the deployment platform's secret manager. Do not commit it, print it to logs, or reuse it across environments. Production startup fails if the key is missing or malformed. Keep the same key across restarts and replicas that share the data directory.

### Development

When the variable is absent outside production, the server generates a key once and keeps it in `<data directory>/encryption-key` (mode `0600`, inside the git-ignored data directory) and reuses it, so credential writes such as the GitHub connect callback work without any setup. Before this fallback existed, the callback answered `500` after GitHub had already redirected the user back. Production never creates the file — startup fails instead (`assertEncryptionConfigured`) — so set the variable for any workspace whose secrets must stay readable from another machine or data directory, and always in deployed environments.

## Existing installations

The first read of a legacy plaintext provider or GitHub connection migrates its token to ciphertext using an atomic temporary-file replacement. The in-memory value returned to existing callers remains plaintext, so the existing provider and GitHub API integration contracts do not change. If encryption fails, the read fails closed; the original record is not deliberately overwritten with plaintext. Back up the data directory and configure the key before deploying this version. Do not delete or recreate existing connection records.

## Rotate the key

1. Schedule a maintenance window and stop every WebNestDev process that accesses the shared data directory or database.
2. Take a restorable backup of the complete data directory **and** the PostgreSQL database, and securely retain the current key.
3. Build the server: `npm run build:server` (the script imports the compiled modules from `server/dist`).
4. Run the rotation script with both keys supplied through the environment (never command-line arguments or shell history):
   ```sh
   WEBNESTDEV_STORAGE=postgres DATABASE_URL='postgres://…' \
   WEBNESTDEV_ENCRYPTION_KEY='<current-key>' WEBNESTDEV_ENCRYPTION_KEY_NEXT='<new-key>' \
   node scripts/rotate-encryption-key.mjs
   ```
   Use your secret manager to inject these values in real deployments instead of placing key values literally in a shell command. `WEBNESTDEV_STORAGE=json` (with `WEBNESTDEV_DATA_DIR`) rotates file-backed installations instead.
5. Update `WEBNESTDEV_ENCRYPTION_KEY` in the deployment secret manager to the new key, remove `WEBNESTDEV_ENCRYPTION_KEY_NEXT`, then start the application.
6. Verify provider requests, GitHub status/repository listing, the Yandex card, the cloud cards (Timeweb, Cloud.ru, MWS, REG.RU Облако), the registrar cards (REG.RU, Beget, Timeweb), the service cards, the database card and platform keys saved in the panel. A connection that no longer decrypts answers as an error rather than as "disconnected", so a missed store is visible immediately. Keep the backup and old key secured until verification succeeds; then retire the old key according to your secret-retention policy.

The script covers every store that holds ciphertext: `providers`, `github`, `yandex`, `database`, `project-secrets` files plus the keyed maps `cloud`, `domains` and `services` (one file per user, one entry per provider — the rotation walks the map entries, not the top level); the corresponding PostgreSQL tables (`webnestdev_providers`, `webnestdev_github_connections`, `webnestdev_yandex_connections`, `webnestdev_database_connections`, `webnestdev_project_secrets`, `webnestdev_cloud_connections`, `webnestdev_domain_connections`, `webnestdev_service_connections`); and the panel's platform keys in `platform/env.json`. Plaintext values left by older versions are encrypted with the new key during rotation. All values are decrypted before anything is written, and the database update runs in one transaction, but files and database cannot be one transaction: keep an independently verified backup. If rotation fails, keep the service stopped and restore both backups before retrying.
