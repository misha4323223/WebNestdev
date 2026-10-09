import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("OTP is one-time and locks after five incorrect attempts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "webnestdev-otp-"));
  const previous = {
    storage: process.env.WEBNESTDEV_STORAGE,
    dataDir: process.env.WEBNESTDEV_DATA_DIR,
    smsMode: process.env.WEBNESTDEV_SMS_MODE,
    otpSecret: process.env.WEBNESTDEV_PHONE_OTP_SECRET,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.WEBNESTDEV_STORAGE = "json";
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_SMS_MODE = "console";
  process.env.WEBNESTDEV_PHONE_OTP_SECRET = "test-only-phone-otp-secret-with-32-chars";
  process.env.NODE_ENV = "test";
  const originalInfo = console.info;
  let capturedCode = "";
  console.info = (...args: unknown[]) => { capturedCode = String(args[args.length - 1] ?? ""); };
  try {
    const { requestPhoneOtp, verifyPhoneOtp } = await import("./phone-otp.js");
    const phone = "+79001234567";
    await requestPhoneOtp(phone, "127.0.0.1");
    assert.match(capturedCode, /^\d{6}$/);
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(await verifyPhoneOtp(phone, "999999" === capturedCode ? "000000" : "999999"), false);
    }
    assert.equal(await verifyPhoneOtp(phone, capturedCode), false, "challenge must be locked after five wrong codes");

    await requestPhoneOtp(phone, "127.0.0.1");
    const secondCode = capturedCode;
    assert.match(secondCode, /^\d{6}$/);
    assert.equal(await verifyPhoneOtp(phone, secondCode), true);
    assert.equal(await verifyPhoneOtp(phone, secondCode), false, "successful OTP must not be reusable");

    await requestPhoneOtp(phone, "127.0.0.1");
    const challengePath = path.join(root, "auth", "phone-otp-challenges.json");
    const challenges = JSON.parse(await readFile(challengePath, "utf8")) as Record<string, { expiresAt: string }>;
    challenges[phone].expiresAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(challengePath, JSON.stringify(challenges), { mode: 0o600 });
    assert.equal(await verifyPhoneOtp(phone, capturedCode), false, "expired OTP must be rejected");
  } finally {
    console.info = originalInfo;
    for (const [key, value] of Object.entries({
      WEBNESTDEV_STORAGE: previous.storage,
      WEBNESTDEV_DATA_DIR: previous.dataDir,
      WEBNESTDEV_SMS_MODE: previous.smsMode,
      WEBNESTDEV_PHONE_OTP_SECRET: previous.otpSecret,
      NODE_ENV: previous.nodeEnv,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
