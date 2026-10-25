import test from "node:test";
import assert from "node:assert/strict";
import { deployCheckSummary, normalizeSiteUrl, redirectDirection, type TlsInfo } from "./deploy-check.js";

const goodTls: TlsInfo = {
  ok: true,
  trusted: true,
  hostnameValid: true,
  issuer: "Let's Encrypt",
  subject: "example.ru",
  validFrom: "2026-06-12T00:00:00.000Z",
  validTo: "2027-03-12T00:00:00.000Z",
  daysLeft: 100,
  error: null,
};

test("домен без схемы проверяется по HTTPS", () => {
  assert.equal(normalizeSiteUrl("example.ru").href, "https://example.ru/");
  assert.equal(normalizeSiteUrl("example.ru/about").href, "https://example.ru/about");
});

test("http переводится в https, а порт 80 не остаётся в адресе", () => {
  assert.equal(normalizeSiteUrl("http://example.ru/").href, "https://example.ru/");
  assert.equal(normalizeSiteUrl("http://example.ru:80/about").href, "https://example.ru/about");
});

test("чужая схема и пустой адрес отвергаются", () => {
  assert.throws(() => normalizeSiteUrl("ftp://example.ru"), /только http и https/);
  assert.throws(() => normalizeSiteUrl(""), /Укажите адрес/);
});

test("сводка называет сертификат, срок и редирект www", () => {
  const summary = deployCheckSummary({
    status: 200,
    secure: true,
    tls: goodTls,
    www: { url: "https://www.example.ru/", status: 200, finalUrl: "https://example.ru/", redirectsTo: "apex" },
  });
  assert.match(summary, /HTTPS отвечает 200/);
  assert.match(summary, /Let's Encrypt/);
  assert.match(summary, /www → апекс/);
});

test("направление редиректа www/апекс не путается", () => {
  // Вход — апекс, второй адрес www остался собой: редиректа нет.
  assert.equal(redirectDirection("example.ru", "www.example.ru", "www.example.ru"), null);
  // Вход — апекс, www перешёл на апекс.
  assert.equal(redirectDirection("example.ru", "www.example.ru", "example.ru"), "apex");
  // Вход — www, апекс перешёл на www.
  assert.equal(redirectDirection("www.example.ru", "example.ru", "www.example.ru"), "www");
  // Второй адрес ушёл на третий хост.
  assert.equal(redirectDirection("example.ru", "www.example.ru", "cdn.example.ru"), "other");
});

test("недоверенный сертификат и редирект на http не выглядят успехом", () => {
  const summary = deployCheckSummary({
    status: 200,
    secure: false,
    tls: { ...goodTls, ok: false, trusted: false, error: "самоподписанный сертификат" },
    www: { url: "https://www.example.ru/", error: "имя не разрешилось" },
  });
  assert.match(summary, /редирект на http/);
  assert.match(summary, /самоподписанный сертификат/);
  assert.match(summary, /www: имя не разрешилось/);
});
