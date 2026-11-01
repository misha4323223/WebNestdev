import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CREDIT_SETTINGS, creditPriceRub } from "./credit-settings.js";
import { publicCreditPacks } from "./credit-packs.js";

test("цена растёт линейно от ставки за 1000 и округляется до целого рубля вверх", () => {
  assert.equal(creditPriceRub(1_000, DEFAULT_CREDIT_SETTINGS), 290);
  assert.equal(creditPriceRub(1_500, DEFAULT_CREDIT_SETTINGS), 435);
  // 1234 × 290 / 1000 = 357.86: в счёт уходит 358 ₽, а не 357 и не дробная сумма.
  assert.equal(creditPriceRub(1_234, DEFAULT_CREDIT_SETTINGS), 358);
});

test("нулевое или отрицательное количество не превращает счёт в ноль", () => {
  assert.equal(creditPriceRub(0, DEFAULT_CREDIT_SETTINGS), 1);
});

test("старые пресеты не показываются вне текущих границ и считаются по текущей ставке", () => {
  const previous = process.env.CREDIT_SETTINGS;
  process.env.CREDIT_SETTINGS = JSON.stringify({ pricePer1000Rub: 250, minCredits: 2_000, maxCredits: 10_000 });
  try {
    const packs = publicCreditPacks();
    assert.deepEqual(packs.map(pack => pack.credits), [5_000]);
    assert.equal(packs[0]?.priceRub, 1_250);
  } finally {
    if (previous === undefined) delete process.env.CREDIT_SETTINGS;
    else process.env.CREDIT_SETTINGS = previous;
  }
});
