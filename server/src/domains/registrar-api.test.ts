import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBegetDomains, parseRegRuDomains, parseTimewebDomains, regRuAccessHint } from "./registrar-api.js";
import { findDomainRegistrar, readRegistrarFields } from "./providers.js";

test("beget success envelope is unwrapped", () => {
  const domains = parseBegetDomains({
    status: "success",
    answer: { status: "success", result: [{ fqdn: "Example.RU", date_expire: "2027-01-01" }, { fqdn: "nozone" }] },
  });
  assert.deepEqual(domains, [{ name: "example.ru", expiresAt: "2027-01-01" }]);
});

test("beget errors surface instead of an empty list", () => {
  assert.throws(() => parseBegetDomains({ status: "error", error_text: "Invalid passwd" }), /Beget отклонил доступ.*Invalid passwd/);
  assert.throws(
    () => parseBegetDomains({ status: "success", answer: { status: "error", errors: [{ error_text: "access denied" }] } }),
    /Beget отклонил доступ/,
  );
});

test("timeweb domains are read from the domains array", () => {
  const domains = parseTimewebDomains({ domains: [{ fqdn: "my-shop.ru", expiration: "2028-03-03" }], meta: { total: 1 } });
  assert.deepEqual(domains, [{ name: "my-shop.ru", expiresAt: "2028-03-03" }]);
  assert.throws(() => parseTimewebDomains({}), /без списка доменов/);
});

test("reg.ru success and error shapes", () => {
  const domains = parseRegRuDomains({ result: "success", answer: { domains: [{ dname: "site.ru" }] } });
  assert.deepEqual(domains, [{ name: "site.ru", expiresAt: null }]);
  assert.throws(
    () => parseRegRuDomains({ result: "error", error_code: "AUTH_FAILED", error_text: "Invalid password" }),
    /REG\.RU отклонил доступ.*Invalid password.*AUTH_FAILED/,
  );
});

test("reg.ru service/get_list answer is read from answer.services", () => {
  // Ответ `service/get_list` с `servtype:"domain"`: так его возвращает REG.API 2 (поля — как в
  // примере официального клиента). Раньше разбирался только `answer.domains`, и рабочий ответ
  // выглядел бы как пустой список доменов.
  const domains = parseRegRuDomains({
    charset: "utf-8",
    result: "success",
    answer: {
      services: [
        { dname: "NestDev.RU", servtype: "domain", state: "A", expiration_date: "2027-04-01" },
        { dname: "webnest.ru", servtype: "domain", state: "A", expiration_date: "2026-12-31" },
        { dname: "hosting-123", servtype: "hosting", state: "A", expiration_date: "2026-01-01" },
      ],
    },
  });
  assert.deepEqual(domains, [
    { name: "nestdev.ru", expiresAt: "2027-04-01" },
    { name: "webnest.ru", expiresAt: "2026-12-31" },
  ]);
});

test("reg.ru command failure is reported as it came from the API", () => {
  // Именно этот ответ пришёл на `domain/get_list`: команды с таким именем в REG.API нет.
  assert.throws(
    () => parseRegRuDomains({
      charset: "utf-8",
      result: "error",
      error_code: "NO_SUCH_COMMAND",
      error_text: "Command domain/get_list not found",
    }),
    /Command domain\/get_list not found.*NO_SUCH_COMMAND/,
  );
});

test("the reg.ru ip refusal names the server address to allow", () => {
  const denied = "REG.RU отклонил доступ: Access to API from this IP denied (код ACCESS_DENIED_FROM_IP)";
  const hinted = regRuAccessHint(denied, "203.0.113.7");
  // Подсказка называет раздел, который есть в кабинете сейчас. Придуманная вкладка («Безопасность»)
  // отправляла пользователя искать её и не находить — этот тест её не пропускает.
  assert.match(hinted, /«Настройки API»/);
  assert.match(hinted, /«Диапазоны IP-адресов»/);
  assert.doesNotMatch(hinted, /Безопасность/);
  assert.match(hinted, /203\.0\.113\.7/);
  assert.equal(regRuAccessHint("REG.RU отклонил доступ: Invalid password", "203.0.113.7"), "REG.RU отклонил доступ: Invalid password");
});

test("registrar fields are validated before any network call", () => {
  const regru = findDomainRegistrar("regru");
  assert.ok(regru);
  assert.deepEqual(readRegistrarFields(regru, { username: " user ", password: "secret" }), { username: "user", password: "secret" });
  assert.throws(() => readRegistrarFields(regru, { username: "user" }), /Пароль или API-пароль/);
  assert.throws(() => readRegistrarFields(regru, null), /Ожидался объект/);
});
