# Credential encryption and key rotation

Provider API tokens and GitHub OAuth access tokens are encrypted at rest with AES-256-GCM. Each value uses a random 96-bit IV and an authentication tag; the storage format is `enc:v1:<iv>:<tag>:<ciphertext>`. Tokens are decrypted only when the server reads them for an authenticated integration operation. API responses expose only `hasToken`, never the token value.

## Configure the key

Set `WEBNESTDEV_ENCRYPTION_KEY` to a cryptographically random 32-byte key encoded as 64 hexadecimal characters or base64. Generate a hexadecimal key with:

```sh
openssl rand -hex 32
```

Store it in the deployment platform's secret manager. Do not commit it, print it to logs, or reuse it across environments. Production startup fails if the key is missing or malformed. Keep the same key across restarts and replicas that share the data directory.

## Existing installations

The first read of a legacy plaintext provider or GitHub connection migrates its token to ciphertext using an atomic temporary-file replacement. The in-memory value returned to existing callers remains plaintext, so the existing provider and GitHub API integration contracts do not change. If encryption fails, the read fails closed; the original record is not deliberately overwritten with plaintext. Back up the data directory and configure the key before deploying this version. Do not delete or recreate existing connection records.

## Rotate the key

1. Schedule a maintenance window and stop every WebNestDev process that accesses the shared data directory.
2. Take a restorable backup of the complete data directory and securely retain the current key.
3. Build the server: `npm run build:server`.
4. Run the rotation script with both keys supplied through the environment (never command-line arguments or shell history):
   ```sh
   WEBNESTDEV_ENCRYPTION_KEY='<current-key>' WEBNESTDEV_ENCRYPTION_KEY_NEXT='<new-key>' node scripts/rotate-encryption-key.mjs
   ```
   Use your secret manager to inject these values in real deployments instead of placing key values literally in a shell command.
5. Update `WEBNESTDEV_ENCRYPTION_KEY` in the deployment secret manager to the new key, remove `WEBNESTDEV_ENCRYPTION_KEY_NEXT`, then start the application.
6. Verify provider requests and GitHub status/repository listing, and inspect the stored records to ensure token values are not plaintext. Keep the backup and old key secured until verification succeeds; then retire the old key according to your secret-retention policy.

If rotation fails, keep the service stopped and restore the data-directory backup before retrying. The script processes only provider and GitHub credential files; keep an independently verified backup because filesystem writes across multiple files cannot be one transaction.
