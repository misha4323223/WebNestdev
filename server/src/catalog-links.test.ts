import { test } from "node:test";
import assert from "node:assert/strict";
import { SERVICES } from "./services/catalog.js";
import { CLOUD_PROVIDERS } from "./cloud/providers.js";
import { DOMAIN_REGISTRARS, findDomainRegistrar } from "./domains/providers.js";

/**
 * Ссылки в карточках интеграций ведут туда, где ключ выдаётся, а не на главную сервиса.
 *
 * Договорённость: `keyUrl` — либо страница вглубь сайта (путь, а не корень: инструкция или
 * раздел с ключами), либо вход в кабинет, который не лежит на витрине продукта. Второе —
 * исключение: вход в кабинет можно перечислить только явно, иначе `https://service.ru/`
 * снова пролезет в каталог, и пользователь опять получит витрину вместо ключа.
 */
const CABINET_ENTRIES = new Set([
  "app.notisend.ru", // кабинет NotiSend: ключ живёт в «Автоматизация» → «API и SMTP»
  "merchant.cloudpayments.ru", // кабинет CloudPayments: Public ID и пароль API — у сайта
]);

type KeyEntry = { id: string; keyUrl: string; docsUrl: string; steps: string[] };

const ALL_ENTRIES: KeyEntry[] = [
  ...SERVICES.map(service => ({ id: service.id, keyUrl: service.keyUrl, docsUrl: service.docsUrl, steps: service.steps })),
  ...CLOUD_PROVIDERS.map(provider => ({ id: provider.id, keyUrl: provider.keyUrl, docsUrl: provider.docsUrl, steps: provider.steps })),
  ...DOMAIN_REGISTRARS.map(registrar => ({ id: registrar.id, keyUrl: registrar.keyUrl, docsUrl: registrar.docsUrl, steps: registrar.steps })),
];

test("every key link is the page where the credential is issued, not a product homepage", () => {
  for (const entry of ALL_ENTRIES) {
    const url = new URL(entry.keyUrl);
    assert.equal(url.protocol, "https:", entry.id + ": ссылка без https");
    const deep = url.pathname.replace(/\/+$/, "").length > 0;
    const cabinet = CABINET_ENTRIES.has(url.host);
    assert.ok(deep || cabinet, entry.id + ": ссылка ведёт на корень " + entry.keyUrl + " — это витрина, а не страница выдачи ключа");
    assert.match(entry.docsUrl, /^https:\/\//, entry.id + ": документация без https");
  }
});

test("every card explains the steps with at least the section names", () => {
  for (const entry of ALL_ENTRIES) {
    assert.ok(entry.steps.length >= 2, entry.id + ": шаги без инструкции");
    for (const step of entry.steps) assert.ok(step.trim().length > 15, entry.id + ": пустой шаг «" + step + "»");
  }
});

test("reg.ru points at «Настройки API» and never at a section the cabinet does not have", () => {
  const regru = findDomainRegistrar("regru");
  assert.ok(regru);
  const text = regru.steps.join("\n");
  assert.match(text, /«Настройки API»/, "шаг про IP должен называть «Настройки API»");
  assert.match(text, /«Диапазоны IP-адресов»/, "шаг про IP должен называть «Диапазоны IP-адресов»");
  assert.doesNotMatch(text, /«Безопасность»/, "вкладки «Безопасность» в кабинете REG.RU нет — такой шаг отправляет в тупик");
});
