import test from "node:test";
import assert from "node:assert/strict";
import { emailDomain, isServiceEmail, maskEmail, normalizeEmail, unusableEmailReason } from "./address.js";

/**
 * Правила адресов — то, что решает, попадёт ли человек в очередь рассылки. Ошибка здесь стоит
 * квоты Postbox и репутации домена: служебный адрес уходит отскоком, а не «просто не доставляется».
 */

test("служебные адреса платформы в письмо не годятся", () => {
  for (const email of [
    "79531814136@phone.webnestdev.local",
    "yandex-2260862792@yandex-id.webnestdev.local",
    "user@service.internal",
    "user@example.test",
    "user@mail.invalid",
    "user@localhost",
    "user@nas.lan",
    "user@server.home",
  ]) {
    const reason = unusableEmailReason(email);
    assert.ok(reason, "адрес " + email + " должен быть отброшен");
    assert.match(reason!, /служебный домен|без точки/, "причина объясняет отказ: " + reason);
  }
});

test("нерабочие адреса отличаются от служебных причиной", () => {
  assert.equal(unusableEmailReason(""), "адрес пустой");
  assert.match(unusableEmailReason("нет-собаки") ?? "", /не похож/);
  assert.match(unusableEmailReason("user@nodot") ?? "", /без точки/);
});

test("настоящий адрес проходит", () => {
  assert.equal(unusableEmailReason("client@example.ru"), null);
  assert.equal(unusableEmailReason("Ivan.Petrov@NestDev.ru"), null, "регистр не важен");
  assert.equal(emailDomain("ivan@nestdev.ru"), "nestdev.ru");
  assert.equal(normalizeEmail("  Ivan@NestDev.RU "), "ivan@nestdev.ru");
});

test("вид адреса в тикете: служебный или настоящий", () => {
  assert.equal(isServiceEmail("yandex-2260862792@yandex-id.webnestdev.local"), true);
  assert.equal(isServiceEmail("ivan@nestdev.ru"), false);
  assert.equal(isServiceEmail(""), false);
});

test("маскировка не показывает ящик целиком", () => {
  assert.equal(maskEmail("ivan.petrov@nestdev.ru"), "iv***@nestdev.ru");
  assert.equal(maskEmail("ya@nestdev.ru"), "y***@nestdev.ru");
  assert.equal(maskEmail(""), "");
});
