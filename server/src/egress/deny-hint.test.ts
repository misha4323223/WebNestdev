import test from "node:test";
import assert from "node:assert/strict";
import { deniedEgressHost, egressDenyHint, isEgressDeny } from "./deny-hint.js";

/**
 * Подсказка про фильтр — то, что отделяет «домен не разрешён» от «ошибка установки». Ошибка в
 * распознавании либо оставит агента без причины, либо научит его лечить настоящую ошибку проекта
 * настройками сети, поэтому проверяются обе стороны.
 */

test("отказ прокси из describeEgressDeny распознаётся", () => {
  assert.equal(isEgressDeny("403 домен не входит в список разрешённых: registry.npmjs.org"), true);
  assert.equal(isEgressDeny("адреса метаданных облака запрещены: metadata.google.internal"), true);
  assert.equal(isEgressDeny("приватные адреса и внутренняя сеть платформы запрещены: db.internal"), true);
  assert.equal(isEgressDeny("разрешены только порты 80 и 443: example.com:5432"), true);
});

test("имя домена вытаскивается для конкретной подсказки", () => {
  assert.equal(deniedEgressHost("домен не входит в список разрешённых: API.Example.COM."), "api.example.com");
  // У отказа по порту домен приходит вместе с портом: это и есть цель, которую не пустили.
  assert.equal(deniedEgressHost("разрешены только порты 80 и 443: example.com:5432"), "example.com:5432");
  assert.equal(deniedEgressHost("ошибка без домена"), null);
});

test("подсказка называет фильтр и не отправляет в сеть песочницы", () => {
  const hint = egressDenyHint("403 домен не входит в список разрешённых: registry.example.com");
  assert.ok(hint);
  assert.match(hint, /registry\.example\.com/);
  assert.match(hint, /EGRESS_MODE=allowlist/);
  assert.match(hint, /не отсутствие сети/);
  assert.match(hint, /net\.request/);
});

test("обычная ошибка проекта подсказку не получает", () => {
  // Иначе агент лечил бы ERESOLVE или синтаксис настройками исходящей сети.
  for (const text of [
    "npm ERR! code ERESOLVE\nnpm ERR! peer dep conflict",
    "Module not found: Can't resolve './App'",
    "python3: not found",
    "ERROR: No matching distribution found for nonexistent-package",
  ]) {
    assert.equal(egressDenyHint(text), undefined, text);
  }
});
