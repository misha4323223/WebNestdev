import assert from "node:assert/strict";
import test from "node:test";
import { commitSubject } from "./commit-subject.js";

/**
 * Тема автоматического коммита.
 *
 * Пользователь видел в истории проекта свой же запрос из чата целиком — с приветствием,
 * вводными и кодом. Тема должна описывать сделанное: короткие пункты плана, а без плана —
 * одно первое предложение запроса, не длиннее обычной темы коммита.
 */

const item = (title: string, status: "pending" | "in_progress" | "done") => ({ title, status });

test("тема берётся из выполненных пунктов плана, а не из запроса", () => {
  const subject = commitSubject({
    task: "Привет! Посмотри проект и добавь тёмную тему, ещё нужно поправить шапку и подвал, и...",
    plan: {
      items: [item("Добавить тёмную тему", "done"), item("Поправить шапку", "done"), item("Проверить сборку", "pending")],
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(subject, "Добавить тёмную тему; Поправить шапку");
});

test("служебные шаги плана не становятся темой коммита", () => {
  const subject = commitSubject({
    task: "добавь тёмную тему",
    plan: {
      items: [
        item("Изучить текущие стили", "done"),
        item("Добавить тёмную тему", "done"),
        item("Проверить сборку и предпросмотр", "done"),
      ],
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(subject, "Добавить тёмную тему");
});

test("без плана остаётся первое предложение запроса, обрезанное по словам", () => {
  const task = "Здравствуйте! Добавь на главную страницу блок с тарифами, кнопкой оплаты и подробным описанием каждого плана, а также ссылку на условия.";
  const subject = commitSubject({ task });
  assert.ok(subject.startsWith("Добавь на главную страницу блок с тарифами"), subject);
  assert.ok(subject.length <= 72, String(subject.length));
  assert.ok(subject.endsWith("…"), subject);
  assert.ok(!subject.includes("Здравствуйте"), subject);
});

test("шапка импорта и обёртка «что сделать» не попадают в тему", () => {
  const imported = "Импортирован репозиторий GitHub: team/site (ветка main).\n\nПодготовь проект к запуску: разберись с зависимостями.";
  assert.equal(commitSubject({ task: imported }), "Подготовь проект к запуску: разберись с зависимостями.");
  assert.equal(
    commitSubject({ task: "Что сделать с проектом: переделать главную под новую айдентику" }),
    "Переделать главную под новую айдентику",
  );
});

test("план прошлого запуска не описывает эту работу", () => {
  const subject = commitSubject({
    task: "Поправь цвет кнопки",
    plan: { items: [item("Старая задача из прошлого чата", "done")], updatedAt: new Date().toISOString() },
    planFromPreviousRun: true,
  });
  assert.equal(subject, "Поправь цвет кнопки");
});

test("markdown, код и ссылки не попадают в тему", () => {
  const subject = commitSubject({
    task: "## Задача\n\nПоправь `src/App.tsx` и стили по ссылке https://example.com/design",
  });
  assert.equal(subject, "Поправь src/App.tsx и стили по ссылке");
});

test("пустая задача даёт понятный запасной вариант", () => {
  assert.equal(commitSubject({ task: "   " }), "Изменения проекта");
});

test("в тему попадают не больше двух рабочих пунктов плана", () => {
  const subject = commitSubject({
    task: "не важно",
    plan: {
      items: [
        item("Добавить тёмную тему", "done"),
        item("Обновить шапку", "done"),
        item("Переписать подвал", "done"),
      ],
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(subject, "Добавить тёмную тему; Обновить шапку");
});

test("тема всегда укладывается в 72 символа", () => {
  const plan = {
    items: [
      item("Переписать страницу тарифов с новыми карточками и переключателем периода", "done"),
      item("Обновить заголовок и подвал сайта под новую айдентику", "done"),
    ],
    updatedAt: new Date().toISOString(),
  };
  const subject = commitSubject({ task: "не важно", plan });
  assert.ok(subject.length <= 72, String(subject.length));
  assert.ok(subject.endsWith("…"), subject);
});
