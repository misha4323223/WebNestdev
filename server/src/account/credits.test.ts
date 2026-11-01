import test from "node:test";
import assert from "node:assert/strict";
import {
  BASE_CREDIT_RATES,
  creditMultiplier,
  creditRatesProblem,
  creditsForUsage,
  defaultCreditRatesFor,
  mainCreditRates,
  normalizeCreditRates,
} from "./credits.js";

test("кредиты нормализуют разную цену моделей: одинаковый бюджет даёт разный объём", () => {
  const base = creditsForUsage(BASE_CREDIT_RATES, 45_000_000, 5_000_000);
  const max = creditsForUsage(defaultCreditRatesFor("max"), 9_000_000, 1_000_000);
  const mini = creditsForUsage(defaultCreditRatesFor("mini"), 90_000_000, 10_000_000);

  assert.equal(base, 4_800);
  assert.equal(max, 4_800);
  assert.equal(mini, 4_800);
  assert.equal(creditMultiplier(defaultCreditRatesFor("max")), 5);
  assert.equal(creditMultiplier(defaultCreditRatesFor("mini")), 0.5);
});

test("минимальное списание не даёт короткой задаче стоить ноль", () => {
  assert.equal(creditsForUsage({ inputPerMillion: 50, outputPerMillion: 510, minimumPerRun: 3 }, 10, 5), 3);
  assert.equal(creditsForUsage({ inputPerMillion: 0, outputPerMillion: 0, minimumPerRun: 0 }, 0, 0), 0);
});

test("частичное обновление ставок сохраняет остальные поля", () => {
  const merged = normalizeCreditRates(
    { outputPerMillion: 3_000 },
    { inputPerMillion: 250, outputPerMillion: 2_550, minimumPerRun: 2 },
  );
  assert.deepEqual(merged, { inputPerMillion: 250, outputPerMillion: 3_000, minimumPerRun: 2 });
  assert.ok(creditRatesProblem({ inputPerMillion: 0, outputPerMillion: 0, minimumPerRun: 1 }));
  assert.equal(creditRatesProblem({ inputPerMillion: 1, outputPerMillion: 1, minimumPerRun: 1 }), null);
});

test("ставки основной модели читаются из окружения и не обнуляются пустыми переменными", () => {
  assert.deepEqual(mainCreditRates({}), BASE_CREDIT_RATES);
  assert.deepEqual(mainCreditRates({
    PLATFORM_AI_CREDITS_INPUT_PER_MILLION: "60",
    PLATFORM_AI_CREDITS_OUTPUT_PER_MILLION: "600",
    PLATFORM_AI_CREDITS_MINIMUM_PER_RUN: "2",
  }), { inputPerMillion: 60, outputPerMillion: 600, minimumPerRun: 2 });
});
