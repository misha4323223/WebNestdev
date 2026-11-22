import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegruServers, verifyCloudCredential } from "./verify.js";

test("reg.ru cloud servers are counted for the card label", () => {
  assert.equal(parseRegruServers({ reglets: [{ id: 1 }, { id: 2 }] }), "REG.RU Облако · серверов: 2");
  assert.equal(parseRegruServers({ links: { actions: [] }, reglets: [] }), "REG.RU Облако · серверов: 0");
});

test("an answer without the server list is an error, not a fake zero", () => {
  assert.throws(() => parseRegruServers({ error: "unauthorized" }), /без списка серверов/);
  assert.throws(() => parseRegruServers(null), /без списка серверов/);
});

test("Cloud.ru проверяет доступ к проекту, а не только обмен ключа на IAM-токен", async () => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://iam.api.cloud.ru/")) {
      return new Response(JSON.stringify({ access_token: "t1.cloudru" }), { status: 200 });
    }
    if (url.startsWith("https://compute.api.cloud.ru/api/v1/vms?")) {
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  }) as typeof fetch;
  try {
    const result = await verifyCloudCredential("cloudru", { keyId: "key-1", secret: "secret", projectId: "p-1" });
    assert.match(result.account, /проект p-1/);
    assert.ok(urls.some(url => url === "https://compute.api.cloud.ru/api/v1/vms?project_id=p-1&limit=1"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
