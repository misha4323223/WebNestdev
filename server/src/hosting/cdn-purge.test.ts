import assert from "node:assert/strict";
import test from "node:test";
import type { mwsRequest } from "../mws/mws-auth.js";
import { hostingCdnConfig, purgeHostingCdn, purgeTaskName } from "./cdn-purge.js";

const ENABLED_ENV = {
  HOSTING_CDN_PURGE: "1",
  HOSTING_CDN_RESOURCE: "hosting",
  HOSTING_CDN_PROJECT: "project-pimashin2015",
} as NodeJS.ProcessEnv;

test("hostingCdnConfig выключен без флага", () => {
  assert.equal(hostingCdnConfig({} as NodeJS.ProcessEnv), null);
  assert.equal(hostingCdnConfig({ HOSTING_CDN_PURGE: "0", HOSTING_CDN_PROJECT: "p" } as NodeJS.ProcessEnv), null);
});

test("hostingCdnConfig читает проект из переменной", () => {
  assert.deepEqual(hostingCdnConfig(ENABLED_ENV), {
    project: "project-pimashin2015",
    resource: "hosting",
  });
});

test("hostingCdnConfig выводит проект из MWS_SA_KEY_ID", () => {
  assert.deepEqual(
    hostingCdnConfig({
      HOSTING_CDN_PURGE: "true",
      MWS_SA_KEY_ID: "projects/my-project/serviceAccounts/sa/authorizedKeys/k",
    } as NodeJS.ProcessEnv),
    { project: "my-project", resource: "hosting" },
  );
});

test("purgeTaskName подходит под ограничение API", () => {
  const name = purgeTaskName("My Site!!!", 1_700_000_000_000);
  assert.match(name, /^[a-z][a-z0-9-]{0,62}$/);
  assert.ok(name.length <= 63, name);
  assert.match(name, /^purge-my-site-/);
});

test("purgeHostingCdn пропускается без конфигурации", async () => {
  let called = false;
  const request = (async () => {
    called = true;
    return { ok: true, status: 200, body: {} };
  }) as unknown as typeof mwsRequest;
  const result = await purgeHostingCdn("site", { request, env: {} as NodeJS.ProcessEnv });
  assert.deepEqual(result, { skipped: true });
  assert.equal(called, false);
});

test("purgeHostingCdn отправляет purge на общий ресурс", async () => {
  const calls: unknown[] = [];
  const request = (async (input: unknown) => {
    calls.push(input);
    return { ok: true, status: 200, body: {} };
  }) as unknown as typeof mwsRequest;
  const result = await purgeHostingCdn("my-site", {
    request,
    env: ENABLED_ENV,
    now: () => 1_700_000_000_000,
  });
  assert.equal(result.skipped, false);
  assert.equal(calls.length, 1);
  const call = calls[0] as {
    method: string;
    path: string;
    body: { metadata: { name: string }; spec: { resource: string; action: { purge: { paths: string[] } } } };
  };
  assert.equal(call.method, "POST");
  assert.equal(
    call.path,
    "/cdn/v1/projects/project-pimashin2015/cacheTasks/purge-my-site-loyw3v28",
  );
  assert.equal(call.body.spec.resource, "hosting");
  assert.deepEqual(call.body.spec.action.purge.paths, ["/*"]);
  assert.equal(call.body.metadata.name, "purge-my-site-loyw3v28");
});

test("purgeHostingCdn бросает ошибку при отказе API", async () => {
  const request = (async () => ({ ok: false, status: 403, body: {} })) as unknown as typeof mwsRequest;
  await assert.rejects(
    purgeHostingCdn("my-site", { request, env: ENABLED_ENV }),
    /HTTP 403/,
  );
});
