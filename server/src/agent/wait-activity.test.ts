import test from "node:test";
import assert from "node:assert/strict";
import {
  PLATFORM_BUSY_CODE,
  PLATFORM_PAUSED_MESSAGE,
  PLATFORM_PAUSED_REMINDER,
  WAIT_ACTIVITIES,
  startWaitActivity,
  waitActivityAt,
} from "./wait-activity.js";

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("состояния подготовки идут по кругу и не содержат ни позиции, ни слова «очередь»", () => {
  assert.equal(waitActivityAt(0), WAIT_ACTIVITIES[0]);
  assert.equal(waitActivityAt(WAIT_ACTIVITIES.length), WAIT_ACTIVITIES[0], "после последней строки снова первая");
  assert.equal(waitActivityAt(WAIT_ACTIVITIES.length + 2), WAIT_ACTIVITIES[2]);
  assert.equal(waitActivityAt(-1), WAIT_ACTIVITIES[WAIT_ACTIVITIES.length - 1], "отрицательный тик не ломает круг");

  for (const text of WAIT_ACTIVITIES) {
    assert.doesNotMatch(text, /очеред|впереди|ожида/i, "пользователь не должен узнать про очередь");
  }
});

test("перегрузка сообщается как пауза: срок, автоматическое продолжение, не ошибка", () => {
  assert.equal(PLATFORM_BUSY_CODE, "PLATFORM_BUSY");
  assert.match(PLATFORM_PAUSED_MESSAGE, /перегружена/);
  assert.match(PLATFORM_PAUSED_MESSAGE, /около 2 минут/);
  assert.match(PLATFORM_PAUSED_MESSAGE, /продолжится автоматически/);
  assert.match(PLATFORM_PAUSED_MESSAGE, /пауза, а не ошибка/);
  assert.match(PLATFORM_PAUSED_MESSAGE, /сохранён/);
  assert.doesNotMatch(PLATFORM_PAUSED_MESSAGE, /очеред|попробуйте позже/i);

  assert.match(PLATFORM_PAUSED_REMINDER, /всё ещё перегружена/);
  assert.match(PLATFORM_PAUSED_REMINDER, /продолжится автоматически/);
  assert.doesNotMatch(PLATFORM_PAUSED_REMINDER, /ошибк/i);
});

test("первое состояние уходит сразу, а остановка прекращает поток", async () => {
  const sent: string[] = [];
  const stop = startWaitActivity(event => sent.push(event.activity), 250);
  assert.equal(sent.length, 1, "панель не должна ждать первого тика таймера");
  assert.equal(sent[0], WAIT_ACTIVITIES[0]);

  await tick(350);
  assert.equal(sent.length, 2, "таймер сменяет состояние");
  stop();

  const afterStop = sent.length;
  await tick(400);
  assert.equal(sent.length, afterStop, "после остановки новых состояний нет");
});
