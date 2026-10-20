import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaymentUrl,
  buildReceipt,
  describeBilling,
  encodeReceipt,
  paymentSignatureBase,
  planPriceRub,
  resultSignatureBase,
  robokassaConfig,
  sameSignature,
  signValue,
  type RobokassaConfig,
} from "./robokassa.js";

const MANAGED = ["ROBOKASSA_LOGIN", "ROBOKASSA_PASSWORD_1", "ROBOKASSA_PASSWORD_2", "ROBOKASSA_HASH", "ROBOKASSA_TEST_MODE", "ROBOKASSA_RECURRING", "ROBOKASSA_RECEIPT", "ROBOKASSA_PRICE_PRO", "ROBOKASSA_PRICE_TEAM"] as const;

/** Настройки читаются из окружения, когда панель ничего не сохраняла: тест выставляет их сам. */
function withEnv<T>(values: Partial<Record<(typeof MANAGED)[number], string>>, run: () => T): T {
  const previous = new Map(MANAGED.map(name => [name, process.env[name]]));
  try {
    for (const name of MANAGED) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const config: RobokassaConfig = {
  login: "nestdev",
  password1: "pass1",
  password2: "pass2",
  hash: "md5",
  testMode: false,
  recurring: false,
  receipt: false,
  configured: true,
};

test("the payment signature signs login, amount, invoice and password #1 in that order", () => {
  assert.equal(paymentSignatureBase({ login: "nestdev", outSum: "990.00", invId: 100001, password1: "pass1" }), "nestdev:990.00:100001:pass1");
  // Receipt встаёт между номером счёта и паролем — ровно та позиция, которую требует документация.
  assert.equal(paymentSignatureBase({ login: "nestdev", outSum: "990.00", invId: 5, password1: "pass1", receipt: "%7B%7D" }), "nestdev:990.00:5:%7B%7D:pass1");
  assert.equal(resultSignatureBase("990.00", 5, "pass2"), "990.00:5:pass2");
});

test("md5 hashing matches the well-known vector", () => {
  assert.equal(signValue("test", "md5"), "098f6bcd4621d373cade4e832627b4f6");
});

test("signature comparison ignores hex case but rejects a different digest", () => {
  const signature = signValue("out:5:pass2", "md5");
  assert.equal(sameSignature(signature, signature.toUpperCase()), true);
  assert.equal(sameSignature(signature, "0".repeat(32)), false);
  assert.equal(sameSignature(signature, "not-a-hash"), false);
});

test("the payment link carries the signed amount, invoice and test flag", () => {
  const link = buildPaymentUrl({ config: { ...config, testMode: true }, plan: "pro", planName: "Про", invId: 100001, amount: 990, description: "Подписка NestDev «Про», 1 месяц", email: "user@example.com" });
  const url = new URL(link.url);
  assert.equal(url.origin + url.pathname, "https://auth.robokassa.ru/Merchant/Index.aspx");
  assert.equal(url.searchParams.get("MerchantLogin"), "nestdev");
  assert.equal(url.searchParams.get("OutSum"), "990.00");
  assert.equal(url.searchParams.get("InvId"), "100001");
  assert.equal(url.searchParams.get("IsTest"), "1");
  assert.equal(url.searchParams.get("Recurring"), null, "без услуги периодических платежей флаг не ставится");
  assert.equal(url.searchParams.get("SignatureValue"), signValue("nestdev:990.00:100001:pass1", "md5"));
});

test("the recurring flag marks the first payment of a series", () => {
  const link = buildPaymentUrl({ config: { ...config, recurring: true }, plan: "team", planName: "Команда", invId: 7, amount: 2990, description: "Подписка" });
  assert.equal(new URL(link.url).searchParams.get("Recurring"), "true");
});

test("a receipt is a service for a month with no VAT and the encoded value is signed", () => {
  const receipt = buildReceipt({ planName: "Про", amount: 990 });
  const parsed = JSON.parse(receipt) as { items: Array<Record<string, unknown>> };
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].sum, 990);
  assert.equal(parsed.items[0].quantity, 1);
  assert.equal(parsed.items[0].tax, "none");
  assert.equal(parsed.items[0].payment_object, "service");
  assert.ok(String(parsed.items[0].name).includes("Про"));

  const link = buildPaymentUrl({ config: { ...config, receipt: true }, plan: "pro", planName: "Про", invId: 9, amount: 990, description: "Подписка" });
  const encoded = encodeReceipt(receipt);
  assert.equal(new URL(link.url).searchParams.get("Receipt"), encoded);
  assert.equal(new URL(link.url).searchParams.get("SignatureValue"), signValue("nestdev:990.00:9:" + encoded + ":pass1", "md5"));
});

test("prices come from the catalog and can be changed by a key without a deploy", () => {
  withEnv({ ROBOKASSA_PRICE_PRO: "1490" }, () => {
    assert.equal(planPriceRub("pro"), 1490);
    // Пустое или мусорное значение не ломает цену: остаётся каталожная.
    assert.equal(planPriceRub("team"), 2990);
  });
  withEnv({ ROBOKASSA_PRICE_PRO: "дорого" }, () => assert.equal(planPriceRub("pro"), 990));
  assert.equal(planPriceRub("free"), 0);
});

test("payment is unavailable until the shop login and both passwords are set", () => {
  withEnv({}, () => {
    const empty = robokassaConfig();
    assert.equal(empty.configured, false);
    assert.equal(empty.hash, "md5");
    assert.match(describeBilling(empty), /не настроена/);
  });
  withEnv({ ROBOKASSA_LOGIN: "nestdev", ROBOKASSA_PASSWORD_1: "p1", ROBOKASSA_PASSWORD_2: "p2", ROBOKASSA_HASH: "sha256", ROBOKASSA_TEST_MODE: "1" }, () => {
    const configured = robokassaConfig();
    assert.equal(configured.configured, true);
    assert.equal(configured.hash, "sha256");
    assert.equal(configured.testMode, true);
    assert.match(describeBilling(configured), /sha256, тестовый режим/);
  });
  // Неизвестный алгоритм — это не подпись «наугад», а MD5 магазина по умолчанию.
  withEnv({ ROBOKASSA_LOGIN: "nestdev", ROBOKASSA_PASSWORD_1: "p1", ROBOKASSA_PASSWORD_2: "p2", ROBOKASSA_HASH: "md6" }, () => {
    assert.equal(robokassaConfig().hash, "md5");
  });
});
