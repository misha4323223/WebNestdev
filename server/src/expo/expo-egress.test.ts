import test from "node:test";
import assert from "node:assert/strict";
import { EXPO_EGRESS_HOSTS, expoEgressProblem, expoEgressReport } from "./expo-egress.js";

/**
 * Проверка доступа к Expo — это то, что отделяет «сборку нельзя отправить» от «платформа не пускает
 * домен». Ошибка здесь не ломает прод, но заставляет модель искать обходной путь через HTTP-инструмент,
 * которого для сборки не существует, поэтому проверяются оба ответа: пущено и закрыто.
 */

test("встроенный allowlist пускает EAS CLI к Expo", () => {
  assert.equal(expoEgressProblem({}), null);
  assert.deepEqual(expoEgressReport({}), { mode: "off", expoAllowed: true, problem: null });
});

test("off и private-only не решают по домену и не мешают сборке", () => {
  assert.equal(expoEgressProblem({ EGRESS_MODE: "private-only" }), null);
  assert.equal(expoEgressProblem({ EGRESS_MODE: "off" }), null);
});

test("allowlist без доменов Expo называет причину, а не инструмент", () => {
  const problem = expoEgressProblem({ EGRESS_MODE: "allowlist" }, ["registry.npmjs.org"]);
  assert.ok(problem);
  for (const host of EXPO_EGRESS_HOSTS) {
    assert.match(problem ?? "", new RegExp(host.replace(/\./g, "\\.")), host);
  }
  // Модели прямо сказано не искать обходной путь в net.request.
  assert.match(problem ?? "", /net\.request/);
  assert.match(problem ?? "", /EGRESS_MODE=allowlist/);
  assert.equal(expoEgressProblem({ EGRESS_MODE: "allowlist" }, ["*.expo.dev", "expo.dev"]), null);
});
