import test from "node:test";
import assert from "node:assert/strict";

test("OTP rate limits do not partially consume buckets when one limit is exhausted", async () => {
  const previousStorage = process.env.WEBNESTDEV_STORAGE;
  process.env.WEBNESTDEV_STORAGE = "json";
  try {
    const { allowPhoneOtpRequest } = await import("./phone-otp.js");
    const exhaustedIp = "rate-limit-test-ip-exhausted";
    for (let index = 0; index < 10; index++) {
      assert.equal(
        await allowPhoneOtpRequest("phone-" + index, exhaustedIp),
        true,
        "the first ten requests from an IP should be allowed",
      );
    }
    assert.equal(await allowPhoneOtpRequest("phone-ip-blocked", exhaustedIp), false);

    const otherIp = "rate-limit-test-ip-other";
    assert.equal(
      await allowPhoneOtpRequest("phone-ip-blocked", otherIp),
      true,
      "a rejected request must not consume the phone bucket",
    );
    assert.equal(await allowPhoneOtpRequest("phone-ip-blocked", otherIp), true);
    assert.equal(await allowPhoneOtpRequest("phone-ip-blocked", otherIp), true);
    assert.equal(await allowPhoneOtpRequest("phone-ip-blocked", otherIp), false);
  } finally {
    if (previousStorage === undefined) delete process.env.WEBNESTDEV_STORAGE;
    else process.env.WEBNESTDEV_STORAGE = previousStorage;
  }
});
