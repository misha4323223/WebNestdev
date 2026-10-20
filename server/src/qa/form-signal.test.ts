import test from "node:test";
import assert from "node:assert/strict";
import { analyzeForms, FORM_SIMULATION_HINT } from "./form-signal.js";

/**
 * Портфолио с формой «Спасибо, заявка отправлена» и setTimeout вместо запроса — ровно тот случай,
 * из-за которого пользователь узнаёт, что заявок нет, только от клиента.
 */
test("форма с имитацией отправки помечается как имитация", () => {
  const signal = analyzeForms([
    { path: "index.html", text: `<form id="contact"><input name="phone"><button type="submit">Отправить</button></form>` },
    { path: "app.js", text: `form.addEventListener("submit", e => { e.preventDefault(); setTimeout(() => { status.textContent = "Спасибо, заявка отправлена"; }, 400); });` },
  ]);
  assert.equal(signal.found, true);
  assert.equal(signal.simulated, true);
  // Обработчик отправки тоже называет файл: важно, где искать форму, а не только разметка.
  assert.deepEqual(signal.files, ["index.html", "app.js"]);
  assert.equal(signal.note, FORM_SIMULATION_HINT);
  assert.match(signal.note, /Интеграциях/, "подсказка ведёт туда, где подключается приёмник");
});

test("форма с fetch на подключённый сервис не считается имитацией", () => {
  const signal = analyzeForms([
    { path: "index.html", text: `<form><input name="name"><button type="submit">Отправить</button></form>` },
    { path: "app.js", text: `await fetch("https://example.retailcrm.ru/api/v5/orders/create", { method: "POST", body: data });` },
  ]);
  assert.equal(signal.found, true);
  assert.equal(signal.simulated, false);
  assert.deepEqual(signal.networkCalls, ["app.js"]);
});

test("форма с action на почтовый шлюз не считается имитацией", () => {
  const signal = analyzeForms([
    { path: "index.html", text: `<form action="https://formspree.io/f/abc123" method="post"><input name="email"></form>` },
  ]);
  assert.equal(signal.simulated, false);
  assert.deepEqual(signal.submitsTo, ["index.html: https://formspree.io/f/abc123"]);
});

test("пустой action и заглушка # — всё ещё имитация", () => {
  const signal = analyzeForms([{ path: "index.html", text: `<form action="#"><button type="submit">Отправить</button></form>` }]);
  assert.equal(signal.simulated, true);
});

test("лендинг без форм ничего не заявляет", () => {
  const signal = analyzeForms([{ path: "index.html", text: `<h1>Портфолио</h1><a href="mailto:me@example.com">Написать</a>` }]);
  assert.equal(signal.found, false);
  assert.equal(signal.simulated, false);
  assert.match(signal.note, /Форм в проекте нет/);
});
