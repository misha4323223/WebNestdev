import test from "node:test";
import assert from "node:assert/strict";
import { QueueAbortedError } from "../concurrency.js";

/**
 * Перегрузка — пауза, а не отказ: запуск ждёт свободное место и продолжается сам. Здесь проверяется
 * именно это, с короткими таймаутами вместо реальных пяти минут.
 */
process.env.AGENT_MAX_CONCURRENT_RUNS = "1";
process.env.AGENT_MAX_QUEUE = "1";
process.env.AGENT_QUEUE_TIMEOUT_MS = "200";
process.env.AGENT_QUEUE_RETRY_MS = "50";

const { acquireRunSlot, acquireRunSlotPatiently } = await import("./run-limiter.js");

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("очередь заполнена: запуск сообщает о паузе и продолжается сам, когда место освободилось", async () => {
  const held = await acquireRunSlot();
  let pauses = 0;
  const started = Date.now();
  const waiting = acquireRunSlotPatiently(undefined, () => { pauses++; });

  // Ждём дольше таймаута очереди: без режима паузы здесь был бы отказ.
  await tick(450);
  assert.ok(pauses >= 1, "панель узнала о паузе");
  let resolved = false;
  void waiting.then(() => { resolved = true; });
  await tick(50);
  assert.equal(resolved, false, "пока места нет, запуск не продолжается и не падает");

  held.release();
  const slot = await waiting;
  assert.ok(slot, "запуск получил место сам, без повтора пользователем");
  assert.ok(Date.now() - started >= 400);
  slot.release();
});

test("отмена во время паузы заканчивает ожидание, а не держит место", async () => {
  const held = await acquireRunSlot();
  const controller = new AbortController();
  let pauses = 0;
  const waiting = acquireRunSlotPatiently(controller.signal, () => { pauses++; });
  await tick(350);
  assert.ok(pauses >= 1);
  controller.abort();
  await assert.rejects(waiting, error => error instanceof QueueAbortedError);
  held.release();

  // После отмены место снова свободно: следующий запуск проходит сразу.
  const free = await acquireRunSlot();
  free.release();
});

test("напоминание о паузе не повторяется чаще раза в минуту", async () => {
  // Проверка на уровне функции ожидания: первый вызов — сразу, второй — только после интервала.
  const held = await acquireRunSlot();
  const seen: number[] = [];
  const waiting = acquireRunSlotPatiently(undefined, () => seen.push(Date.now()));
  await tick(600);
  assert.equal(seen.length, 1, "на несколько таймаутов очереди приходится одно сообщение");
  held.release();
  const slot = await waiting;
  slot.release();
});
