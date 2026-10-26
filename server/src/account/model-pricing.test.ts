import test from "node:test";
import assert from "node:assert/strict";
import {
  costForTokens,
  modelPriceFor,
  parseModelPrices,
  readInfraCostMonthly,
  readModelPriceTable,
} from "./model-pricing.js";

/** Таблица цен — чистый разбор окружения, поэтому тесты не трогают process.env. */

test("цена модели находится по точному имени, по части имени и по самому длинному ключу", () => {
  const table = readModelPriceTable({
    PLATFORM_AI_MODEL_PRICES: JSON.stringify({
      "qwen3-235b-a22b-fp8": { input: 500, output: 500 },
      "gpt-oss": { input: 100, output: 100 },
      "gpt-oss-120b": { input: 300, output: 300 },
    }),
    PLATFORM_AI_PRICE_CURRENCY: "rub",
  });

  assert.equal(table.source, "model-prices");
  assert.equal(table.configured, true);
  assert.equal(table.currency, "RUB");

  // Модель платформы в журнале записана полным URI: цена привязана к части имени.
  assert.equal(modelPriceFor("gpt://b1g/qwen3-235b-a22b-fp8/latest", table)?.price.input, 500);
  // `gpt-oss-120b` включает в себя `gpt-oss`; побеждает более длинный ключ, а не порядок в JSON.
  assert.equal(modelPriceFor("gpt://b1g/gpt-oss-120b/latest", table)?.price.input, 300);
  assert.equal(modelPriceFor("gpt://b1g/gpt-oss-20b/latest", table)?.price.input, 100);
  assert.equal(modelPriceFor("unknown-model", table), null);
});

test("бесплатная модель стоит ноль, пока для неё явно не задана цена", () => {
  const free = readModelPriceTable({ PLATFORM_AI_FREE_MODEL: "agnes-2.5-flash" });
  assert.equal(modelPriceFor("free-model", free)?.price.input, 0);
  assert.equal(modelPriceFor("free-model", free)?.rule.source, "free-model");
  assert.equal(modelPriceFor("agnes-2.5-flash", free)?.price.output, 0);

  // Бесплатное имя внутри названия платной модели не делает её бесплатной.
  const substring = readModelPriceTable({ PLATFORM_AI_FREE_MODEL: "qwen" });
  assert.equal(modelPriceFor("qwen3-235b-a22b-fp8", substring), null);

  const priced = readModelPriceTable({
    PLATFORM_AI_MODEL_PRICES: JSON.stringify({ "free-model": { input: 1, output: 2 } }),
  });
  assert.equal(modelPriceFor("free-model", priced)?.price.input, 1);
  assert.equal(modelPriceFor("free-model", priced)?.rule.source, "model-prices");
});

test("без таблицы работает прежняя общая ставка за миллион токенов", () => {
  const table = readModelPriceTable({
    PLATFORM_AI_PRICE_INPUT_PER_MILLION: "1",
    PLATFORM_AI_PRICE_OUTPUT_PER_MILLION: "2",
    PLATFORM_AI_PRICE_CURRENCY: "RUB",
  });
  assert.equal(table.source, "single-price");
  assert.equal(table.configured, true);
  const resolved = modelPriceFor("any-model", table);
  assert.deepEqual(resolved?.price, { input: 1, output: 2 });
  assert.equal(costForTokens(1_000_000, 500_000, resolved!.price), 2);
});

test("без цен стоимость не выдумывается, а бесплатная модель остаётся нулевой", () => {
  const table = readModelPriceTable({});
  assert.equal(table.source, "none");
  assert.equal(table.configured, false);
  assert.equal(modelPriceFor("paid-model", table), null);
  assert.equal(modelPriceFor("free-model", table)?.price.input, 0);
});

test("сломанный JSON не роняет статистику и виден как число некорректных записей", () => {
  assert.equal(parseModelPrices("{").invalid, 1);
  const table = readModelPriceTable({
    PLATFORM_AI_MODEL_PRICES: JSON.stringify({
      "good-model": { input: 1, output: 2 },
      "bad-model": { input: 1 },
      "number-model": 3,
    }),
  });
  assert.equal(table.invalidRules, 1);
  assert.equal(modelPriceFor("good-model", table)?.price.input, 1);
  assert.equal(modelPriceFor("number-model", table)?.price.input, 3);
});

test("постоянные расходы в месяц читаются из одного числа и не мешают нулю", () => {
  assert.deepEqual(readInfraCostMonthly({ PLATFORM_INFRA_COST_PER_MONTH: "1500" }), { monthly: 1500, configured: true });
  // Запятая как десятичный разделитель — обычная опечатка при вводе вручную.
  assert.deepEqual(readInfraCostMonthly({ PLATFORM_INFRA_COST_PER_MONTH: "1500,50" }), { monthly: 1500.5, configured: true });
  assert.deepEqual(readInfraCostMonthly({ PLATFORM_INFRA_COST_PER_MONTH: "0" }), { monthly: 0, configured: false });
  assert.deepEqual(readInfraCostMonthly({ PLATFORM_INFRA_COST_PER_MONTH: "abc" }), { monthly: 0, configured: false });
});
