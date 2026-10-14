import { createHmac, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isYdbEnabled, ydbQuery, getTable } from "../storage/ydb.js";
import { hashKey } from "../security/hash-key.js";

const root = process.env.WEBNESTDEV_DATA_DIR ?? path.resolve(".webnestdev");
const consentsFile = path.join(root, "auth", "phone-consents.json");

/** Bump this when the wording the user agrees to changes. */
export const PHONE_CONSENT_VERSION = process.env.WEBNESTDEV_PHONE_CONSENT_VERSION?.trim() || "phone-auth-v1";

export const PHONE_CONSENT_REQUIRED_MESSAGE = "Отметьте согласие на обработку номера телефона";

export type PhoneConsentPurpose = "sign_in" | "link_account";

export type PhoneConsentRecord = {
  consentId: string;
  phone: string;
  version: string;
  purpose: PhoneConsentPurpose;
  consentedAt: string;
  ipHash: string;
};

/**
 * The address is stored as an HMAC, never in the clear: the record proves that a
 * consent was given from some address without keeping a raw address on file.
 * WEBNESTDEV_PHONE_CONSENT_SECRET is the secret to set in production.
 */
function consentKey(): string {
  return hashKey(process.env.WEBNESTDEV_PHONE_CONSENT_SECRET, "WEBNESTDEV_PHONE_CONSENT_SECRET");
}

/**
 * Records that the user confirmed the phone-number processing consent. The log is
 * append-only: a new version of the text produces a new record instead of rewriting
 * the old one, so the history of who agreed to what stays intact.
 */
export async function recordPhoneConsent(phone: string, ip: string, purpose: PhoneConsentPurpose): Promise<PhoneConsentRecord> {
  const record: PhoneConsentRecord = {
    consentId: randomUUID(),
    phone,
    version: PHONE_CONSENT_VERSION,
    purpose,
    consentedAt: new Date().toISOString(),
    ipHash: createHmac("sha256", consentKey()).update(ip).digest("hex"),
  };
  if (isYdbEnabled()) {
    await ydbQuery()`
      INSERT INTO ${ydbQuery().identifier(getTable("phone_consents"))}
        (consent_id,phone,consent_version,purpose,consented_at,ip_hash)
      VALUES (${record.consentId},${record.phone},${record.version},${record.purpose},${record.consentedAt},${record.ipHash})
    `;
    return record;
  }
  await mkdir(path.dirname(consentsFile), { recursive: true });
  await appendFile(consentsFile, JSON.stringify(record) + "\n", { mode: 0o600 });
  return record;
}

/** The local JSON-lines consent log, newest last. Empty when nothing was recorded yet. */
export async function readPhoneConsents(): Promise<PhoneConsentRecord[]> {
  try {
    const raw = await readFile(consentsFile, "utf8");
    return raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as PhoneConsentRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
