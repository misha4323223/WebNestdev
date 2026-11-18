import test from "node:test";
import assert from "node:assert/strict";
import { FREE_PLAN, PLAN_CATALOG } from "./account.js";
import { balanceFor, creditPoolFor, customDomainLimitFor, hostingSiteLimitFor, integrationLimitFor, subscriptionFor } from "../account/plans.js";
import { assertIntegrationSlot, IntegrationLimitError } from "../account/integration-limits.js";
import { connectorAllowedForPlan } from "../account/connector-access.js";

test("paid plans carry a monthly price, more projects and no daily run cap", () => {
  assert.equal(PLAN_CATALOG.free.priceLabel, "0 ₽");
  assert.equal(PLAN_CATALOG.free.priceRub, 0);
  assert.equal(PLAN_CATALOG.pro.priceRub, 990);
  assert.equal(PLAN_CATALOG.pro.basePriceRub, 1_500);
  assert.equal(PLAN_CATALOG.pro.discountPercent, 34);
  assert.equal(PLAN_CATALOG.team.priceRub, 2_000);
  assert.equal(PLAN_CATALOG.team.basePriceRub, 2_500);
  assert.equal(PLAN_CATALOG.team.discountPercent, 20);
  assert.equal(PLAN_CATALOG.team.limits.agentCreditsPerMonth, 10_000);
  assert.ok(PLAN_CATALOG.pro.priceLabel.includes("₽"), "цена тарифа видна в интерфейсе");
  assert.equal(PLAN_CATALOG.free.limits.projects, 3);
  assert.equal(PLAN_CATALOG.pro.limits.projects, 6);
  assert.equal(PLAN_CATALOG.team.limits.projects, 9);
  assert.equal(hostingSiteLimitFor("free"), 1, "на «Старте» один сайт на аккаунт");
  assert.equal(hostingSiteLimitFor("pro"), null, "на платных тарифах сайтов не больше, чем проектов");
  assert.equal(hostingSiteLimitFor("team"), null);
  assert.equal(customDomainLimitFor("free"), 0, "свой домен на «Старте» недоступен");
  assert.ok(customDomainLimitFor("pro") > 0);
  assert.ok(customDomainLimitFor("team") > 0);
  assert.equal(PLAN_CATALOG.free.limits.imagesPerDay, 5, "на «Старте» пять изображений в день");
  assert.equal(PLAN_CATALOG.pro.limits.imagesPerDay, 20, "на «Плюсе» двадцать изображений в день");
  assert.equal(PLAN_CATALOG.team.limits.imagesPerDay, 20, "на «Премиуме» тоже двадцать изображений в день");
  assert.equal(PLAN_CATALOG.free.limits.agentRunsPerDay, 10, "на бесплатном тарифе дневной лимит остаётся");
  assert.equal(PLAN_CATALOG.pro.limits.agentRunsPerDay, null, "на платных тарифах дневного лимита запусков нет");
  assert.equal(PLAN_CATALOG.team.limits.agentRunsPerDay, null);
  assert.equal(PLAN_CATALOG.free.limits.browserChecksPerDay, null, "браузерная проверка — режим, а не квота тарифа");
  assert.equal(PLAN_CATALOG.pro.limits.browserChecksPerDay, null);
  assert.equal(PLAN_CATALOG.team.limits.browserChecksPerDay, null);
});

/** В карточках тарифов не должно остаться обещаний, которые больше не продаются. */
test("plan cards mention neither support nor browser checks", () => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    for (const feature of plan.features) {
      assert.doesNotMatch(feature, /поддержк|браузерн/i, plan.id + ": " + feature);
      if (plan.id !== "free") assert.doesNotMatch(feature, /без дневного лимита/i, plan.id + ": " + feature);
    }
    for (const detail of plan.details) {
      assert.doesNotMatch(detail, /поддержк|браузерн/i, plan.id + ": " + detail);
    }
  }
});

/** 500 MiB, not 500 000 000 bytes: the billing formatter divides by 1024 and must print «500 МБ». */
test("the free plan gives 500 MB of account storage", () => {
  assert.equal(PLAN_CATALOG.free.limits.storageBytes, 500 * 1024 * 1024);
  assert.equal(PLAN_CATALOG.pro.limits.storageBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(PLAN_CATALOG.team.limits.storageBytes, 10 * 1024 * 1024 * 1024);
  assert.ok(PLAN_CATALOG.free.features.includes("500 МБ хранилища"));
  assert.ok(PLAN_CATALOG.free.details.some(detail => detail.includes("на все проекты")), "квота подписана как общая на аккаунт");
});

/** Nothing user-visible may offer a demo plan again: the picker is a choice, not an entitlement. */
test("the plan catalog promises no demo tariff", () => {
  assert.ok(!JSON.stringify(PLAN_CATALOG).toLowerCase().includes("демо"), "the plan catalog still mentions a demo");
  assert.equal(FREE_PLAN, "free");
});

/**
 * Биллинг показывает подписку и баланс отдельными полями: с подключением оплаты меняется только
 * их содержимое, а экран остаётся тем же. Пока оплаты нет, баланс нулевой и это честно подписано.
 */
test("the billing account reports an active free plan and an empty balance until a payment exists", () => {
  const subscription = subscriptionFor("free", "2026-01-02T03:04:05.000Z");
  assert.equal(subscription.planName, PLAN_CATALOG.free.name);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.startedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(subscription.renewsAt, null);
  assert.equal(subscription.paymentConnected, false);
  assert.equal(subscription.autoRenew, false);
  assert.equal(subscription.amountRub, 0);
  assert.deepEqual(balanceFor(), { amount: 0, currency: "RUB", paymentsConnected: false });
});

/**
 * Кредиты — то, что человек покупает на платном тарифе: бюджет растёт вместе с ценой, а на
 * бесплатном его нет вовсе (там работает дневной лимит запусков). Это проверяется отдельно,
 * потому что ноль в каталоге означает «кредитов нет», а не «бюджет нулевой».
 */
test("the monthly credit pool is a paid-plan benefit and grows with the plan", () => {
  assert.equal(creditPoolFor("free"), 0, "бесплатный тариф живёт дневным лимитом запусков");
  assert.ok(creditPoolFor("pro") > 0 && creditPoolFor("team") > creditPoolFor("pro"));
  assert.ok(PLAN_CATALOG.pro.features.some(feature => feature.includes("кредитов")));
  assert.equal(PLAN_CATALOG.pro.limits.functionsPerSite, 5);
  assert.equal(PLAN_CATALOG.free.limits.functionsPerSite, 0);
  assert.equal(PLAN_CATALOG.team.limits.functionsPerSite, 25);
  assert.ok(PLAN_CATALOG.team.details.some(detail => detail.includes("кредитов")));
  // Бюджет — не бесконечность и не «безлимит»: в описании сказано, по какому факту он считается.
  assert.ok(PLAN_CATALOG.pro.details.some(detail => detail.includes("фактический расход")));
});

/**
 * Интеграции на бесплатном тарифе ограничены по числу, на платных — нет. Уже подключённое
 * остаётся рабочим при смене тарифа: `replacing` и `used` внутри лимита проходят всегда.
 */
test("integration slots are a free-plan limit and never disconnect what already works", () => {
  assert.equal(integrationLimitFor("free", "cloud"), 1, "на «Старте» одно облако");
  assert.equal(integrationLimitFor("free", "domains"), 1, "на «Старте» один регистратор");
  assert.equal(integrationLimitFor("free", "services"), 3);
  assert.equal(integrationLimitFor("pro", "cloud"), null);
  assert.throws(
    () => assertIntegrationSlot({ plan: "free", kind: "cloud", used: 1, replacing: false }),
    (error: unknown) => error instanceof IntegrationLimitError && error.statusCode === 403 && error.message.includes("«Старт»"),
  );
  assert.doesNotThrow(() => assertIntegrationSlot({ plan: "free", kind: "cloud", used: 1, replacing: true }));
  assert.throws(
    () => assertIntegrationSlot({ plan: "free", kind: "services", used: 3, replacing: false }),
    (error: unknown) => error instanceof IntegrationLimitError && error.statusCode === 403,
  );
  assert.doesNotThrow(() => assertIntegrationSlot({ plan: "pro", kind: "cloud", used: 9, replacing: false }));
});

test("the free plan keeps clouds and domain registrars, but only S3 among key services", () => {
  assert.equal(connectorAllowedForPlan("free", "cloud"), true);
  assert.equal(connectorAllowedForPlan("free", "domain"), true);
  assert.equal(connectorAllowedForPlan("free", "yandex"), true);
  assert.equal(connectorAllowedForPlan("free", "service", "storage"), true);
  assert.equal(connectorAllowedForPlan("free", "service", "email"), false);
  assert.equal(connectorAllowedForPlan("pro", "service", "email"), true);
});

test("every plan ships a tagline, an audience and detailed highlights for the subscription page", () => {
  for (const plan of Object.values(PLAN_CATALOG)) {
    assert.ok(plan.tagline.length > 0, plan.id + " tagline");
    assert.ok(plan.audience.length > 0, plan.id + " audience");
    assert.ok(plan.details.length >= 3, plan.id + " details");
    assert.ok(plan.details.every(detail => detail.length > 0), plan.id + " detail text");
  }
  assert.equal(Object.values(PLAN_CATALOG).filter(plan => plan.recommended).length, 1);
});
