/**
 * Resolves the key used to hash an identifier (an address, a phone number) before it is
 * stored. A dedicated secret wins, the encryption key the deployment already has is the
 * next best thing, and a documented fallback keeps the feature working when neither is
 * configured — the value is still never written in the clear, and a production
 * deployment gets a warning telling the operator which secret to set.
 */
export function hashKey(secret: string | undefined, label: string): string {
  if (secret && secret.length >= 32) return secret;
  const encryption = process.env.WEBNESTDEV_ENCRYPTION_KEY;
  if (encryption && encryption.length >= 32) return encryption;
  if (process.env.NODE_ENV === "production") {
    console.warn("[security] " + label + " is not configured: hashes fall back to the built-in key. Set a 32+ character secret in production.");
  }
  return "webnestdev-local-hash-key-v1:" + label;
}
