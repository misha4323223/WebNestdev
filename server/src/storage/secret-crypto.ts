import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";
const ENV_NAME = "WEBNESTDEV_ENCRYPTION_KEY";
const KEY_FILE_NAME = "encryption-key";

/** The credential stores resolve the data directory the same way. */
function dataDirectory() {
  return process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
}

function decodeKey(raw: string): Buffer {
  const key = /^[a-f0-9]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  if (key.length !== 32) {
    throw new Error(`${ENV_NAME} must be a 32-byte key encoded as base64 or 64-character hex`);
  }
  return key;
}

/**
 * Development fallback for the key. A machine that only set GITHUB_CLIENT_ID and
 * GITHUB_CLIENT_SECRET used to fail on the first credential write: GitHub redirected
 * the user back to /api/github/callback and the callback answered 500, so the connect
 * flow could never finish. The generated key lives in the data directory and is reused,
 * so the workspace keeps reading the secrets it wrote. Production never creates a file
 * and still requires the environment variable.
 */
function developmentKey(): Buffer {
  const file = path.join(dataDirectory(), KEY_FILE_NAME);
  let stored: string | null = null;
  try {
    stored = readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stored) return decodeKey(stored);
  const key = randomBytes(32);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  console.warn(`[WebNestDev] Created a development encryption key at ${file}. Set ${ENV_NAME} to keep stored secrets readable across machines or data directories.`);
  return key;
}

/**
 * Resolved per call rather than cached: the value stays small, the env override always
 * wins, and a configuration change is never masked by an earlier lookup.
 */
function encryptionKey(): Buffer {
  const raw = process.env[ENV_NAME];
  if (raw) return decodeKey(raw);
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${ENV_NAME} is required to encrypt stored secrets`);
  }
  return developmentKey();
}

export function isEncryptedSecret(value: unknown): value is string { return typeof value === "string" && value.startsWith(PREFIX); }

export function assertEncryptionConfigured(): void { if (process.env.NODE_ENV === "production") encryptionKey(); }

function seal(value: string, key: Buffer): string {
  if (!value || isEncryptedSecret(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, encrypted].map(part => part.toString("base64url")).join(":");
}

function open(value: string, key: Buffer): string {
  if (!value || !isEncryptedSecret(value)) return value;
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted secret format");
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted secret payload");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function encryptSecret(value: string): string {
  return seal(value, encryptionKey());
}

/** Legacy plaintext values remain readable during migration; new writes are encrypted. */
export function decryptSecret(value: string): string {
  return open(value, encryptionKey());
}

/**
 * Ротация ключа: обе операции принимают ключ явно, поэтому скрипт не подменяет
 * `process.env` между вызовами и не может перешифровать часть файлов не тем ключом.
 * Плейнтекст возвращается как есть — так миграция старых записей тоже проходит через ротацию.
 */
export function encryptSecretWith(value: string, rawKey: string): string {
  return seal(value, decodeKey(rawKey));
}

export function decryptSecretWith(value: string, rawKey: string): string {
  return open(value, decodeKey(rawKey));
}
