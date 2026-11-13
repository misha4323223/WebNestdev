import test from "node:test";
import assert from "node:assert/strict";
import { checkCaa, checkTraffic, checkTxt, type DnsResolver } from "./domain-dns.js";

function errorWithCode(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function fake(overrides: Partial<DnsResolver>): DnsResolver {
  return {
    resolveTxt: async () => { throw errorWithCode("ENODATA"); },
    resolve4: async () => { throw errorWithCode("ENODATA"); },
    resolveCname: async () => { throw errorWithCode("ENODATA"); },
    resolveCaa: async () => { throw errorWithCode("ENODATA"); },
    ...overrides,
  };
}

test("TXT-проверка склеивает чанки и сравнивает с токеном", async () => {
  const resolver = fake({ resolveTxt: async () => [["nestdev-verify=", "abc"]] });
  assert.equal((await checkTxt("_nestdev-verify.example.ru", "abc", resolver)).allowed, true);
  assert.equal((await checkTxt("_nestdev-verify.example.ru", "wrong", resolver)).allowed, false);
});

test("TXT-проверка различает отсутствие и ошибку резолвера", async () => {
  assert.equal((await checkTxt("_nestdev-verify.example.ru", "abc", fake({}))).allowed, false);
  assert.match((await checkTxt("_nestdev-verify.example.ru", "abc", fake({}))).reason, /не найдена/);
  assert.match(
    (await checkTxt("_nestdev-verify.example.ru", "abc", fake({ resolveTxt: async () => { throw errorWithCode("ESERVFAIL"); } }))).reason,
    /не найдена|недоступен/,
  );
});

test("трафик принимает CNAME на наш target и A на IP", async () => {
  const cname = fake({ resolveCname: async () => ["custom.nestdev.ru."] });
  assert.equal((await checkTraffic("www.example.ru", "custom.nestdev.ru", "178.236.27.102", cname)).allowed, true);

  const a = fake({ resolve4: async () => ["178.236.27.102"] });
  assert.equal((await checkTraffic("example.ru", "custom.nestdev.ru", "178.236.27.102", a)).allowed, true);
});

test("трафик отклоняет чужой CNAME и отсутствие записей", async () => {
  const foreign = fake({ resolveCname: async () => ["other.example.net."] });
  assert.equal((await checkTraffic("www.example.ru", "custom.nestdev.ru", "178.236.27.102", foreign)).allowed, false);

  const missing = fake({});
  assert.equal((await checkTraffic("example.ru", "custom.nestdev.ru", "178.236.27.102", missing)).allowed, false);
});

test("CAA разрешает Let's Encrypt, отсутствие CAA и iodef-only", async () => {
  assert.equal((await checkCaa("example.ru", fake({ resolveCaa: async () => [] }))).allowed, true);
  assert.equal((await checkCaa("example.ru", fake({ resolveCaa: async () => [{ critical: 0, iodef: "mailto:a@example.ru" }] }))).allowed, true);
  assert.equal((await checkCaa("example.ru", fake({ resolveCaa: async () => [{ critical: 0, issue: "letsencrypt.org" }] }))).allowed, true);
  // issuewild ограничивает только wildcard, а мы выпускаем сертификат на конкретный hostname.
  assert.equal((await checkCaa("example.ru", fake({ resolveCaa: async () => [{ critical: 0, issuewild: "digicert.com" }] }))).allowed, true);
});

test("CAA на apex блокирует www, даже если у www записи нет", async () => {
  const resolver = fake({
    resolveCaa: async name => name === "example.ru"
      ? [{ critical: 0, issue: "digicert.com" }]
      : [],
  });
  const result = await checkCaa("www.example.ru", resolver, "example.ru");
  assert.equal(result.allowed, false);
  assert.match(result.reason, /CAA/);
});

test("CAA промежуточной зоны тоже учитывается", async () => {
  const resolver = fake({
    resolveCaa: async name => name === "shop.example.ru"
      ? [{ critical: 0, issue: "digicert.com" }]
      : [],
  });
  const result = await checkCaa("a.shop.example.ru", resolver, "example.ru");
  assert.equal(result.allowed, false);
});
