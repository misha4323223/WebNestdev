import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOUD_PROVIDERS, findCloudProvider, readCloudFields } from "./providers.js";

const cloudru = findCloudProvider("cloudru")!;

test("a provider is looked up by the id the route receives", () => {
  assert.equal(findCloudProvider("timeweb")?.name, "Timeweb Cloud");
  assert.equal(findCloudProvider("mws")?.name, "MWS (МТС)");
  assert.equal(findCloudProvider("aws"), undefined);
});

test("every provider declares the fields its verification reads", () => {
  for (const provider of CLOUD_PROVIDERS) {
    assert.ok(provider.fields.length > 0, provider.id + " без полей");
    assert.ok(provider.steps.length >= 2, provider.id + " без шагов для консоли");
    assert.match(provider.consoleUrl, /^https:\/\//);
    assert.match(provider.docsUrl, /^https:\/\//);
  }
});

test("credentials are trimmed and only the declared fields are passed on", () => {
  const fields = readCloudFields(cloudru, { keyId: "  abc  ", secret: " s3cret ", extra: "ignored" });
  assert.deepEqual(fields, { keyId: "abc", secret: "s3cret" });
});

test("a missing or blank credential is rejected instead of stored", () => {
  assert.throws(() => readCloudFields(cloudru, { secret: "x" }), /Key ID/);
  assert.throws(() => readCloudFields(cloudru, { keyId: "   ", secret: "x" }), /Key ID/);
  assert.throws(() => readCloudFields(cloudru, { keyId: "x", secret: "" }), /Key Secret/);
  assert.throws(() => readCloudFields(cloudru, null), /объект/);
});

test("an oversized value is rejected before it reaches the provider", () => {
  assert.throws(() => readCloudFields(cloudru, { keyId: "x", secret: "a".repeat(8001) }), /слишком длинное/);
});
