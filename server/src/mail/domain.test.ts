import test from "node:test";
import assert from "node:assert/strict";
import { checkMailDomain, resetMailDomainCache, type DnsLookup } from "./domain.js";

/**
 * Проверка домена отвечает на вопрос «почему письма в спаме» до первой рассылки: DKIM — требование
 * Postbox, SPF и DMARC — то, чем почтовики решают, доверять ли домену. Разговор с DNS подделан, а
 * не пропущен: неправильный ответ здесь означал бы, что админка врёт оператору.
 */

function lookup(options: { cnames?: Record<string, string[]>; txt?: Record<string, string[][]>; fail?: boolean }): DnsLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async cname(name) {
      calls.push("cname:" + name);
      if (options.fail) throw new Error("ENOTFOUND");
      return options.cnames?.[name] ?? [];
    },
    async txt(name) {
      calls.push("txt:" + name);
      if (options.fail) throw new Error("ENOTFOUND");
      return options.txt?.[name] ?? [];
    },
  };
}

const FULL = {
  cnames: {
    "selector1._domainkey.nestdev.ru": ["selector1.dkim.postbox.yandexcloud.net"],
    "selector2._domainkey.nestdev.ru": ["selector2.dkim.postbox.yandexcloud.net"],
  },
  txt: {
    "nestdev.ru": [["v=spf1 include:spf.postbox.yandexcloud.net ~all"]],
    "_dmarc.nestdev.ru": [["v=DMARC1;p=none"]],
  },
};

test("домен с DKIM, SPF и DMARC считается подтверждённым", async () => {
  resetMailDomainCache();
  const dns = lookup(FULL);
  const result = await checkMailDomain("mail@nestdev.ru", ["selector1", "selector2"], dns);
  assert.equal(result.verified, true);
  assert.equal(result.checked, true);
  assert.equal(result.dkim.status, "ok");
  assert.equal(result.spf.status, "ok");
  assert.equal(result.dmarc.status, "ok");
  assert.equal(result.hint, "", "когда всё настроено, предупреждать не о чем");
  assert.equal(result.dkim.selectors.length, 2);
});

test("без CNAME DKIM домен не подтверждён, и видно, каких записей нет", async () => {
  resetMailDomainCache();
  const result = await checkMailDomain("mail@spam.example", ["selector1", "selector2"], lookup({ txt: { "spam.example": [["v=spf1 -all"]] } }));
  assert.equal(result.verified, false);
  assert.equal(result.dkim.status, "missing");
  assert.match(result.hint, /selector1, selector2/);
  assert.match(result.hint, /include:spf\.postbox\.yandexcloud\.net/);
  assert.match(result.hint, /_dmarc\.spam\.example/);
});

test("пустой список селекторов — DKIM не проверен, а не «не настроен»", async () => {
  resetMailDomainCache();
  const result = await checkMailDomain("mail@unknowns.ru", [], lookup(FULL));
  assert.equal(result.checked, false);
  assert.equal(result.dkim.status, "unknown");
  assert.match(result.hint, /POSTBOX_DKIM_SELECTORS/);
});

test("адрес отправителя не задан — проверять нечего", async () => {
  resetMailDomainCache();
  const result = await checkMailDomain("", ["selector1"], lookup(FULL));
  assert.equal(result.domain, "");
  assert.equal(result.verified, false);
  assert.match(result.hint, /POSTBOX_SENDER/);
});

test("отказ DNS читается как «записи нет», а не как сбой проверки", async () => {
  resetMailDomainCache();
  const result = await checkMailDomain("mail@failing.ru", ["selector1"], lookup({ fail: true }));
  assert.equal(result.verified, false);
  assert.equal(result.dkim.status, "missing");
  assert.equal(result.spf.status, "missing");
});

test("повторная проверка берёт результат из кэша, а не из DNS", async () => {
  resetMailDomainCache();
  const dns = lookup({
    cnames: { "selector1._domainkey.cached.ru": ["selector1.dkim.postbox.yandexcloud.net"] },
    txt: { "cached.ru": [["v=spf1 include:spf.postbox.yandexcloud.net ~all"]] },
  });
  await checkMailDomain("mail@cached.ru", ["selector1"], dns);
  const before = dns.calls.length;
  const cached = await checkMailDomain("mail@cached.ru", ["selector1"], dns);
  assert.equal(dns.calls.length, before, "второй вызов не идёт в DNS");
  assert.equal(cached.verified, true, "в кэше — тот же результат");
});
