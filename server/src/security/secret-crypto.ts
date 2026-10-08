import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const ALGORITHM = "aes-256-gcm";

function encryptionKey(): Buffer {
  const value = process.env.WEBNESTDEV_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("WEBNESTDEV_ENCRYPTION_KEY is required to store or read credentials");
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) key = Buffer.from(value, "hex");
  else {
    key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      throw new Error("WEBNESTDEV_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters or base64");
    }
  }
  if (key.length !== 32) throw new Error("WEBNESTDEV_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function assertEncryptionConfigured(): void {
  if (process.env.NODE_ENV === "production") encryptionKey();
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptSecret(plaintext: string): string {
  if (isEncryptedSecret(plaintext)) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map(part => part.toString("base64url")).join(":");
}

export function decryptSecret(value: string): string {
  if (!isEncryptedSecret(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Stored credential has an invalid encrypted format");
  const [ivText, tagText, ciphertextText] = parts;
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
