import test from "node:test";
import assert from "node:assert/strict";
import { selectToolNames } from "./tool-catalog.js";
import { getToolDefinitionsFor, registerTool } from "../tool-registry.js";

test("каталог разработчика оставляет ядро и не тащит интеграции без задачи", () => {
  const names = selectToolNames({ mode: "developer", task: "поправь кнопку в существующем проекте" });
  assert.ok(names.includes("fs.read"));
  assert.ok(names.includes("fs.edit"));
  assert.ok(names.includes("agent.scout"));
  assert.ok(names.includes("net.request"), "внешний API нужен обычной задаче");
  assert.ok(names.includes("net.download"), "скачивание ассета нужен обычной задаче");
  assert.ok(names.includes("database.status"), "проверка базы нужна до кода хранения");
  assert.ok(names.includes("service.status"), "проверка интеграций нужна до просьбы о ключе");
  assert.ok(!names.includes("web.search"), "поиск выключен по умолчанию");
  assert.ok(!names.includes("browser.runtime"), "Chromium выключен по умолчанию");
  assert.ok(!names.includes("deploy.plan"), "деплой не нужен обычной правке");
  assert.ok(!names.includes("expo.build"), "Expo не нужен обычному сайту");
  assert.equal(new Set(names).size, names.length, "имена не повторяются");
});

test("переключатели и задача добавляют только нужные группы", () => {
  const web = selectToolNames({ mode: "developer", task: "найди документацию", webSearch: true });
  assert.ok(web.includes("web.search") && web.includes("web.read"));
  const browser = selectToolNames({ mode: "developer", task: "проверь клик", browserCheck: true });
  assert.ok(browser.includes("browser.runtime") && browser.includes("browser.scenario"));
  const deploy = selectToolNames({ mode: "developer", task: "задеплой сайт на Yandex Cloud" });
  assert.ok(deploy.includes("deploy.plan") && deploy.includes("cloud.request") && deploy.includes("yandex.request"));
  const mobile = selectToolNames({ mode: "developer", task: "собери мобильное приложение на Expo" });
  assert.ok(mobile.includes("expo.build") && mobile.includes("expo.setup"));
});

test("планировщик не получает схемы изменяющих инструментов", () => {
  const names = selectToolNames({ mode: "planner", task: "составь план рефакторинга" });
  assert.ok(names.includes("fs.read"));
  assert.ok(names.includes("plan.update"));
  for (const name of ["fs.write", "fs.edit", "git.commit", "preview.start", "project.check", "image.generate", "database.env", "service.env", "net.download"]) {
    assert.ok(!names.includes(name), "планировщик не должен видеть " + name);
  }
  // Задача про деплой добавляет группу, но запись секретов остаётся запрещённой и там.
  const deployPlan = selectToolNames({ mode: "planner", task: "подключи базу данных и задеплой сайт" });
  assert.ok(deployPlan.includes("database.status"));
  assert.ok(!deployPlan.includes("database.env") && !deployPlan.includes("service.env"));
});

test("getToolDefinitionsFor отдаёт только выбранные схемы", () => {
  registerTool({ name: "catalog.test", description: "тестовая схема", parameters: { type: "object" } });
  const definitions = getToolDefinitionsFor(["catalog.test"]);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.function.name, "catalog.test");
  assert.equal(getToolDefinitionsFor([]).length, 0);
});
