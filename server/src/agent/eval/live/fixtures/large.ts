/**
 * Fixture for the `large` eval task: a checkout module whose retry loop charges the card twice.
 * The bug spans two files (orders and payments), and the repository's own suite is the verdict.
 */
import type { EvalFixture } from "./types.js";
import { BUILD_DIST } from "./build-dist.js";

const PAYMENTS = `/**
 * Платёжный шлюз проекта. Внешний сервис принимает ключ идемпотентности: повторный запрос с тем
 * же ключом не списывает деньги второй раз.
 */
export function createPayments() {
  const charges = [];
  return {
    charges,
    async charge({ orderId, amount, idempotencyKey }) {
      if (idempotencyKey && charges.some(charge => charge.idempotencyKey === idempotencyKey)) {
        return { ok: true, reused: true };
      }
      charges.push({ orderId, amount, idempotencyKey });
      return { ok: true };
    },
  };
}
`;

const ORDERS = `import { randomUUID } from "node:crypto";

export class ConflictError extends Error {
  constructor(message = "заказ уже создан") {
    super(message);
    this.code = "conflict";
  }
}

/**
 * Оформление заказа: сначала списание, затем запись. Репозиторий может ответить конфликтом
 * (параллельный запрос успел первым), и заказ повторяется.
 */
export function createOrders({ payments, repo }) {
  return {
    async create(input) {
      const order = { id: input.id ?? randomUUID(), total: input.total, items: input.items ?? [] };
      for (let attempt = 0; attempt < 3; attempt++) {
        await payments.charge({ orderId: order.id, amount: order.total });
        try {
          return await repo.insert(order);
        } catch (error) {
          if (error && error.code === "conflict") continue;
          throw error;
        }
      }
      throw new ConflictError("не удалось создать заказ после повторов");
    },
  };
}
`;

const TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { createOrders } from "../src/orders.mjs";
import { createPayments } from "../src/payments.mjs";

function repoThatConflictsOnce() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async insert(order) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("конфликт"), { code: "conflict" });
      return order;
    },
  };
}

test("повтор после конфликта не списывает деньги второй раз", async () => {
  const payments = createPayments();
  const repo = repoThatConflictsOnce();
  const orders = createOrders({ payments, repo });

  const created = await orders.create({ total: 4200, items: ["sku-1"] });
  assert.equal(created.total, 4200);
  assert.equal(repo.calls, 2, "заказ должен быть записан после одного повтора");
  assert.equal(payments.charges.length, 1, "списание должно быть одно");
  assert.equal(payments.charges[0].idempotencyKey, created.id);
});

test("успешный заказ списывает ровно сумму заказа", async () => {
  const payments = createPayments();
  const orders = createOrders({ payments, repo: { async insert(order) { return order; } } });
  const created = await orders.create({ total: 1500 });
  assert.equal(payments.charges.length, 1);
  assert.equal(payments.charges[0].amount, 1500);
  assert.equal(payments.charges[0].orderId, created.id);
});
`;

export const LARGE_FIXTURES: Record<string, EvalFixture> = {
  "large-shop": {
    files: {
      "package.json": JSON.stringify({
        name: "eval-large-shop",
        private: true,
        version: "0.1.0",
        type: "module",
        scripts: {
          build: "node scripts/build.mjs",
          test: "node --test tests/*.test.mjs",
        },
      }, null, 2) + "\n",
      "src/orders.mjs": ORDERS,
      "src/payments.mjs": PAYMENTS,
      "scripts/build.mjs": BUILD_DIST,
      "tests/orders.test.mjs": TEST,
    },
  },
};
