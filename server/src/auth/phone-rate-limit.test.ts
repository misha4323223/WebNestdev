import test from "node:test";
import assert from "node:assert/strict";

test("concurrent OTP requests do not partially consume rate-limit buckets", async () => {
  const previousStorage = process.env.WEBNESTDEV_STORAGE;
  process.env.WEBNESTDEV_STORAGE = "json";
  try {
    const { allowPhoneOtpRequest } = await import("./phone-otp.js");
    const sharedPhone = "phone-concurrent-rate-limit-test";
    const ips = Array.from({ length: 12 }, (_, index) => "parallel-rate-limit-ip-" + index);
    const results = await Promise.all(ips.map(ip => allowPhoneOtpRequest(sharedPhone, ip)));

    assert.equal(results.filter(Boolean).length, 3, "only three requests per phone should pass");
    const rejectedIp = ips[results.findIndex(result => !result)];
    assert.ok(rejectedIp, "at least one concurrent request should be rate-limited");

    // A request rejected by the phone bucket must not consume its IP bucket.
    // That IP should still have its full allowance for unrelated phone numbers.
    for (let index = 0; index < 10; index++) {
      assert.equal(
        await allowPhoneOtpRequest("unrelated-phone-" + index, rejectedIp),
        true,
        "a rejected request must not partially consume the IP bucket",
      );
    }
    assert.equal(await allowPhoneOtpRequest("unrelated-phone-final", rejectedIp), false);
  } finally {
    if (previousStorage === undefined) delete process.env.WEBNESTDEV_STORAGE;
    else process.env.WEBNESTDEV_STORAGE = previousStorage;
  }
});
