import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The consent log resolves its file path when the module loads, so the throwaway data
 * directory has to be in place before the import.
 */
const dataDir = await mkdtemp(path.join(tmpdir(), "webnestdev-consent-"));
process.env.WEBNESTDEV_DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
delete process.env.WEBNESTDEV_PHONE_CONSENT_SECRET;
delete process.env.WEBNESTDEV_ENCRYPTION_KEY;

const { PHONE_CONSENT_VERSION, readPhoneConsents, recordPhoneConsent } = await import("./phone-consent.js");

after(async () => { await rm(dataDir, { recursive: true, force: true }); });

test("a consent record keeps the phone, version and purpose, and only a hash of the address", async () => {
  const record = await recordPhoneConsent("+79991234567", "203.0.113.7", "sign_in");
  assert.equal(record.phone, "+79991234567");
  assert.equal(record.version, PHONE_CONSENT_VERSION);
  assert.equal(record.purpose, "sign_in");
  assert.match(record.consentId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(record.ipHash, /^[0-9a-f]{64}$/);
  assert.notEqual(record.ipHash, "203.0.113.7");
});

test("the log is append-only: every consent keeps its own record", async () => {
  await recordPhoneConsent("+79990000001", "203.0.113.7", "sign_in");
  await recordPhoneConsent("+79990000001", "198.51.100.9", "link_account");
  const records = await readPhoneConsents();
  const forNumber = records.filter(item => item.phone === "+79990000001");
  assert.equal(forNumber.length, 2);
  assert.deepEqual(forNumber.map(item => item.purpose), ["sign_in", "link_account"]);
  // Two consents from different addresses must not produce the same hash.
  assert.notEqual(forNumber[0].ipHash, forNumber[1].ipHash);
});
