import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDomain,
  classifyRdapResponse,
  classifyRdapStatus,
  normalizeDomain,
  rdapUrl,
  usesWhois,
} from "./rdap.js";
import { classifyWhois } from "./whois.js";

const rdap = (status: number, body = "") =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

const noServiceBody = JSON.stringify({
  rdapConformance: ["rdap_level_0"],
  lang: "en",
  errorCode: 404,
  title: "No RDAP service is available for this resource",
});

test("domain input is normalized to ascii and stripped of a URL around it", () => {
  assert.equal(normalizeDomain("Example.RU"), "example.ru");
  assert.equal(normalizeDomain("https://www.example.ru/path?q=1"), "example.ru");
  assert.equal(normalizeDomain("  example.ru. "), "example.ru");
  assert.equal(normalizeDomain("example.ru:8080"), "example.ru");
  assert.equal(normalizeDomain("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  assert.throws(() => normalizeDomain(""), /Пустое/);
  assert.throws(() => normalizeDomain("localhost"), /зоной/);
  assert.throws(() => normalizeDomain("exa mple.ru"), /Некорректное/);
});

test("russian zones go through WHOIS because they have no RDAP", () => {
  assert.equal(usesWhois("example.ru"), true);
  assert.equal(usesWhois("example.su"), true);
  assert.equal(usesWhois("xn--e1afmkfd.xn--p1ai"), true);
  assert.equal(usesWhois("example.com"), false);
  assert.equal(rdapUrl("example.com"), "https://rdap.org/domain/example.com");
});

test("only 404 means available and only 2xx means taken", () => {
  assert.equal(classifyRdapStatus(200), "taken");
  assert.equal(classifyRdapStatus(404), "available");
  assert.equal(classifyRdapStatus(429), "unknown");
  assert.equal(classifyRdapStatus(500), "unknown");
});

test("a zone without RDAP is not reported as a free domain", () => {
  assert.equal(classifyRdapResponse(404, noServiceBody), "unknown");
  assert.equal(classifyRdapResponse(404, ""), "available");
  assert.equal(classifyRdapResponse(200, "{}"), "taken");
});

test("whois answers are read strictly", () => {
  assert.equal(classifyWhois("domain:        YANDEX.RU\nnserver: ns1.yandex.ru."), "taken");
  assert.equal(classifyWhois("% TCI Whois Service\n\nNo entries found for the selected source(s).\n"), "available");
  assert.equal(classifyWhois(""), "unknown");
  assert.equal(classifyWhois("Too many requests, try later"), "unknown");
});

test("russian domains are checked through the injected whois", async () => {
  const taken = await checkDomain("https://яндекс.рф", {
    whois: async () => "% TCI\n\ndomain: XN--D1ACUFJ.XN--P1AI\n",
  });
  assert.deepEqual(taken, { domain: "xn--d1acpjx3f.xn--p1ai", status: "taken", source: "whois" });

  const free = await checkDomain("свободный-домен123456.ru", {
    whois: async () => "% TCI\n\nNo entries found for the selected source(s).\n",
  });
  assert.equal(free.status, "available");

  const down = await checkDomain("example.ru", {
    whois: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(down.status, "unknown");
  assert.match(down.detail ?? "", /ECONNREFUSED/);
});

test("other zones are checked through RDAP and never throw", async () => {
  assert.equal((await checkDomain("example.com", { fetch: rdap(404) })).status, "available");
  assert.equal((await checkDomain("example.com", { fetch: rdap(200, "{}") })).status, "taken");

  const noService = await checkDomain("example.de", { fetch: rdap(404, noServiceBody) });
  assert.equal(noService.status, "unknown");
  assert.match(noService.detail ?? "", /RDAP/);

  const limited = await checkDomain("example.com", { fetch: rdap(429) });
  assert.equal(limited.status, "unknown");
  assert.match(limited.detail ?? "", /429/);

  const offline = await checkDomain("example.com", {
    fetch: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  assert.equal(offline.status, "unknown");
  assert.match(offline.detail ?? "", /offline/);
});
