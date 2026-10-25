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

test("a system package manager is refused with the honest reason and an alternative", () => {
  for (const command of ["apt-get install -y ffmpeg", "sudo apt update", "apk add libpq", "dnf install git"]) {
    const refusal = containerCommandRefusal(command);
    assert.ok(refusal, command + " должен быть отклонён");
    assert.match(refusal.stderr, /Системные пакеты/);
    assert.match(refusal.stderr, /pip\.install/);
    assert.match(refusal.stderr, /Dockerfile/);
  }
});

test("an arbitrary git clone is refused: repositories are connected through the panel", () => {
  for (const command of ["git clone https://github.com/other/repo", "git -C . clone https://example.com/x.git"]) {
    const refusal = containerCommandRefusal(command);
    assert.ok(refusal, command + " должен быть отклонён");
    assert.match(refusal.stderr, /подключите репозиторий через панель/i);
  }
  // Обычный git-статус и уже подключённый репозиторий не задеты.
  assert.equal(containerCommandRefusal("git status"), null);
  assert.equal(containerCommandRefusal("git pull --ff-only"), null);
});

test("an ordinary project command is not refused", () => {
  assert.equal(containerCommandRefusal("npm run build"), null);
  assert.equal(containerCommandRefusal("node -e \"console.log(1)\""), null);
  // Слово «докер» в аргументе не делает команду контейнерной.
  assert.equal(containerCommandRefusal("cat Dockerfile"), null);
});
