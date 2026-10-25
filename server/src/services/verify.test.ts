import { test } from "node:test";
import assert from "node:assert/strict";
import { findService, resolveServiceFields, serviceEnvValues } from "./catalog.js";
import {
  assertPublicHttpsUrl,
  parse2gis,
  parseAmocrm,
  parseBitrix,
  parseCloudpayments,
  parseExpo,
  parseGeocoder,
  parseGigachatToken,
  parseRetailcrm,
  parseSendsay,
  parseUnisender,
  parseYookassa,
  verifyServiceCredential,
} from "./verify.js";

test("обязательные поля проверяются, необязательные берут значения по умолчанию", () => {
  const storage = findService("timeweb-storage");
  assert.ok(storage);
  const resolved = resolveServiceFields(storage, { accessKey: " key ", secretKey: "secret" });
  assert.equal(resolved.accessKey, "key");
  assert.equal(resolved.endpoint, "https://s3.twcstorage.ru");
  assert.equal(resolved.region, "ru-1");
  assert.throws(() => resolveServiceFields(storage, { accessKey: "key" }), /Secret Access Key/);
  assert.throws(() => resolveServiceFields(storage, null), /Ожидался объект/);

  const gigachat = findService("gigachat");
  assert.ok(gigachat);
  assert.equal(resolveServiceFields(gigachat, { authKey: "abc" }).scope, "GIGACHAT_API_PERS");
});

test("Cloud.ru склеивает access key из тенанта и ключа", () => {
  const cloudru = findService("cloudru-storage");
  assert.ok(cloudru);
  const resolved = resolveServiceFields(cloudru, { tenantId: "t-1", keyId: "k-2", secretKey: "s-3" });
  assert.equal(resolved.accessKey, "t-1:k-2");
  const variables = serviceEnvValues(cloudru, resolved);
  assert.equal(variables.S3_ACCESS_KEY_ID, "t-1:k-2");
  assert.equal(variables.S3_ENDPOINT, "https://s3.cloud.ru");
  assert.equal(variables.S3_REGION, "ru-central-1");
});

test("Postbox отдаёт SMTP-переменные и проверяет ключ без отправки письма", async () => {
  const postbox = findService("yandex-postbox");
  assert.ok(postbox);
  const fields = resolveServiceFields(postbox, { apiKeyId: "key-id", apiKeySecret: "secret" });
  const variables = serviceEnvValues(postbox, fields);
  assert.equal(variables.POSTBOX_SMTP_HOST, "postbox.cloud.yandex.net");
  assert.equal(variables.POSTBOX_SMTP_PORT, "465");
  assert.equal(variables.POSTBOX_SMTP_USER, "key-id");
  assert.equal(variables.POSTBOX_SMTP_PASSWORD, "secret");

  let checked = "";
  const result = await verifyServiceCredential(postbox, fields, {
    postboxSmtp: async (username, password) => { checked = username + ":" + password; },
  });
  assert.equal(checked, "key-id:secret");
  assert.match(result.account, /Postbox/);
});

test("адреса аккаунтов пускаются только публичные и по https", () => {
  assert.equal(assertPublicHttpsUrl("https://shop.retailcrm.ru/", "Адрес"), "https://shop.retailcrm.ru");
  assert.throws(() => assertPublicHttpsUrl("http://shop.retailcrm.ru", "Адрес"), /https/);
  assert.throws(() => assertPublicHttpsUrl("https://localhost/api", "Адрес"), /внутренние/);
  assert.throws(() => assertPublicHttpsUrl("https://127.0.0.1/api", "Адрес"), /домен, а не IP/);
  assert.throws(() => assertPublicHttpsUrl("https://portal", "Адрес"), /полный адрес/);
});

test("разбор ответов провайдеров: успех и отказ", () => {
  assert.equal(parseUnisender({ result: [] }), "Unisender · 0 списков");
  assert.throws(() => parseUnisender({ error: "There is no user with api_key 'x'", code: "invalid_api_key" }), /invalid_api_key/);

  assert.equal(parseSendsay({ ping: "pong", account: "demo" }, "demo"), "Sendsay · demo");
  assert.throws(() => parseSendsay({ errors: [{ id: "wrong_credentials" }] }, "demo"), /wrong_credentials/);

  assert.match(parseYookassa({ account_id: "123", status: "enabled", test: true }), /123.*тестовый/);
  assert.throws(() => parseYookassa({ type: "error" }), /без сведений о магазине/);

  assert.equal(parseCloudpayments({ Success: true }), "CloudPayments");
  assert.throws(() => parseCloudpayments({ Success: false, Message: "Authentication failed." }), /Authentication failed/);

  assert.equal(parseGigachatToken({ access_token: "abc" }), "abc");
  assert.throws(() => parseGigachatToken({ error: "invalid_client" }), /не выдал токен/);

  assert.match(parseGeocoder({ response: { GeoObjectCollection: { member: [{}] } } }), /геокодер отвечает/);
  assert.throws(() => parseGeocoder({ statusCode: 403, error: "Forbidden" }), /без результатов/);

  assert.match(parse2gis({ meta: { code: 200 }, result: { items: [1, 2] } }), /регионов в ответе: 2/);
  // Реальный ответ 2GIS на неверный ключ: HTTP 200, но код в теле 403.
  assert.throws(() => parse2gis({ meta: { code: 403, error: { message: "Authorization error, incorrect key." } } }), /код 403/);

  assert.equal(parseRetailcrm({ success: true }), "RetailCRM");
  assert.throws(() => parseRetailcrm({ success: false, errorMsg: 'Wrong "apiKey" value.' }), /Wrong/);

  assert.match(parseBitrix({ result: { ID: "1", NAME: "Иван" } }), /пользователь 1 · Иван/);
  assert.throws(() => parseBitrix({ result: {} }), /без пользователя/);

  assert.equal(parseAmocrm({ id: 5, subdomain: "shop" }), "amoCRM · shop");
  assert.throws(() => parseAmocrm({ message: "Unauthorized" }), /без аккаунта/);

  assert.match(parseExpo({ data: { meActor: { __typename: "UserActor", username: "nestdev" } } }), /nestdev/);
  assert.throws(() => parseExpo({ errors: [{ message: "Unauthorized" }] }), /отклонил токен/);
  assert.throws(() => parseExpo({ data: { meActor: null } }), /не подтвердил токен/);
});

test("проверка сервиса использует подставленный fetch", async () => {
  const twoGis = findService("2gis");
  assert.ok(twoGis);
  const fields = resolveServiceFields(twoGis, { apiKey: "demo-key" });
  const fakeFetch = (async () => new Response(JSON.stringify({ meta: { code: 200 }, result: { items: [{}] } }), { status: 200 })) as unknown as typeof fetch;
  assert.match((await verifyServiceCredential(twoGis, fields, { fetch: fakeFetch })).account, /2GIS/);

  const notisend = findService("notisend");
  assert.ok(notisend);
  const denied = (async () => new Response('{"errors":[{"code":401}]}', { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => verifyServiceCredential(notisend, resolveServiceFields(notisend, { apiKey: "demo" }), { fetch: denied }),
    /NotiSend отклонил ключ \(HTTP 401\)/,
  );
});

test("у сервисов без безопасной проверки нет проверяющего запроса", () => {
  for (const id of ["robokassa", "tbank-payments"]) {
    const service = findService(id);
    assert.ok(service);
    assert.equal(service.verification, "store");
    assert.match(service.verificationNote, /без проверки/);
  }
});
