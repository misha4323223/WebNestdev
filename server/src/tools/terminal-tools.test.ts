import assert from "node:assert/strict";
import test from "node:test";
import { containerCommandRefusal } from "./terminal-tools.js";

/**
 * Агент в песочнице пробовал `docker build` и получал «команда не найдена», после чего писал
 * пользователю, что проверить проект нечем. Отказ должен объяснять причину и что делать вместо этого.
 */
test("a container command is refused with an explanation instead of a missing binary", () => {
  const refusal = containerCommandRefusal("docker build -t app .");
  assert.ok(refusal, "docker build должен быть отклонён");
  assert.equal(refusal.ok, false);
  assert.equal(refusal.exitCode, 127);
  assert.match(refusal.stderr, /Docker в песочнице проекта недоступен/);
  assert.match(refusal.stderr, /preview\.start/);
});

test("docker-compose and a path-qualified binary are refused too", () => {
  assert.ok(containerCommandRefusal("docker-compose up -d"));
  assert.ok(containerCommandRefusal("/usr/bin/docker ps"));
});

test("an ordinary project command is not refused", () => {
  assert.equal(containerCommandRefusal("npm run build"), null);
  assert.equal(containerCommandRefusal("node -e \"console.log(1)\""), null);
  // Слово «докер» в аргументе не делает команду контейнерной.
  assert.equal(containerCommandRefusal("cat Dockerfile"), null);
});
