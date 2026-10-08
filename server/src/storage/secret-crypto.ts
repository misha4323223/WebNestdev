import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ENV_NAME = "WEBNESTDEV_ENCRYPTION_KEY";

function encryptionKey(): Buffer {
  const raw = process.env[ENV_NAME];
  if (!raw) throw new Error(`${ENV_NAME} is required to encrypt stored secrets`);

  const key = /^[a-f0-9]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(`${ENV_NAME} must be a 32-byte key encoded as base64 or 64-character hex`);
  }
  return key;
}

export function isEncryptedSecret(value: unknown): value is string { return typeof value === "string" && value.startsWith(PREFIX); }

export function assertEncryptionConfigured(): void { if (process.env.NODE_ENV === "production") encryptionKey(); }

export function encryptSecret(value: string): string {
  if (!value || isEncryptedSecret(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, encrypted].map(part => part.toString("base64url")).join(":");
}

/** Legacy plaintext values remain readable during migration; new writes are encrypted. */
export function decryptSecret(value: string): string {
  if (!value || !isEncryptedSecret(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted secret format");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted secret payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
